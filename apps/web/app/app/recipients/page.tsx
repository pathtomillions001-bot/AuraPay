'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
import { useApi } from '../../../lib/useApi';
import { Badge, ErrorNote, Panel, SectionTitle } from '../../../components/ui';
import { kes, when } from '../../../lib/format';

interface Recipient {
  id: string;
  kind: string;
  displayName: string;
  phone: string | null;
  till: string | null;
  paybill: string | null;
  rail: string;
  favourite: boolean;
  defaultAmountMinor: string | null;
  verification: { verified: boolean; name: string | null; source: string; at: string };
}

/**
 * Saving a recipient runs name resolution immediately, because a payment that goes
 * to the wrong number is the failure this screen exists to prevent. A number the
 * rail cannot resolve is stored but labelled — never silently accepted.
 */
export default function RecipientsPage() {
  const { data, refresh } = useApi<{ recipients: Recipient[] }>('/recipients');
  const [form, setForm] = useState({ kind: 'PHONE', displayName: '', phone: '', till: '', paybill: '', accountReference: '', note: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState<{ verified: boolean; name: string | null; source: string } | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ recipient: Recipient; nameLookup: { verified: boolean; name: string | null; source: string } }>('/recipients', {
        method: 'POST',
        body: {
          kind: form.kind,
          displayName: form.displayName,
          phone: form.phone || undefined,
          till: form.till || undefined,
          paybill: form.paybill || undefined,
          accountReference: form.accountReference || undefined,
          note: form.note || undefined,
          country: 'KE',
        },
      });
      setLookup(res.nameLookup);
      setForm({ ...form, displayName: '', phone: '', till: '', paybill: '', accountReference: '', note: '' });
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_.8fr]">
      <Panel>
        <SectionTitle hint={<span className="text-[11px] text-ink-faint">{data?.recipients.length ?? 0} saved</span>}>Saved recipients</SectionTitle>
        <ul className="divide-y divide-hair/70">
          {(data?.recipients ?? []).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] text-ink">{r.displayName}</span>
                  {r.favourite ? <Badge tone="neutral">favourite</Badge> : null}
                </div>
                <div className="text-[11.5px] text-ink-faint">
                  {r.phone ?? r.till ?? r.paybill} · {r.rail}
                  {r.defaultAmountMinor ? ` · usually ${kes(r.defaultAmountMinor)}` : ''} · checked {when(r.verification.at)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {r.verification.verified ? (
                  <Badge tone="ok" title={`Resolved via ${r.verification.source}`}>{r.verification.name ?? 'matched'}</Badge>
                ) : (
                  <Badge tone="warn">unverified</Badge>
                )}
                <button
                  type="button"
                  className="text-[11.5px] text-ink-dim underline decoration-dotted hover:text-ink"
                  onClick={async () => {
                    await api(`/recipients/${r.id}`, { method: 'DELETE' });
                    await refresh();
                  }}
                >
                  remove
                </button>
              </div>
            </li>
          ))}
          {!data?.recipients.length ? <li className="py-6 text-center text-[12.5px] text-ink-faint">No saved recipients.</li> : null}
        </ul>
      </Panel>

      <Panel>
        <SectionTitle>Add a recipient</SectionTitle>
        <form onSubmit={save} className="space-y-3">
          <label className="block">
            <span className="label">Type</span>
            <select className="input mt-1.5" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="PHONE">Phone (M-Pesa)</option>
              <option value="TILL">Buy-goods till</option>
              <option value="PAYBILL">PayBill with account ref</option>
            </select>
          </label>
          <label className="block">
            <span className="label">Display name</span>
            <input className="input mt-1.5" required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          {form.kind !== 'TILL' ? (
            <label className="block">
              <span className="label">{form.kind === 'PHONE' ? 'Phone number' : 'PayBill number'}</span>
              <input
                className="money input mt-1.5"
                value={form.kind === 'PHONE' ? form.phone : form.paybill}
                onChange={(e) =>
                  setForm(form.kind === 'PHONE' ? { ...form, phone: e.target.value } : { ...form, paybill: e.target.value })
                }
                placeholder={form.kind === 'PHONE' ? '07XX XXX XXX' : '400200'}
              />
            </label>
          ) : (
            <label className="block">
              <span className="label">Till number</span>
              <input className="money input mt-1.5" value={form.till} onChange={(e) => setForm({ ...form, till: e.target.value })} placeholder="12345" />
            </label>
          )}
          {form.kind === 'PAYBILL' ? (
            <label className="block">
              <span className="label">Account reference</span>
              <input className="input mt-1.5" value={form.accountReference} onChange={(e) => setForm({ ...form, accountReference: e.target.value })} />
            </label>
          ) : null}
          <label className="block">
            <span className="label">Note (only you see this)</span>
            <input className="input mt-1.5" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>

          <ErrorNote error={error} />
          {lookup ? (
            <div className={`rounded-lg border p-3 text-[12px] leading-relaxed ${lookup.verified ? 'border-mint/30 bg-mint/[0.05] text-mint' : 'border-amber/30 bg-amber/[0.05] text-amber'}`}>
              {lookup.verified
                ? `Registered name: ${lookup.name}. Source: ${lookup.source}.`
                : `The rail could not resolve a name for this destination (source: ${lookup.source}). You can still pay it, but the payment screen will ask you to confirm the name.`}
            </div>
          ) : null}
          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? 'Saving…' : 'Save recipient'}
          </button>
        </form>
      </Panel>
    </div>
  );
}
