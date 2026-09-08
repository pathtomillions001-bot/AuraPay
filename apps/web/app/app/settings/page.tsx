'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
import { useApi } from '../../../lib/useApi';
import { useSession } from '../../../components/SessionProvider';
import { Badge, ErrorNote, KV, Panel, SectionTitle, SimulatedTag } from '../../../components/ui';
import { kes } from '../../../lib/format';

export default function SettingsPage() {
  const { user, mode, refresh } = useSession();
  const { data: limits } = useApi<{ tier: number; perPaymentKes: number; dailyKes: number; overrideActive: boolean } | null>('/account/limits');
  const { data: sessions } = useApi<{ sessions: Array<{ id: string; ip: string | null; userAgent: string | null; lastSeenAt: string; current?: boolean }>; devices: Array<{ id: string; name: string | null; lastSeenAt: string }> }>(
    '/auth/sessions',
  );
  const { data: balances, refresh: refreshBalances } = useApi<{ wallets: Array<{ asset: string; network: string; availableMinor: string }> }>('/account/balances');
  const [topUp, setTopUp] = useState({ asset: 'USDT', network: 'TRON', amountMajor: '500' });
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel>
        <SectionTitle hint={<Badge tone="neutral">{user?.kycStatus.toLowerCase()}</Badge>}>Account and limits</SectionTitle>
        <dl>
          <KV k="Name" v={user?.fullName ?? '—'} />
          <KV k="Email" v={user?.email ?? '—'} />
          <KV k="Phone" v={user?.phone ?? 'not on file'} />
          <KV k="Country" v={user?.country ?? '—'} />
          <KV k="Roles" v={(user?.roles ?? []).join(', ') || 'customer'} />
          <KV k="Two-factor" v={user?.twoFactorEnabled ? <Badge tone="ok">enabled</Badge> : <Badge tone="warn">off</Badge>} />
          <KV k="KYC tier" v={`tier ${limits?.tier ?? user?.kycTier ?? 0}${limits?.overrideActive ? ' (with an operator override)' : ''}`} />
          <KV k="Per payment" v={limits ? kes(`${limits.perPaymentKes * 100}`) : '—'} mono />
          <KV k="Per day" v={limits ? kes(`${limits.dailyKes * 100}`) : '—'} mono />
        </dl>
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
          Limits come from your verification tier in the database, not from the page. {mode === 'sandbox' ? 'The sandbox raises them for the demo; a live account must verify documents first.' : ''}
        </p>
      </Panel>

      <Panel>
        <SectionTitle hint={<span className="text-[11px] text-ink-faint">sessions are httpOnly cookies; the token is never readable from JS</span>}>
          Where you are signed in
        </SectionTitle>
        <ul className="divide-y divide-hair/70">
          {(sessions?.sessions ?? []).map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-[12.5px] text-ink">{s.userAgent ?? 'unknown client'}</div>
                <div className="text-[11px] text-ink-faint">
                  {s.ip ?? 'no ip recorded'} · last seen {new Date(s.lastSeenAt).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })}
                </div>
              </div>
              {s.current ? <Badge tone="ok">this device</Badge> : null}
            </li>
          ))}
          {!sessions?.sessions.length ? <li className="py-4 text-[12px] text-ink-faint">No other sessions.</li> : null}
        </ul>
      </Panel>

      {mode === 'sandbox' ? (
        <Panel className="border-amber/25 bg-amber/[0.04]">
          <SectionTitle
            hint={
              <span className="flex items-center gap-1">
                <SimulatedTag text="sandbox control" />
              </span>
            }
          >
            Fund this demo account
          </SectionTitle>
          <p className="text-[12px] leading-relaxed text-ink-dim">
            Credits your custody wallet and writes a ledger journal, so the balance you see afterwards is backed by an entry like any other. It does not
            create a chain transaction, and it is refused outright in production mode.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <select className="input" value={topUp.asset} onChange={(e) => setTopUp({ ...topUp, asset: e.target.value })}>
              {['USDT', 'USDC', 'BTC', 'ETH'].map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <select className="input" value={topUp.network} onChange={(e) => setTopUp({ ...topUp, network: e.target.value })}>
              <option value="TRON">Tron</option>
              <option value="ETHEREUM">Ethereum</option>
              <option value="BITCOIN">Bitcoin</option>
              <option value="SOLANA">Solana</option>
            </select>
            <input className="money input" value={topUp.amountMajor} onChange={(e) => setTopUp({ ...topUp, amountMajor: e.target.value.replace(/[^0-9.]/g, '') })} />
            <button
              type="button"
              className="btn-primary"
              onClick={async () => {
                setError(null);
                setNote(null);
                try {
                  const res = await api<{ availableMinor: string }>('/sandbox/top-up', { method: 'POST', body: topUp });
                  setNote(`Balance now ${res.availableMinor} ${topUp.asset} minor units.`);
                  await refreshBalances();
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Credit
            </button>
          </div>
          {note ? <p className="mt-2 text-[11.5px] text-mint">{note}</p> : null}
          <ErrorNote error={error} />
          <div className="mt-3 text-[11.5px] text-ink-faint">
            current: {(balances?.wallets ?? []).map((w) => `${w.asset} ${w.availableMinor.slice(0, 6)}…`).join(' · ') || '—'}
          </div>
        </Panel>
      ) : null}

      <Panel>
        <SectionTitle hint={<span className="text-[11px] text-ink-faint">this is what a session reset looks like</span>}>Security actions</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={async () => {
              await api('/auth/logout', { method: 'POST' });
              await refresh();
            }}
          >
            Sign out of this device
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={async () => {
              setError(null);
              try {
                await api('/auth/sessions/revoke-others', { method: 'POST' });
                await refresh();
              } catch (e) {
                setError(e);
              }
            }}
          >
            Sign out everywhere
          </button>
        </div>
        <ErrorNote error={error} />
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
          Passkey and TOTP enrolment live behind the same endpoints the API exposes; this build refuses passkeys with an explicit
          “not configured” error rather than pretending the ceremony worked.
        </p>
      </Panel>
    </div>
  );
}
