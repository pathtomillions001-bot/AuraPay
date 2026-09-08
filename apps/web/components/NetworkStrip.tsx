'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, Dot, SimulatedTag } from './ui';

interface Status {
  networks: Array<{ code: string; name: string; status: string; confirmationsRequired: number; observedAt: string | null; simulated: boolean }>;
  providers: Array<{ code: string; name: string; operational: boolean; successRatePct: number; simulated: boolean }>;
  rails: Array<{ code: string; name: string; instant: boolean; refundable: boolean; maxAmountLocal: number }>;
  note?: string;
}

interface Rates {
  assets: Array<{ asset: string; source: string; stale: boolean; change24hPct: number; simulated: boolean }>;
  updatedAt: string;
}

/**
 * Honest ambient data. Every figure here is what the API reported, with the same
 * staleness flag the payment flow uses — a number that has gone stale is shown grey
 * and marked stale, because a stale price on a landing page is harmless and on a
 * payment screen it is not.
 */
export function NetworkStrip() {
  const [status, setStatus] = useState<Status | null>(null);
  const [rates, setRates] = useState<Rates | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [s, r] = await Promise.all([api<Status>('/network-status'), api<Rates>('/rates')]);
        if (!live) return;
        setStatus(s);
        setRates(r);
      } catch {
        if (live) setStatus(null);
      }
    };
    void load();
    const t = setInterval(load, 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (!status) {
    return (
      <div className="mt-6 flex items-center gap-2 text-[12px] text-ink-faint">
        <Dot tone="idle" pulse /> reading the network board…
      </div>
    );
  }

  return (
    <section className="mt-6 grid gap-3 lg:grid-cols-[1.3fr_1fr]">
      <Panelish>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
          <span className="label">
            Feeds <SimulatedTag text="simulated" />
          </span>
          {(rates?.assets ?? []).map((a) => (
            <span key={a.asset} className="flex items-center gap-1.5 text-[12.5px]">
              <Dot tone={a.stale ? 'warn' : 'ok'} pulse={!a.stale} />
              <span className="text-ink">{a.asset}</span>
              <span className={a.stale ? 'text-ink-faint' : a.change24hPct >= 0 ? 'text-mint-dim' : 'text-rose-dim'}>
                {a.stale ? 'stale' : `${a.change24hPct >= 0 ? '+' : ''}${a.change24hPct.toFixed(2)}%`}
              </span>
              <span className="text-[10px] text-ink-faint">{a.source}</span>
            </span>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-hair pt-3">
          <span className="label">Chains</span>
          {status.networks.map((n) => (
            <span key={n.code} className="flex items-center gap-1.5 text-[12.5px] text-ink-dim">
              <Dot tone={n.status === 'OPERATIONAL' ? 'ok' : n.status === 'DEGRADED' ? 'warn' : 'bad'} />
              {n.name}
              <span className="text-[10.5px] text-ink-faint">{n.confirmationsRequired} confs</span>
            </span>
          ))}
        </div>
        {status.note ? <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">{status.note}</p> : null}
      </Panelish>
      <Panelish>
        <div className="flex items-center justify-between">
          <span className="label">Rails this build can settle</span>
          <Badge tone="neutral">{status.rails.length}</Badge>
        </div>
        <ul className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
          {status.rails.map((r) => (
            <li key={r.code} className="flex items-center justify-between gap-2 rounded-lg border border-hair/70 bg-slate-950/50 px-2.5 py-1.5">
              <span className="text-[12.5px] text-ink">{r.name}</span>
              <span className="flex items-center gap-1.5 text-[10.5px] text-ink-faint">
                {r.instant ? <Badge tone="ok">instant</Badge> : null}
                {r.refundable ? null : <Badge tone="warn">no reversal</Badge>}
              </span>
            </li>
          ))}
        </ul>
      </Panelish>
    </section>
  );
}

function Panelish({ children }: { children: React.ReactNode }) {
  return <div className="panel p-4">{children}</div>;
}
