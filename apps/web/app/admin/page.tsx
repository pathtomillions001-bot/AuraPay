'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Chrome } from '../../components/Chrome';
import { useSession } from '../../components/SessionProvider';
import { useApi } from '../../lib/useApi';
import { api } from '../../lib/api';
import { Badge, Dot, ErrorNote, KV, Loading, Panel, SectionTitle, SimulatedTag } from '../../components/ui';
import { kes, when } from '../../lib/format';

/**
 * Operations console. Every number on this page is a read of the same tables the
 * customer screens use, and every control is labelled with what it actually does:
 * there is no "mark as paid" anywhere, because an operator cannot make a settlement
 * true by asserting it.
 */
export default function AdminPage() {
  const { user, isAdmin, loading } = useSession();
  const [tab, setTab] = useState<'overview' | 'queue' | 'treasury' | 'fees' | 'integrity' | 'audit'>('overview');
  const { data: overview, refresh } = useApi<Record<string, never> | null>('/admin/overview', { pollMs: 15_000 });
  const o = overview as unknown as AdminOverview | null;

  if (loading) {
    return (
      <Chrome>
        <Loading label="Checking your access" />
      </Chrome>
    );
  }
  if (!user) {
    return (
      <Chrome>
        <Panel className="p-8 text-center">
          <div className="text-[14px] text-ink">Sign in with an operations account.</div>
          <Link href="/signin?next=/admin" className="btn-primary mt-4">
            Sign in
          </Link>
        </Panel>
      </Chrome>
    );
  }
  if (!isAdmin) {
    return (
      <Chrome>
        <Panel className="p-8">
          <div className="text-[14px] text-ink">This account is not an operator account.</div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-dim">
            The operations surface reads other people&rsquo;s money, so it is gated on a role in the database rather than on a hidden URL. Sign in as{' '}
            <span className="money">admin@aurapay.dev</span> in the sandbox to see it.
          </p>
        </Panel>
      </Chrome>
    );
  }

  return (
    <Chrome>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="label">Operations</div>
            <h1 className="mt-1 font-display text-[26px] tracking-tight text-ink">Settlement health, treasury, and the audit trail</h1>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(['overview', 'queue', 'treasury', 'fees', 'integrity', 'audit'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-full border px-3 py-1 text-[12px] capitalize transition ${
                  tab === t ? 'border-mint/50 bg-mint/10 text-mint' : 'border-hair bg-slate-950/60 text-ink-dim hover:text-ink'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {tab === 'overview' ? (
          <div className="grid gap-4 lg:grid-cols-3">
            <Panel>
              <SectionTitle hint={<span className="text-[11px] text-ink-faint">money in flight first</span>}>Payments</SectionTitle>
              <dl>
                <KV k="Open" v={String(o?.payments?.open ?? 0)} mono />
                <KV k="Stalled &gt;30m" v={String(o?.payments?.stalledOver30m ?? 0)} mono />
                <KV k="Oldest open" v={o?.payments?.oldestOpen ? when(o.payments.oldestOpen) : '—'} />
                <KV k="Cases open" v={String(o?.cases?.open ?? 0)} mono />
                <KV k="SLA breached" v={String(o?.cases?.slaBreached ?? 0)} mono />
              </dl>
            </Panel>
            <Panel>
              <SectionTitle>Jobs</SectionTitle>
              <dl>
                <KV k="Ready" v={String(o?.queue?.ready ?? 0)} mono />
                <KV k="Active" v={String(o?.queue?.active ?? 0)} mono />
                <KV k="Dead" v={<Badge tone={(o?.queue?.dead ?? 0) > 0 ? 'bad' : 'ok'}>{String(o?.queue?.dead ?? 0)}</Badge>} />
                <KV k="Oldest waiting" v={o?.queue?.oldestReadyAt ? when(o.queue.oldestReadyAt) : '—'} />
              </dl>
            </Panel>
            <Panel>
              <SectionTitle hint={<SimulatedTag text="sandbox" />}>Providers</SectionTitle>
              <ul className="space-y-1.5">
                {(o?.providers ?? []).map((p) => (
                  <li key={p.code} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="flex items-center gap-1.5 text-ink-dim">
                      <Dot tone={p.operational ? 'ok' : 'bad'} />
                      {p.name}
                    </span>
                    <span className="money text-[11px] text-ink-faint">
                      {p.successRatePct.toFixed(1)}% · {p.latencyP50Ms}ms {p.simulated ? '' : 'live'}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        ) : null}

        {tab === 'queue' ? <QueueTab /> : null}
        {tab === 'treasury' ? <TreasuryTab /> : null}
        {tab === 'fees' ? <FeesTab /> : null}
        {tab === 'integrity' ? <IntegrityTab /> : null}
        {tab === 'audit' ? <AuditTab /> : null}

        {tab === 'overview' ? (
          <div className="flex justify-end">
            <button type="button" className="btn-ghost" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
        ) : null}
      </div>
    </Chrome>
  );
}

interface AdminOverview {
  payments?: { open: number; stalledOver30m: number; oldestOpen: string | null };
  cases?: { open: number; slaBreached: number };
  queue?: { ready: number; active: number; dead: number; oldestReadyAt: string | null };
  providers?: Array<{ code: string; name: string; operational: boolean; successRatePct: number; latencyP50Ms: number; simulated: boolean }>;
}

function QueueTab() {
  const { data, refresh } = useApi<{ stats: { ready: number; active: number; dead: number }; byKind: Array<{ kind: string; status: string; c: number }>; dead: Array<Record<string, unknown>> }>('/admin/queue');
  const [busy, setBusy] = useState(false);
  return (
    <Panel>
      <SectionTitle hint={<span className="text-[11px] text-ink-faint">{JSON.stringify(data?.stats ?? {})}</span>}>Job queue</SectionTitle>
      <table className="w-full text-[12.5px]">
        <tbody className="divide-y divide-hair/60">
          {(data?.byKind ?? []).map((r, i) => (
            <tr key={`${r.kind}-${r.status}-${i}`}>
              <td className="py-1.5 text-ink">{r.kind}</td>
              <td className="py-1.5 text-ink-dim">{r.status}</td>
              <td className="money py-1.5 text-right text-ink-dim">{r.c}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.dead.length ? (
        <div className="mt-3 rounded-lg border border-rose/35 bg-rose/[0.06] p-3">
          <div className="text-[12px] text-rose">Jobs the platform gave up on — these are real incidents</div>
          <ul className="mt-1.5 space-y-1 text-[11.5px] text-ink-dim">
            {data.dead.map((d) => (
              <li key={String(d.id)}>
                <span className="money">{String(d.kind)}</span> · attempts {String(d.attempts)} · {String(d.last_error ?? 'no error recorded')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <button
        type="button"
        className="btn-ghost mt-3"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api('/admin/queue/run', { method: 'POST' });
            await refresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Running…' : 'Run one queue tick'}
      </button>
    </Panel>
  );
}

function TreasuryTab() {
  const { data, refresh } = useApi<{ floatAccounts?: Array<{ rail: string; currency: string; availableMinor: string }>; alerts: Array<{ kind: string; detail: string }>; sweeps?: unknown[] }>('/admin/treasury', {
    pollMs: 20_000,
  });
  const [form, setForm] = useState({ rail: 'MPESA', currency: 'KES', amountMajor: '50000', direction: 'IN', reason: '' });
  const [error, setError] = useState<unknown>(null);
  const t = data as unknown as { floatAccounts?: Array<{ rail: string; currency: string; availableMinor: string }>; alerts?: Array<{ kind: string; detail: string }> };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel>
        <SectionTitle>Float by rail</SectionTitle>
        <dl>
          {(t?.floatAccounts ?? []).map((f) => (
            <KV key={`${f.rail}:${f.currency}`} k={`${f.rail} · ${f.currency}`} v={kes(f.availableMinor)} mono />
          ))}
          {!(t?.floatAccounts ?? []).length ? <KV k="Float" v="no accounts" /> : null}
        </dl>
        <div className="mt-3 space-y-2 rounded-lg border border-hair bg-slate-950/50 p-3">
          <div className="label">Record a treasury movement</div>
          <div className="grid grid-cols-3 gap-2">
            <input className="input" value={form.rail} onChange={(e) => setForm({ ...form, rail: e.target.value })} />
            <input className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
            <input className="money input" value={form.amountMajor} onChange={(e) => setForm({ ...form, amountMajor: e.target.value })} />
          </div>
          <input
            className="input"
            placeholder="Why is this moving? (required, written to the audit log)"
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          />
          <ErrorNote error={error} />
          <button
            type="button"
            className="btn-primary w-full"
            onClick={async () => {
              setError(null);
              try {
                await api('/admin/treasury/float', { method: 'POST', body: form });
                await refresh();
              } catch (e) {
                setError(e);
              }
            }}
          >
            {form.direction === 'IN' ? 'Record top-up' : 'Record withdrawal'}
          </button>
          <div className="flex gap-2 text-[11px] text-ink-faint">
            <label className="flex items-center gap-1">
              <input type="radio" checked={form.direction === 'IN'} onChange={() => setForm({ ...form, direction: 'IN' })} /> into float
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={form.direction === 'OUT'} onChange={() => setForm({ ...form, direction: 'OUT' })} /> out of float
            </label>
          </div>
        </div>
      </Panel>
      <Panel>
        <SectionTitle hint={<span className="text-[11px] text-ink-faint">what is short right now</span>}>Alerts</SectionTitle>
        <ul className="space-y-2">
          {(t?.alerts ?? []).map((a, i) => (
            <li key={i} className="rounded-lg border border-amber/30 bg-amber/[0.05] px-3 py-2 text-[12px] text-amber">
              <span className="font-medium">{a.kind}</span> — {a.detail}
            </li>
          ))}
          {!(t?.alerts ?? []).length ? <li className="text-[12.5px] text-ink-faint">Nothing is short. Payments that needed float had it.</li> : null}
        </ul>
        <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
          Float is what this deployment records as available to settle payouts. Adding float here does not create money: it records the operator&rsquo;s
          statement that money arrived at the rail, and the ledger keeps the entry.
        </p>
      </Panel>
    </div>
  );
}

function FeesTab() {
  const { data, refresh } = useApi<{ schedules: Array<Record<string, unknown>>; history: Array<Record<string, unknown>> }>('/admin/fees');
  const [form, setForm] = useState({ asset: 'USDT', rail: '*', platformFeeBps: '100', spreadBps: '25', platformFeeMinKes: '32', note: '' });
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel>
        <SectionTitle>Live schedule</SectionTitle>
        <ul className="space-y-1.5 text-[12px]">
          {(data?.schedules ?? []).map((s, i) => (
            <li key={i} className="flex items-center justify-between gap-3 border-b border-hair/60 pb-1.5">
              <span className="text-ink">{String(s.asset)} / {String(s.rail)}</span>
              <span className="money text-[11px] text-ink-faint">
                {String(s.platform_fee_bps ?? s.platformFeeBps ?? '—')} bps · spread {String(s.spread_bps ?? s.spreadBps ?? '—')} bps
              </span>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel>
        <SectionTitle hint={<span className="text-[11px] text-ink-faint">appends a dated row; issued quotes keep their price</span>}>Change pricing</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <input className="input" value={form.asset} onChange={(e) => setForm({ ...form, asset: e.target.value })} />
          <input className="input" value={form.rail} onChange={(e) => setForm({ ...form, rail: e.target.value })} />
          <label className="block">
            <span className="label">bps</span>
            <input className="money input mt-1" value={form.platformFeeBps} onChange={(e) => setForm({ ...form, platformFeeBps: e.target.value })} />
          </label>
          <label className="block">
            <span className="label">spread bps</span>
            <input className="money input mt-1" value={form.spreadBps} onChange={(e) => setForm({ ...form, spreadBps: e.target.value })} />
          </label>
          <label className="block col-span-2">
            <span className="label">Why (required)</span>
            <input className="input mt-1" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
        </div>
        <ErrorNote error={error} />
        <button
          type="button"
          className="btn-primary mt-3 w-full"
          onClick={async () => {
            setError(null);
            try {
              await api('/admin/fees', { method: 'PUT', body: { ...form, platformFeeBps: Number(form.platformFeeBps), spreadBps: Number(form.spreadBps), platformFeeMinKes: Number(form.platformFeeMinKes) } });
              await refresh();
            } catch (e) {
              setError(e);
            }
          }}
        >
          Append new schedule
        </button>
      </Panel>
    </div>
  );
}

function IntegrityTab() {
  const { data, loading, refresh } = useApi<{ ok: boolean; problems: Array<{ kind: string; ref: string; detail: string }>; note: string }>('/admin/ledger/verify?limit=1000');
  return (
    <Panel>
      <SectionTitle hint={<button type="button" className="text-[11px] text-mint underline decoration-dotted" onClick={() => void refresh()}>re-run</button>}>
        Ledger integrity
      </SectionTitle>
      {loading ? <Loading label="Walking every journal" /> : null}
      {data?.ok ? (
        <div className="rounded-lg border border-mint/30 bg-mint/[0.05] p-3 text-[12.5px] text-mint">
          {data.problems.length === 0 ? 'Every journal balances, conversions tie out, and wallet balances match customer liabilities.' : '—'}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {(data?.problems ?? []).map((p, i) => (
            <li key={i} className="rounded-lg border border-rose/35 bg-rose/[0.06] px-3 py-2 text-[12px] text-rose">
              <span className="money">{p.kind}</span> [{p.ref}] — {p.detail}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">{data?.note}</p>
    </Panel>
  );
}

function AuditTab() {
  const { data } = useApi<{ entries: Array<Record<string, unknown>> }>('/admin/audit?limit=60');
  return (
    <Panel className="!p-0">
      <div className="px-5 pt-4">
        <SectionTitle hint={<span className="text-[11px] text-ink-faint">append-only, including operator reads of other people&rsquo;s money</span>}>Audit trail</SectionTitle>
      </div>
      <ul className="divide-y divide-hair/60">
        {(data?.entries ?? []).map((e) => (
          <li key={String(e.id)} className="flex flex-wrap items-baseline gap-x-3 px-5 py-2 text-[12px]">
            <span className="money text-[11px] text-ink-faint">{when(String(e.at))}</span>
            <Badge tone={String(e.actorType) === 'ADMIN' ? 'warn' : String(e.actorType) === 'SYSTEM' ? 'neutral' : 'ok'}>{String(e.actorType)}</Badge>
            <span className="text-ink">{String(e.action)}</span>
            <span className="text-ink-faint">{e.targetType ? `${String(e.targetType)}:${String(e.targetId ?? '')}` : ''}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
