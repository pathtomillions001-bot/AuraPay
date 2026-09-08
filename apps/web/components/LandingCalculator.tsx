'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import { crypto as cryptoFmt, kes } from '../lib/format';
import { ErrorNote, Panel, SimulatedTag } from './ui';

interface Preview {
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
  ttlSeconds: number;
  route: { rail: string; providerDisplayName: string; estimatedSettlementSeconds: number; refundable: boolean; instant: boolean; latencySeconds: number };
  liquidity: { sufficient: boolean };
  previewOnly?: boolean;
  note?: string;
}

const ASSETS = [
  { code: 'USDT', label: 'USDT · Tron', network: 'TRON' },
  { code: 'USDC', label: 'USDC · Ethereum', network: 'ETHEREUM' },
  { code: 'BTC', label: 'Bitcoin', network: 'BITCOIN' },
  { code: 'ETH', label: 'Ethereum', network: 'ETHEREUM' },
];

/**
 * A *display* calculator. It calls the same pricing code a real quote uses — the
 * same spread, the same rail surcharge, the same fee floor — but no quote id is
 * issued and nothing can be consumed from here, so the landing page cannot become
 * a way to reserve money.
 */
export function LandingCalculator() {
  const [amount, setAmount] = useState('3200');
  const [asset, setAsset] = useState('USDT');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError(new Error('Enter the amount the recipient should receive, in shillings.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ quote: Preview }>('/quote-preview', {
        method: 'POST',
        body: { asset: asset as never, amountKesMajor: value, kind: 'PHONE' },
      });
      setPreview(res.quote);
    } catch (e) {
      setError(e);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }, [amount, asset]);

  useEffect(() => {
    const t = setTimeout(() => void run(), 350);
    return () => clearTimeout(t);
  }, [run]);

  const perUsd = useMemo(() => {
    if (!preview) return null;
    const rate = BigInt(preview.fxRate);
    const whole = rate / 1_000_000_000_000n;
    const frac = (rate % 1_000_000_000_000n) / 1_000_000_000n;
    return `Ksh ${whole.toString()}.${frac.toString().padStart(3, '0')}`;
  }, [preview]);

  return (
    <Panel className="!p-0 overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-hair px-5 py-3.5">
        <div className="label">Price check</div>
        <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          <SimulatedTag text="sandbox feed" />
        </div>
      </div>
      <div className="grid gap-3 px-5 pt-4 sm:grid-cols-[1fr_auto]">
        <label className="block">
          <span className="label">Recipient receives</span>
          <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-hair bg-slate-950/80 px-3">
            <span className="money text-[13px] text-ink-faint">Ksh</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              inputMode="decimal"
              className="money w-full bg-transparent py-2.5 text-[17px] text-ink outline-none"
              aria-label="Amount in Kenyan shillings"
            />
          </div>
        </label>
        <label className="block">
          <span className="label">You pay with</span>
          <select value={asset} onChange={(e) => setAsset(e.target.value)} className="input mt-1.5 min-w-[168px]">
            {ASSETS.map((a) => (
              <option key={a.code} value={a.code}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4 px-5">
        {error ? <ErrorNote error={error} onRetry={() => void run()} /> : null}
        {preview ? (
          <dl className="divide-y divide-hair/70">
            <Line k="Exchange rate applied" v={`${perUsd} / 1 ${preview.asset}`} hint={`mid ${'mid'} · spread ${preview.spreadBps / 100}%`} />
            <Line k="Recipient gets" v={kes(preview.recipientAmountMinor)} />
            <Line
              k="Network fee"
              v={`${cryptoFmt(preview.networkFeeMinor, preview.asset)} ${preview.asset}`}
              hint={`paid to ${preview.network}; never refunded`}
            />
            <Line k="AuraPay fee" v={kes(preview.serviceFeeMinor)} hint={`${(preview.feeBps / 100).toFixed(2)}% · min Ksh 32`} />
            <Line k="You send" v={`${cryptoFmt(preview.totalDebitMinor, preview.asset)} ${preview.asset}`} strong />
          </dl>
        ) : (
          <div className="py-8 text-center text-[13px] text-ink-faint">{busy ? 'Reading the price feed…' : 'Waiting for a number…'}</div>
        )}
      </div>

      {preview ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-hair px-5 py-3.5 text-[11.5px] text-ink-dim">
          <span>
            {preview.route.instant ? 'Instant rail' : `${preview.route.estimatedSettlementSeconds}s target`} ·{' '}
            {preview.route.refundable ? 'reversible by the rail' : 'not reversible once sent'} · {preview.route.providerDisplayName}
          </span>
          <Link href="/app/pay" className="text-mint underline decoration-dotted">
            pay this for real →
          </Link>
        </div>
      ) : null}
    </Panel>
  );
}

function Line({ k, v, hint, strong = false }: { k: string; v: string; hint?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-[12.5px] text-ink-dim">
        {k}
        {hint ? <div className="text-[10.5px] text-ink-faint">{hint}</div> : null}
      </dt>
      <dd className={`money ${strong ? 'text-[16px] text-mint' : 'text-[13.5px] text-ink'}`}>{v}</dd>
    </div>
  );
}
