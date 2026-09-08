'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '../../../../lib/api';
import { crypto as cryptoFmt, kes } from '../../../../lib/format';
import { usePayment } from '../../../../lib/usePayment';
import { Badge, Dot, ErrorNote, KV, Loading, Panel, SectionTitle, SimulatedTag } from '../../../../components/ui';
import { Stepper } from '../../../../components/Stepper';
import { useSession } from '../../../../components/SessionProvider';

export default function ProcessingPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? null;
  const { payment, error, loading, refresh, via } = usePayment(id);
  const { mode } = useSession();
  const canSimulate = mode === 'sandbox';

  // Terminal states stop the room from spinning: no confetti loop, no waiting.
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (payment?.terminal) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1200);
      return () => clearTimeout(t);
    }
  }, [payment?.terminal]);

  if (loading && !payment) {
    return (
      <div className="py-16">
        <Loading label="Reading the payment" />
      </div>
    );
  }

  const status = payment?.status ?? 'UNKNOWN';
  const awaitingDeposit = status === 'AWAITING_PAYMENT';
  const deposit = (payment?.deposit ?? null) as {
    address?: string;
    memo?: string | null;
    amountMinor?: string;
    asset?: string;
    confirmations?: number;
    confirmationsRequired?: number;
    txHash?: string | null;
    expiresAt?: string | null;
  } | null;

  return (
    <div className="grid gap-5 lg:grid-cols-[1.05fr_.95fr]">
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className={`h-2 w-2 rounded-full ${payment?.terminal ? (status === 'FAILED' ? 'bg-rose' : 'bg-mint') : 'bg-amber animate-pulseDot'}`} />
            <div className="label">{payment?.terminal ? (status === 'FAILED' ? 'stopped' : 'settled') : 'in progress'}</div>
          </div>
          <h1 className="mt-1.5 font-display text-[28px] leading-tight tracking-tight text-ink">
            {status === 'FAILED' ? (
              'This payment did not go through'
            ) : payment?.terminal ? (
              <>
                {kes(String(payment?.recipientAmountMinor ?? '0'))} <span className="text-ink-dim">reached the recipient</span>
              </>
            ) : (
              <>
                Sending <span className="money text-mint">{cryptoFmt(String(payment?.totalDebitMinor ?? '0'), String(payment?.asset ?? 'USDT'))}</span>{' '}
                {String(payment?.asset ?? '')}
              </>
            )}
          </h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-dim">
            {payment?.terminal
              ? status === 'FAILED'
                ? 'Your balance was not taken, or it was returned in full — the ledger shows which. The reason is below, with what you can do next.'
                : 'A receipt with a content hash was issued. Everything below is the record, not a summary.'
              : 'This screen follows the backend. A step turns green only when the service that owns it reports it — nothing here is animated ahead of the truth.'}
          </p>
        </div>

        <ErrorNote error={error} onRetry={() => refresh()} />

        <Panel className={flash ? 'border-mint/40' : ''}>
          <SectionTitle
            hint={
              <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                <Dot tone={via === 'stream' ? 'ok' : 'idle'} pulse={via === 'stream'} />
                {via === 'stream' ? 'live via stream' : via === 'poll' ? 'polled every 2.5s' : 'loaded'}
              </span>
            }
          >
            Settlement trail
          </SectionTitle>
          {payment?.steps?.length ? <Stepper steps={payment.steps} status={status} simulated={Boolean(payment.sandbox?.available)} /> : <Loading label="Reading steps" />}

          {!payment?.terminal ? (
            <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-hair bg-slate-950/50 px-3 py-2">
              <span className="text-[11.5px] leading-relaxed text-ink-dim">
                {payment?.settlement?.state === 'WAITING_FLOAT'
                  ? 'Your deposit is safe and held. The payout is waiting for KES settlement float, and the platform is being told about it.'
                  : 'Nothing needs to happen on your side now. You can close this page — the payment keeps settling, and it will be in your activity.'}
              </span>
              <button type="button" onClick={() => refresh()} className="btn-ghost shrink-0 !px-2.5 !py-1 text-[11.5px]">
                Check now
              </button>
            </div>
          ) : null}
        </Panel>

        {awaitingDeposit && deposit?.address ? (
          <Panel>
            <SectionTitle hint={<span className="text-[11px] text-ink-faint">one address, this payment only</span>}>Send the crypto</SectionTitle>
            <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
              <Qr value={deposit.address} />
              <div>
                <div className="label">Amount (exact)</div>
                <div className="money mt-1 text-[19px] text-mint">
                  {cryptoFmt(String(deposit.amountMinor ?? payment?.totalDebitMinor ?? '0'), String(payment?.asset ?? 'USDT'))} {String(payment?.asset ?? '')}
                </div>
                <div className="mt-3 label">Network</div>
                <div className="text-[12.5px] text-ink">
                  {String(payment?.network ?? '')} · {String(payment?.rail ?? '')} payout
                </div>
                <div className="mt-3 label">Deposit address</div>
                <div className="money mt-1 break-all rounded border border-hair bg-slate-950/70 px-2.5 py-2 text-[11.5px] text-ink-dim">{deposit.address}</div>
                {deposit.memo ? (
                  <>
                    <div className="mt-2 label">Memo</div>
                    <div className="money text-[12px] text-ink">{deposit.memo}</div>
                  </>
                ) : null}
                <div className="mt-3 text-[11px] leading-relaxed text-ink-faint">
                  {deposit.confirmations ?? 0}/{deposit.confirmationsRequired ?? 19} confirmations
                  {deposit.txHash ? ` · ${String(deposit.txHash).slice(0, 18)}…` : ' · waiting for the network to see it'}
                  <SimulatedTag text="sandbox chain" />
                </div>
              </div>
            </div>
            {canSimulate ? <SandboxDeposit paymentId={id!} onDone={() => refresh()} /> : null}
          </Panel>
        ) : null}

        {status === 'FAILED' && payment?.failure ? (
          <Panel className="border-rose/35 bg-rose/[0.05]">
            <SectionTitle hint={<Badge tone="bad">{payment.failure.code}</Badge>}>Why it stopped</SectionTitle>
            <p className="text-[13px] leading-relaxed text-ink">{payment.failure.message}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {payment.failure.recovery === 'retry_with_another_rail' ? (
                <Link href="/app/pay" className="btn-ghost">
                  Pay with another rail
                </Link>
              ) : null}
              {['retry_later', 'retry'].includes(payment.failure.recovery) ? (
                <button type="button" onClick={() => refresh()} className="btn-ghost">
                  Try again now
                </button>
              ) : null}
              <Link href={`/app/transactions/${id}`} className="btn-ghost">
                Open the record
              </Link>
            </div>
          </Panel>
        ) : null}
      </div>

      <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        {payment?.terminal && status !== 'FAILED' ? (
          <Panel className="border-mint/30 bg-mint/[0.04] p-6 text-center">
            <div className="mx-auto grid h-11 w-11 place-items-center rounded-full border border-mint/40 bg-mint/10">
              <svg viewBox="0 0 24 24" className="h-6 w-6 text-mint" aria-hidden>
                <path d="M5 12.6l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="mt-3 font-display text-[20px] text-ink">Delivered</div>
            <div className="mt-1 text-[12px] leading-relaxed text-ink-dim">
              {kes(String(payment.recipientAmountMinor ?? '0'))} to {String((payment.recipient as { displayName?: string } | null)?.displayName ?? 'the recipient')}
            </div>
            <div className="mt-4 flex flex-col gap-2">
              <Link href={`/app/transactions/${id}`} className="btn-primary">
                View receipt
              </Link>
              <Link href="/app/pay" className="btn-ghost">
                Pay someone else
              </Link>
            </div>
          </Panel>
        ) : null}

        <Panel>
          <SectionTitle hint={<span className="money text-[11px] text-ink-faint">{payment?.reference}</span>}>This payment</SectionTitle>
          <dl>
            <KV k="Status" v={<Badge tone={payment?.terminal ? (status === 'FAILED' ? 'bad' : 'ok') : 'warn'}>{payment?.displayStatus}</Badge>} />
            <KV k="Settlement" v={payment?.settlement?.state ?? '—'} />
            <KV k="Amount out" v={kes(String(payment?.recipientAmountMinor ?? '0'))} mono />
            <KV k="You paid" v={`${cryptoFmt(String(payment?.totalDebitMinor ?? '0'), String(payment?.asset ?? 'USDT'))} ${String(payment?.asset ?? '')}`} mono />
            <KV k="Rate" v={<RateSmall scaled={String(payment?.fxRateScaled ?? '0')} />} mono />
            <KV k="Network fee" v={`${cryptoFmt(String(payment?.networkFeeMinor ?? '0'), String(payment?.asset ?? 'USDT'))}`} mono />
            <KV k="AuraPay fee" v={kes(String(payment?.serviceFeeMinor ?? '0'))} mono />
            <KV k="Created" v={payment?.createdAt ? new Date(String(payment.createdAt)).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—'} />
            {payment?.completedAt ? <KV k="Settled" v={new Date(String(payment.completedAt)).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })} /> : null}
          </dl>
          {payment?.payout ? (
            <div className="mt-3 rounded-lg border border-hair/70 bg-slate-950/40 p-3">
              <div className="text-[12px] text-ink-dim">Payout from the rail</div>
              <div className="mt-1 text-[12.5px] text-ink">
                {String((payment.payout as { railLabel?: string }).railLabel ?? '')} ·{' '}
                {String((payment.payout as { state?: string }).state ?? '')}
                {String((payment.payout as { providerReference?: string }).providerReference ?? '') ? (
                  <span className="money ml-1 text-[11px] text-ink-faint">{String((payment.payout as { providerReference?: string }).providerReference)}</span>
                ) : null}
              </div>
              {(payment.payout as { failureMessage?: string | null }).failureMessage ? (
                <div className="mt-1 text-[11.5px] leading-relaxed text-amber">{String((payment.payout as { failureMessage?: string | null }).failureMessage)}</div>
              ) : null}
            </div>
          ) : null}
        </Panel>

        <Panel>
          <SectionTitle>What happens if you close this</SectionTitle>
          <p className="text-[12px] leading-relaxed text-ink-dim">
            Nothing changes. The payment is driven by server-side jobs, not by this tab: the deposit window, confirmations and payout retries
            continue with the page closed, and the record will be in your activity.
          </p>
        </Panel>
      </div>
    </div>
  );
}

function Qr({ value }: { value: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Rendered client-side with the same library the API uses: a QR of a deposit
    // address never round-trips through a third-party image service.
    import('qrcode')
      .then((mod) => mod.toDataURL(value, { margin: 1, color: { dark: '#e8eef6', light: '#0a0e14' }, width: 168 }))
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => setDataUrl(null));
    return () => {
      cancelled = true;
    };
  }, [value]);
  return (
    <div className="grid h-[168px] w-[168px] place-items-center rounded-lg border border-hair bg-slate-950">
      {dataUrl ? <img src={dataUrl} alt="Deposit address QR code" width={168} height={168} /> : <span className="text-[11px] text-ink-faint">drawing…</span>}
    </div>
  );
}

function SandboxDeposit({ paymentId, onDone }: { paymentId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="mt-4 rounded-lg border border-amber/25 bg-amber/[0.05] p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[11.5px] leading-relaxed text-amber/90">
          Sandbox only: this records a deposit observation the way the chain watcher would. It does not skip the confirmations or the payout.
        </div>
        <button
          type="button"
          disabled={busy}
          className="btn-ghost shrink-0 !py-1.5 text-[12px]"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api('/sandbox/simulate-deposit', { method: 'POST', body: { paymentId } });
              onDone();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Recording…' : 'Simulate the deposit'}
        </button>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

function RateSmall({ scaled }: { scaled: string }) {
  if (!scaled || scaled === '0') return <>—</>;
  const rate = BigInt(scaled);
  const whole = rate / 1_000_000_000_000n;
  const frac = ((rate % 1_000_000_000_000n) / 1_000_000_000n).toString().padStart(3, '0');
  return <>Ksh {whole}.{frac}</>;
}
