'use client';

import Link from 'next/link';
import { useApi } from '../../lib/useApi';
import { kes, short, usd, when } from '../../lib/format';
import { Badge, Dot, ErrorNote, Loading, Money, Panel, SectionTitle, SimulatedTag } from '../../components/ui';
import { useSession } from '../../components/SessionProvider';
import { Stepper } from '../../components/Stepper';

interface Overview {
  wallets: {
    totalUsdMinor: string;
    totalKesMinor: string;
    referenceRateKesPerUsd: string;
    dataOrigin?: string;
    wallets: Array<{
      asset: string;
      network: string;
      label: string;
      availableMinor: string;
      reservedMinor: string;
      totalMinor: string;
      usdValueMinor: string;
      kesValueMinor: string;
      change24hPct: number;
      custodyMode: string;
      dataOrigin: string;
    }>;
  };
  recent: Array<{
    id: string;
    reference: string;
    status: string;
    displayStatus: string;
    rail: string;
    asset: string;
    recipientAmountMinor: string;
    totalDebitMinor: string;
    createdAt: string;
    progress: number;
    terminal: boolean;
    recipient?: { displayName?: string | null; phone?: string | null } | null;
  }>;
  open: number;
  notifications: Array<{ id: string; title: string; body: string | null; severity: string; createdAt: string; readAt: string | null; link: string | null }>;
}

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  COMPLETED: 'ok',
  PAYOUT_CONFIRMED: 'ok',
  REFUNDED: 'neutral',
  FAILED: 'bad',
  CANCELLED: 'neutral',
};

export default function OverviewPage() {
  const { user } = useSession();
  const { data, error, loading, refresh } = useApi<Overview>('/account/overview', { pollMs: 12_000 });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="label">Portfolio</div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="font-display text-[34px] leading-none tracking-tight text-ink">{usd(data?.wallets.totalUsdMinor)}</span>
            <SimulatedTag text="sandbox custody" />
          </div>
          <div className="mt-1.5 text-[12.5px] text-ink-dim">
            {data ? `${kes(data.wallets.totalKesMinor)} at Ksh ${data.wallets.referenceRateKesPerUsd} / 1 USDT` : 'reading the price feed…'}
            <span className="text-ink-faint"> · balances are the ledger cache, never a client estimate</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {data && data.open > 0 ? (
            <Badge tone="warn" title="Payments waiting on the network or the settlement float">
              <Dot tone="warn" pulse /> {data.open} in flight
            </Badge>
          ) : (
            <Badge tone="ok">nothing waiting</Badge>
          )}
          <Link href="/app/pay" className="btn-primary">
            Pay someone
          </Link>
        </div>
      </div>

      <ErrorNote error={error} onRetry={() => void refresh()} />
      {loading && !data ? <Loading label="Loading your account" /> : null}

      <div className="grid gap-4 lg:grid-cols-[1.15fr_.85fr]">
        <Panel>
          <SectionTitle hint={<span className="text-[11px] text-ink-faint">{data?.wallets.dataOrigin === 'sandbox' ? 'sandbox balances' : 'ledger'}</span>}>
            Balances by asset
          </SectionTitle>
          <div className="divide-y divide-hair/70">
            {(data?.wallets.wallets ?? []).map((w) => (
              <div key={`${w.asset}:${w.network}`} className="flex items-center justify-between gap-4 py-2.5">
                <div>
                  <div className="text-[13.5px] text-ink">{w.label}</div>
                  <div className="text-[11px] text-ink-faint">
                    {w.reservedMinor !== '0' ? `${usd("0")} reserved · ` : ''}
                    {w.custodyMode === 'sandbox_simulated' ? 'simulated custody' : w.custodyMode}
                  </div>
                </div>
                <div className="text-right">
                  <Money
                    value={`${trim(w.availableMinor, w.asset)} ${w.asset}`}
                    sub={`${usd(w.usdValueMinor)} · ${kes(w.kesValueMinor)}`}
                  />
                  <div className={`text-[11px] ${w.change24hPct >= 0 ? 'text-mint-dim' : 'text-rose-dim'}`}>
                    {w.change24hPct >= 0 ? '+' : ''}
                    {w.change24hPct.toFixed(2)}% 24h
                  </div>
                </div>
              </div>
            ))}
            {!data?.wallets.wallets.length ? <div className="py-6 text-center text-[12.5px] text-ink-faint">No custody wallets yet.</div> : null}
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel>
            <SectionTitle hint={<Link href="/app/transactions" className="text-[11px] text-mint underline decoration-dotted">all activity</Link>}>
              Latest payments
            </SectionTitle>
            <ul className="divide-y divide-hair/70">
              {(data?.recent ?? []).slice(0, 6).map((p) => (
                <li key={p.id}>
                  <Link href={`/app/transactions/${p.id}`} className="row-hover flex items-center gap-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{p.recipient?.displayName ?? p.recipient?.phone ?? short(p.reference)}</span>
                      <span className="block text-[11px] text-ink-faint">
                        {p.rail} · {when(p.createdAt)}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="money block text-[13px] text-ink">{kes(p.recipientAmountMinor)}</span>
                      <span className="block text-[10.5px] text-ink-faint">
                        {p.terminal ? p.displayStatus.toLowerCase() : `${Math.round(p.progress * 100)}%`}
                      </span>
                    </span>
                    <Badge tone={TONE[p.status] ?? 'warn'}>{p.displayStatus}</Badge>
                  </Link>
                </li>
              ))}
              {!data?.recent.length ? (
                <li className="py-6 text-center">
                  <div className="text-[12.5px] text-ink-dim">No payments yet.</div>
                  <Link href="/app/pay" className="mt-2 inline-block text-[12.5px] text-mint underline decoration-dotted">
                    send your first one
                  </Link>
                </li>
              ) : null}
            </ul>
          </Panel>

          <Panel>
            <SectionTitle>Notifications</SectionTitle>
            {data?.notifications.length ? (
              <ul className="space-y-2.5">
                {data.notifications.slice(0, 4).map((n) => (
                  <li key={n.id} className="flex gap-2.5">
                    <span className="mt-[6px]">
                      <Dot tone={n.severity === 'critical' ? 'bad' : n.severity === 'warn' ? 'warn' : 'idle'} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[12.5px] text-ink">{n.title}</div>
                      <div className="text-[11.5px] leading-relaxed text-ink-dim">{n.body}</div>
                      <div className="text-[10.5px] text-ink-faint">{when(n.createdAt)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[12.5px] text-ink-faint">Nothing needing your attention.</div>
            )}
          </Panel>
        </div>
      </div>

      {user?.kycStatus && user.kycStatus !== 'APPROVED' ? (
        <Panel className="border-amber/25 bg-amber/[0.05]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[13.5px] text-ink">Identity verification is {user.kycStatus.replace(/_/g, ' ').toLowerCase()}</div>
              <div className="text-[11.5px] text-ink-dim">
                Until it clears, payments are capped at your tier {user.kycTier} limit. This is enforced by the same rules a live account gets.
              </div>
            </div>
            <Link href="/app/settings" className="btn-ghost">
              Review limits
            </Link>
          </div>
        </Panel>
      ) : null}

      {data?.recent.some((p) => !p.terminal) ? (
        <Panel>
          <SectionTitle hint={<span className="text-[11px] text-ink-faint">steps come from the backend, not a timer</span>}>
            In flight right now
          </SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            {data.recent
              .filter((p) => !p.terminal)
              .map((p) => (
                <div key={p.id} className="rounded-lg border border-hair/70 bg-slate-950/50 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="money text-[12px] text-ink-dim">{p.reference}</span>
                    <Badge tone="warn">{p.displayStatus}</Badge>
                  </div>
                  <MiniSteps id={p.id} />
                </div>
              ))}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function MiniSteps({ id }: { id: string }) {
  const { data } = useApi<{ steps: never[]; status: string }>(`/payments/${id}`, { pollMs: 4_000 });
  if (!data) return <div className="text-[11.5px] text-ink-faint">waiting for the network…</div>;
  return <Stepper steps={data.steps} status={data.status} simulated />;
}

/** Crypto amounts arrive in minor units; show what the asset actually allows. */
function trim(minor: string, asset: string): string {
  const scale = asset === 'BTC' ? 8 : asset === 'ETH' ? 18 : asset === 'KES' ? 2 : 6;
  const value = BigInt(minor);
  const unit = 10n ** BigInt(scale);
  const whole = value / unit;
  const frac = (value % unit).toString().padStart(scale, '0').replace(/0+$/, '');
  return frac.length ? `${whole}.${frac.slice(0, Math.min(6, frac.length))}` : whole.toString();
}
