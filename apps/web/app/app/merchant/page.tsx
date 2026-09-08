'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
import { useApi } from '../../../lib/useApi';
import { Badge, ErrorNote, KV, Loading, Panel, SectionTitle, SimulatedTag } from '../../../components/ui';
import { when } from '../../../lib/format';

interface Business {
  id: string;
  name: string;
  legalName: string | null;
  status: string;
  kybStatus: string;
  settlementRail: string;
  till: string | null;
  paybill: string | null;
}

interface LinkRow {
  id: string;
  token: string;
  title: string;
  amountFormatted: string | null;
  status: string;
  uses: number;
  maxUses: number | null;
  collectedFormatted: string;
  expiresAt: string | null;
}

export default function MerchantPage() {
  const { data, loading, refresh, error: loadError } = useApi<{ businesses: Business[] }>('/businesses');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({ title: '', amountKesMajor: '2500', expiresInHours: '72', maxUses: '1' });
  const [qr, setQr] = useState<{ dataUrl: string; payload: string; code: string; methods: string[] } | null>(null);
  const [onboard, setOnboard] = useState({ name: '', legalName: '', till: '', paybill: '' });
  const [busyOnboard, setBusyOnboard] = useState(false);

  const businessId = selected ?? data?.businesses[0]?.id ?? null;
  const { data: detail } = useApi<{ dashboard: Record<string, unknown> } | null>(businessId ? `/businesses/${businessId}` : null);
  const { data: linkData, refresh: refreshLinks } = useApi<{ links: LinkRow[] } | null>(businessId ? `/businesses/${businessId}/links` : null);

  if (loading) return <Loading label="Loading business accounts" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="label">Business</div>
          <h1 className="mt-1 font-display text-[26px] tracking-tight text-ink">Collect without touching a key</h1>
          <p className="mt-1 max-w-[66ch] text-[12.5px] leading-relaxed text-ink-dim">
            A link or one printed QR carries the destination, never the rail: the payer chooses M-Pesa, a till, a PayBill or a bank. A link is a
            request for money — nothing a storefront can see is able to pull funds from a wallet.
          </p>
        </div>
        <Badge tone="warn" title="KYB and settlement figures are simulated in this build">sandbox merchant</Badge>
      </div>

      <ErrorNote error={loadError ?? undefined} />

      <div className="grid gap-3 sm:grid-cols-2">
        {(data?.businesses ?? []).map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => setSelected(b.id)}
            className={`panel p-4 text-left transition ${businessId === b.id ? '!border-mint/50' : 'hover:!border-ink-faint'}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14px] text-ink">{b.name}</span>
              <Badge tone={b.kybStatus === 'APPROVED' ? 'ok' : 'warn'}>{b.kybStatus.toLowerCase().replace(/_/g, ' ')}</Badge>
            </div>
            <div className="mt-1 text-[11.5px] text-ink-faint">
              {b.settlementRail}
              {b.till ? ` · till ${b.till}` : ''}
              {b.paybill ? ` · paybill ${b.paybill}` : ''}
            </div>
          </button>
        ))}
        {!data?.businesses.length ? (
          <Panel className="sm:col-span-2">
            <SectionTitle>Create a business account</SectionTitle>
            <form
              className="grid gap-2.5 sm:grid-cols-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusyOnboard(true);
                setError(null);
                try {
                  await api('/businesses', { method: 'POST', body: onboard });
                  await refresh();
                } catch (err) {
                  setError(err);
                } finally {
                  setBusyOnboard(false);
                }
              }}
            >
              <label className="block">
                <span className="label">Trading name</span>
                <input className="input mt-1" required value={onboard.name} onChange={(e) => setOnboard({ ...onboard, name: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">Registered name</span>
                <input className="input mt-1" value={onboard.legalName} onChange={(e) => setOnboard({ ...onboard, legalName: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">Till (optional, 5 digits)</span>
                <input className="money input mt-1" value={onboard.till} onChange={(e) => setOnboard({ ...onboard, till: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">PayBill (optional)</span>
                <input className="money input mt-1" value={onboard.paybill} onChange={(e) => setOnboard({ ...onboard, paybill: e.target.value })} />
              </label>
              <button className="btn-primary sm:col-span-2" disabled={busyOnboard} type="submit">
                {busyOnboard ? 'Creating…' : 'Create business account'}
              </button>
              <p className="text-[11px] leading-relaxed text-ink-faint sm:col-span-2">
                A business is a separate subject with its own settlement account, so its money is never mixed into a personal balance, and its KYB
                state is tracked apart from your own verification.
              </p>
            </form>
            <ErrorNote error={error} />
          </Panel>
        ) : null}
      </div>

      {businessId ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_.9fr]">
          <Panel>
            <SectionTitle hint={<SimulatedTag text="sandbox figures" />}>Settlement summary</SectionTitle>
            <dl>
              {Object.entries((detail?.dashboard ?? {}) as Record<string, unknown>)
                .filter(([, v]) => v === null || ['number', 'string'].includes(typeof v))
                .slice(0, 12)
                .map(([k, v]) => (
                  <KV
                    key={k}
                    k={k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}
                    v={typeof v === 'number' ? v.toLocaleString('en-KE') : String(v ?? '—')}
                    mono
                  />
                ))}
            </dl>
          </Panel>

          <Panel>
            <SectionTitle>New payment link</SectionTitle>
            <form
              className="space-y-2.5"
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                try {
                  await api(`/businesses/${businessId}/links`, {
                    method: 'POST',
                    body: {
                      title: form.title || 'Payment',
                      amountKesMajor: Number(form.amountKesMajor),
                      expiresInHours: Number(form.expiresInHours),
                      maxUses: Number(form.maxUses),
                    },
                  });
                  await refreshLinks();
                } catch (err) {
                  setError(err);
                }
              }}
            >
              <input className="input" placeholder="What is this for?" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              <div className="grid grid-cols-3 gap-2">
                <label className="block">
                  <span className="label">KES</span>
                  <input className="money input mt-1" value={form.amountKesMajor} onChange={(e) => setForm({ ...form, amountKesMajor: e.target.value })} />
                </label>
                <label className="block">
                  <span className="label">Hours</span>
                  <input className="money input mt-1" value={form.expiresInHours} onChange={(e) => setForm({ ...form, expiresInHours: e.target.value })} />
                </label>
                <label className="block">
                  <span className="label">Uses</span>
                  <input className="money input mt-1" value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} />
                </label>
              </div>
              <button className="btn-primary w-full" type="submit">
                Create link
              </button>
            </form>
            <ErrorNote error={error} />

            <ul className="mt-3 space-y-2">
              {(linkData?.links ?? []).slice(0, 6).map((l) => (
                <li key={l.id} className="rounded-lg border border-hair bg-slate-950/50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12.5px] text-ink">{l.title}</span>
                    <Badge tone={l.status === 'ACTIVE' ? 'ok' : 'neutral'}>{l.status.toLowerCase()}</Badge>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                    <span className="money">{l.amountFormatted ?? 'payer chooses'}</span>
                    <span>
                      {l.uses}
                      {l.maxUses ? `/${l.maxUses}` : ''} used · {l.collectedFormatted} collected
                    </span>
                    {l.expiresAt ? <span>expires {when(l.expiresAt)}</span> : null}
                    <a href={`/checkout/${l.token}`} className="text-mint underline decoration-dotted">
                      open
                    </a>
                    <button
                      type="button"
                      className="text-mint underline decoration-dotted"
                      onClick={async () => {
                        const res = await api<{ dataUrl: string; payload: string; code: string; methods: string[] }>(`/businesses/${businessId}/qr`, {
                          method: 'POST',
                          body: { kind: 'LINK', paymentLinkId: l.id, label: l.title },
                        });
                        setQr(res);
                      }}
                    >
                      QR
                    </button>
                    <button
                      type="button"
                      className="underline decoration-dotted"
                      onClick={async () => {
                        await api(`/businesses/${businessId}/links/${l.id}`, { method: 'DELETE' });
                        await refreshLinks();
                      }}
                    >
                      revoke
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      ) : null}

      {qr ? (
        <Panel>
          <SectionTitle hint={<span className="text-[11px] text-ink-faint">{qr.methods.join(' · ')}</span>}>Multi-method code</SectionTitle>
          <div className="flex flex-wrap items-center gap-4">
            <img src={qr.dataUrl} width={176} height={176} alt="Payment QR code" className="rounded-lg border border-hair" />
            <div className="min-w-[220px] flex-1">
              <p className="text-[12.5px] leading-relaxed text-ink-dim">
                One printed code, several ways to pay. The payer&rsquo;s app picks the rail; the code only carries the destination and the assets you
                accept.
              </p>
              <div className="money mt-2 break-all text-[11px] text-ink-faint">{qr.payload}</div>
              <div className="mt-2 text-[11px] text-ink-faint">
                short code <span className="money text-ink">{qr.code}</span>
              </div>
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
