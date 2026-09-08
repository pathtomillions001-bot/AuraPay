'use client';

import Link from 'next/link';
import { useState } from 'react';
import { crypto as cryptoFmt, kes, when } from '../../../lib/format';
import { useApi } from '../../../lib/useApi';
import { Badge, ErrorNote, Loading, Panel, SectionTitle } from '../../../components/ui';

interface Row {
  id: string;
  reference: string;
  status: string;
  displayStatus: string;
  direction: string;
  asset: string;
  rail: string;
  recipientAmountMinor: string;
  totalDebitMinor: string;
  createdAt: string;
  terminal: boolean;
  progress: number;
  dataOrigin?: string;
  recipient?: { displayName?: string | null; phone?: string | null } | null;
}

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'status=COMPLETED', label: 'Settled' },
  { key: 'status=FAILED', label: 'Failed' },
  { key: 'status=AWAITING_PAYMENT', label: 'Awaiting deposit' },
];

export default function TransactionsPage() {
  const [filter, setFilter] = useState('');
  const { data, error, loading, refresh } = useApi<{ items: Row[]; total: number }>(`/payments?limit=40${filter ? `&${filter}` : ''}`, {
    pollMs: 15_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="label">Activity</div>
          <h1 className="mt-1 font-display text-[26px] tracking-tight text-ink">Every payment, with its record</h1>
          <p className="mt-1 text-[12.5px] text-ink-dim">
            {data ? `${data.total} item${data.total === 1 ? '' : 's'} in this view · each row links to its journals, receipt and payout evidence` : '…'}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3 py-1 text-[12px] transition ${
                filter === f.key ? 'border-mint/50 bg-mint/10 text-mint' : 'border-hair bg-slate-950/60 text-ink-dim hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <ErrorNote error={error} onRetry={() => void refresh()} />

      <Panel className="!p-0">
        <SectionTitle>
          <span className="sr-only">Payments</span>
        </SectionTitle>
        {loading && !data ? (
          <div className="px-5 pb-5">
            <Loading label="Loading activity" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr className="border-b border-hair text-left">
                  {['Reference', 'Recipient', 'Amount out', 'You paid', 'Rail', 'State', 'When'].map((h) => (
                    <th key={h} className="label px-4 py-2.5 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-hair/60">
                {(data?.items ?? []).map((r) => (
                  <tr key={r.id} className="row-hover">
                    <td className="px-4 py-2.5">
                      <Link href={`/app/transactions/${r.id}`} className="money text-[12px] text-ink underline decoration-dotted decoration-hair hover:decoration-mint">
                        {r.reference}
                      </Link>
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-2.5 text-ink-dim">{r.recipient?.displayName ?? r.recipient?.phone ?? '—'}</td>
                    <td className="money px-4 py-2.5 text-ink">{kes(r.recipientAmountMinor)}</td>
                    <td className="money px-4 py-2.5 text-ink-dim">
                      {cryptoFmt(r.totalDebitMinor, r.asset)} {r.asset}
                    </td>
                    <td className="px-4 py-2.5 text-ink-dim">{r.rail}</td>
                    <td className="px-4 py-2.5">
                      {r.terminal ? (
                        <Badge tone={r.status === 'FAILED' ? 'bad' : r.status === 'REFUNDED' ? 'neutral' : 'ok'}>{r.displayStatus}</Badge>
                      ) : (
                        <Badge tone="warn">
                          {r.displayStatus} · {Math.round(r.progress * 100)}%
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-ink-faint">{when(r.createdAt)}</td>
                  </tr>
                ))}
                {!data?.items.length ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-[12.5px] text-ink-faint">
                      Nothing here yet.{' '}
                      <Link href="/app/pay" className="text-mint underline decoration-dotted">
                        Make a payment
                      </Link>{' '}
                      and it will appear in this table the moment it is created.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
