'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, newKey } from '../../../lib/api';
import { crypto as cryptoFmt, kes } from '../../../lib/format';
import { useApi } from '../../../lib/useApi';
import { Badge, Dot, ErrorNote, KV, Loading, Panel, SectionTitle, SimulatedTag } from '../../../components/ui';
import { useSession } from '../../../components/SessionProvider';

interface Recipient {
  id: string;
  kind: string;
  displayName: string;
  phone: string | null;
  till: string | null;
  paybill: string | null;
  rail: string;
  verification: { verified: boolean; name: string | null; source: string };
  defaultAmountMinor: string | null;
}

interface Quote {
  quoteId: string;
  status: string;
  asset: string;
  network: string;
  rail: string;
  recipientAmountMinor: string;
  cryptoAmountMinor: string;
  networkFeeMinor: string;
  serviceFeeMinor: string;
  totalDebitMinor: string;
  fxRate: string;
  midRate: string;
  spreadBps: number;
  feeBps: number;
  expiresAt: string;
  ttlSeconds: number;
  providerSurchargeMinor: string;
  riskHint?: { level: string; label: string; reason: string } | null;
  route: {
    rail: string;
    provider: string;
    providerDisplayName: string;
    estimatedSettlementSeconds: number;
    refundable: boolean;
    instant: boolean;
    latencySeconds: number;
    considered?: Array<{ rail: string; usable: boolean; reason?: string | null }>;
  };
  liquidity: { sufficient: boolean; queuedIfInsufficient: boolean };
}

const ASSETS = ['USDT', 'USDC', 'BTC', 'ETH'];

export default function PayPage() {
  const router = useRouter();
  const { user } = useSession();
  const { data: recipientData, loading: loadingRecipients } = useApi<{ recipients: Recipient[] }>('/recipients');
  const { data: balances } = useApi<{ wallets: Array<{ asset: string; availableMinor: string }> }>('/account/balances');

  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [asset, setAsset] = useState('USDT');
  const [amount, setAmount] = useState('3200');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [confirmName, setConfirmName] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [remaining, setRemaining] = useState(0);
  const idemKey = useRef<string>(newKey('pay'));

  const recipients = recipientData?.recipients ?? [];
  const recipient = useMemo(() => recipients.find((r) => r.id === recipientId) ?? null, [recipients, recipientId]);

  const availableMinor = useMemo(() => {
    const row = balances?.wallets.find((w) => w.asset === asset);
    return row?.availableMinor ?? '0';
  }, [balances, asset]);

  const dropQuote = useCallback(() => {
    setQuote(null);
    setQuoteError(null);
    idemKey.current = newKey('pay');
  }, []);

  // Any change to what is being priced invalidates the price. We do not keep an old
  // quote around and let the customer believe it still applies.
  useEffect(() => {
    dropQuote();
  }, [recipientId, asset, amount, dropQuote]);

  const requestQuote = useCallback(async () => {
    if (!recipientId) return;
    setQuoteError(null);
    try {
      const res = await api<{ quote: Quote }>('/quotes', {
        method: 'POST',
        body: { asset: asset as never, kind: 'PHONE', recipientAmountKesMajor: Number(amount), recipientId },
      });
      setQuote(res.quote);
      idemKey.current = newKey('pay');
    } catch (e) {
      setQuote(null);
      setQuoteError(e);
    }
  }, [amount, asset, recipientId]);

  useEffect(() => {
    if (!recipientId || !Number(amount)) return;
    const t = setTimeout(() => void requestQuote(), 400);
    return () => clearTimeout(t);
  }, [recipientId, amount, requestQuote]);

  // The countdown is a countdown to *expiry*, shown so the customer knows when the
  // number stops being true. It never implies the payment is progressing.
  useEffect(() => {
    if (!quote) return;
    const tick = () => setRemaining(Math.max(0, Math.round((new Date(quote.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [quote]);

  const expired = Boolean(quote && remaining <= 0);
  const insufficient = quote ? BigInt(quote.totalDebitMinor) > BigInt(availableMinor) : false;
  const needsNameConfirm = Boolean(quote?.riskHint && quote.riskHint.level !== 'LOW');

  const pay = async () => {
    if (!quote || expired) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api<{ payment: { id: string } }>('/payments', {
        method: 'POST',
        body: { quoteId: quote.quoteId, recipientId, strongConfirmation: confirmName },
        headers: { 'idempotency-key': idemKey.current },
      });
      router.push(`/app/processing/${res.payment.id}`);
    } catch (e) {
      setSubmitError(e);
      // A consumed or expired quote cannot be paid again; ask for a fresh price
      // instead of letting the customer re-submit into the same error.
      if (e instanceof ApiError && ['QUOTE_EXPIRED', 'QUOTE_STALE_RATE', 'CONFLICT'].includes(e.code)) {
        dropQuote();
        setTimeout(() => void requestQuote(), 250);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_.92fr]">
      <div className="space-y-4">
        <div>
          <div className="label">Step 1 · who</div>
          <h1 className="mt-1 font-display text-[26px] tracking-tight text-ink">Pay someone</h1>
          <p className="mt-1.5 max-w-[58ch] text-[13px] leading-relaxed text-ink-dim">
            They receive Kenyan shillings on the rail they already use. You pay in crypto at a price locked for {quote?.ttlSeconds ?? 90} seconds.
          </p>
        </div>

        <Panel>
          <SectionTitle
            hint={
              <Link href="/app/recipients" className="text-[11px] text-mint underline decoration-dotted">
                manage recipients
              </Link>
            }
          >
            Saved recipients
          </SectionTitle>
          {loadingRecipients ? <Loading label="Loading recipients" /> : null}
          {!loadingRecipients && !recipients.length ? (
            <div className="rounded-lg border border-dashed border-hair px-4 py-6 text-center text-[12.5px] text-ink-dim">
              No saved recipients yet. Add one on the{' '}
              <Link href="/app/recipients" className="text-mint underline decoration-dotted">recipients</Link> screen — a phone number ending in{' '}
              <span className="money">000</span> is treated as unverifiable and will be flagged.
            </div>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {recipients.map((r) => {
                const active = r.id === recipientId;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setRecipientId(active ? null : r.id)}
                      className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                        active ? 'border-mint/60 bg-mint/[0.06] shadow-halo' : 'border-hair bg-slate-950/50 hover:border-ink-faint'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] text-ink">{r.displayName}</span>
                        {r.verification.verified ? (
                          <Badge tone="ok" title={`Name from ${r.verification.source}`}>
                            name matched
                          </Badge>
                        ) : (
                          <Badge tone="warn">unverified</Badge>
                        )}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-ink-faint">
                        {r.phone ?? r.till ?? r.paybill} · {r.rail}
                        {r.defaultAmountMinor ? ` · usually ${kes(r.defaultAmountMinor)}` : ''}
                      </span>
                      {r.verification.name ? <span className="mt-0.5 block text-[10.5px] text-mint-dim">registered as {r.verification.name}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel>
          <SectionTitle>Step 2 · how much</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="label">Recipient receives (KES)</span>
              <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-hair bg-slate-950/80 px-3">
                <span className="money text-[13px] text-ink-faint">Ksh</span>
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                  inputMode="decimal"
                  className="money w-full bg-transparent py-2.5 text-[18px] text-ink outline-none"
                />
              </div>
              <span className="mt-1 block text-[11px] text-ink-faint">Rail limits apply per payout; the price panel refuses what a rail cannot settle.</span>
            </label>
            <label className="block">
              <span className="label">You pay in</span>
              <select value={asset} onChange={(e) => setAsset(e.target.value)} className="input mt-1.5 sm:w-[150px]">
                {ASSETS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-ink-faint">
                available {cryptoFmt(availableMinor, asset)} {asset}
              </span>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {[1000, 3200, 10000, 25000].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setAmount(String(preset))}
                className="rounded-full border border-hair bg-slate-950/60 px-2.5 py-1 text-[11.5px] text-ink-dim transition hover:border-mint-dim/60 hover:text-ink"
              >
                {kes(`${preset * 100}`)}
              </button>
            ))}
          </div>
        </Panel>
      </div>

      <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <Panel className={quote ? 'border-mint/25' : ''}>
          <div className="flex items-center justify-between gap-3">
            <div className="label">Step 3 · the price</div>
            {quote ? (
              <div className={`flex items-center gap-1.5 text-[11.5px] ${expired ? 'text-rose' : 'text-ink-dim'}`}>
                <Dot tone={expired ? 'bad' : remaining < 15 ? 'warn' : 'ok'} pulse={!expired} />
                {expired ? 'price expired' : `locked for ${remaining}s`}
              </div>
            ) : (
              <span className="text-[11px] text-ink-faint">waiting for {recipientId ? 'a market read' : 'a recipient'}</span>
            )}
          </div>

          {quoteError ? <ErrorNote error={quoteError} onRetry={() => void requestQuote()} /> : null}

          {quote && !quoteError ? (
            <>
              <div className="mt-3 rounded-lg border border-hair bg-slate-950/60 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-[12px] text-ink-dim">You send</span>
                  <span className="money text-[22px] leading-none text-mint">
                    {cryptoFmt(quote.totalDebitMinor, quote.asset)} {quote.asset}
                  </span>
                </div>
                <div className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
                  exactly this amount, to an address created for this payment — the network fee is part of what you send, not added later
                </div>
              </div>

              <dl className="mt-3">
                <KV k="Recipient receives" v={kes(quote.recipientAmountMinor)} mono />
                <KV k="Rate applied" v={<RateText scaled={quote.fxRate} mid={quote.midRate} bps={quote.spreadBps} />} mono />
                <KV k="AuraPay fee" v={`${kes(quote.serviceFeeMinor)} · ${(quote.feeBps / 100).toFixed(2)}%`} mono />
                <KV k="Network fee" v={`${cryptoFmt(quote.networkFeeMinor, quote.asset)} ${quote.asset}`} mono />
                <KV k="Rail surcharge" v={kes(quote.providerSurchargeMinor)} mono />
              </dl>

              <div className="mt-3 rounded-lg border border-hair/70 bg-slate-950/40 p-3">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-ink-dim">Settlement route</span>
                  <Badge tone={quote.liquidity.sufficient ? 'ok' : quote.liquidity.queuedIfInsufficient ? 'warn' : 'bad'}>
                    {quote.liquidity.sufficient ? 'float available' : quote.liquidity.queuedIfInsufficient ? 'waits for float' : 'no route'}
                  </Badge>
                </div>
                <div className="mt-1.5 text-[12.5px] text-ink">
                  {quote.route.providerDisplayName} · {quote.route.instant ? 'instant' : `${quote.route.estimatedSettlementSeconds}s target`}
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                  {quote.route.refundable
                    ? 'This rail supports reversal, so a failed payout can be returned automatically.'
                    : 'This rail has no reversal API: once the money is delivered it cannot be pulled back automatically.'}
                  <SimulatedTag text="sandbox rail" />
                </div>
                {(quote.route.considered ?? []).some((c) => !c.usable) ? (
                  <details className="mt-2 text-[11px] text-ink-faint">
                    <summary className="cursor-pointer text-ink-dim">Rails we looked at and rejected</summary>
                    <ul className="mt-1 space-y-0.5">
                      {(quote.route.considered ?? [])
                        .filter((c) => !c.usable)
                        .map((c) => (
                          <li key={c.rail}>
                            {c.rail}: {c.reason ?? 'not usable for this payment'}
                          </li>
                        ))}
                    </ul>
                  </details>
                ) : null}
              </div>

              {quote.riskHint && quote.riskHint.level !== 'LOW' ? (
                <div className="mt-3 rounded-lg border border-amber/30 bg-amber/[0.06] p-3 text-[12px] text-amber">
                  <div className="font-medium">{quote.riskHint.label}</div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-amber/90">{quote.riskHint.reason}</div>
                </div>
              ) : null}

              {insufficient ? (
                <div className="mt-3 rounded-lg border border-rose/40 bg-rose/8 p-3 text-[12px] text-rose">
                  <div className="font-medium">Not enough {quote.asset} in your balance</div>
                  <div className="mt-1 leading-relaxed">
                    You need {cryptoFmt(quote.totalDebitMinor, quote.asset)} and have {cryptoFmt(availableMinor, quote.asset)}.{' '}
                    <Link href="/app/settings" className="underline decoration-dotted">
                      Top up in the sandbox
                    </Link>{' '}
                    — nothing here moves real money.
                  </div>
                </div>
              ) : null}

              {needsNameConfirm ? (
                <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-hair bg-slate-950/50 p-3">
                  <input type="checkbox" checked={confirmName} onChange={(e) => setConfirmName(e.target.checked)} className="mt-0.5 accent-[#57e3b4]" />
                  <span className="text-[12px] leading-relaxed text-ink-dim">
                    I confirm this is <span className="text-ink">{recipient?.displayName}</span>
                    {recipient?.verification.name ? ` (${recipient.verification.name})` : ''} and the amount is right. This confirmation was asked
                    for because of the payment size or an unverified name, and it is recorded on the payment.
                  </span>
                </label>
              ) : null}

              <ErrorNote error={submitError} />

              <button
                type="button"
                onClick={() => void pay()}
                disabled={insufficient || expired || submitting || (needsNameConfirm && !confirmName)}
                className="btn-primary mt-4 w-full"
              >
                {submitting ? 'Committing…' : expired ? 'Price expired — refresh to continue' : `Pay ${cryptoFmt(quote.totalDebitMinor, quote.asset)} ${quote.asset}`}
              </button>
              <p className="mt-2 text-center text-[10.5px] leading-relaxed text-ink-faint">
                This submit carries an idempotency key, so a double click or a lost response cannot pay twice.
              </p>
            </>
          ) : (
            <div className="py-10 text-center text-[12.5px] leading-relaxed text-ink-faint">
              {recipientId ? 'Reading the market…' : 'Pick a recipient and an amount, and the locked price will appear here.'}
            </div>
          )}
        </Panel>

        {expired && quote ? (
          <Panel className="border-amber/25 bg-amber/[0.05]">
            <div className="text-[12.5px] text-ink">The quote expired while you were deciding.</div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-dim">
              A stale rate is never honoured — the market may have moved against you or against the float. Nothing was debited.
            </p>
            <button type="button" className="btn-ghost mt-3 w-full" onClick={() => void requestQuote()}>
              Ask for a new price
            </button>
          </Panel>
        ) : null}

        {user ? null : null}
      </div>
    </div>
  );
}

function RateText({ scaled, mid, bps }: { scaled: string; mid: string; bps: number }) {
  const fmt = (raw: string) => {
    const rate = BigInt(raw);
    const whole = rate / 1_000_000_000_000n;
    const frac = ((rate % 1_000_000_000_000n) / 1_000_000_000n).toString().padStart(3, '0');
    return `${whole}.${frac}`;
  };
  return (
    <span title={`mid-market ${fmt(mid)} KES, spread ${(bps / 100).toFixed(2)}%`}>
      {fmt(scaled)} <span className="text-[10.5px] text-ink-faint">Ksh</span>
    </span>
  );
}
