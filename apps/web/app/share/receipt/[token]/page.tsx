'use client';

import { useParams } from 'next/navigation';
import { Badge, Brand, ErrorNote, KV, Panel, SimulatedTag } from '../../../../components/ui';
import { useApi } from '../../../../lib/useApi';
import { kes } from '../../../../lib/format';

/** Read-only share view: no account ids, no balances, and a link that expires. */
export default function SharedReceiptPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? null;
  const { data, error, loading } = useApi<Record<string, never>>(token ? `/receipts/shared/${token}` : null);
  const p = data as unknown as {
    reference?: string;
    issuedAt?: string;
    status?: string;
    mode?: string;
    payer?: { label?: string };
    recipient?: { name?: string; handle?: string; railLabel?: string };
    amounts?: { recipientAmountFormatted?: string; totalDebitFormatted?: string; cryptoAsset?: string };
    contentSha256?: string;
    legal?: string;
  } | null;

  return (
    <div className="relative z-10 mx-auto max-w-[560px] px-5 py-12">
      <Brand />
      <h1 className="mt-5 font-display text-[24px] tracking-tight text-ink">Shared receipt</h1>
      {loading ? <p className="mt-3 text-[13px] text-ink-dim">Reading the document…</p> : null}
      <ErrorNote error={error ?? undefined} />
      {p ? (
        <Panel className="mt-4 p-5">
          <div className="flex items-center justify-between">
            <span className="money text-[12px] text-ink-dim">{p.reference}</span>
            <span className="flex items-center gap-2">
              <SimulatedTag text="sandbox" />
              <Badge tone="ok">{p.status?.toLowerCase()}</Badge>
            </span>
          </div>
          <dl className="mt-3">
            <KV k="Paid by" v={p.payer?.label ?? '—'} />
            <KV k="Received by" v={`${p.recipient?.name ?? '—'} · ${p.recipient?.handle ?? ''}`} />
            <KV k="Rail" v={p.recipient?.railLabel ?? '—'} />
            <KV k="Recipient received" v={p.amounts?.recipientAmountFormatted ?? kes('0')} mono />
            <KV k="Payer sent" v={`${p.amounts?.totalDebitFormatted ?? '—'} ${p.amounts?.cryptoAsset ?? ''}`} mono />
            <KV k="Issued" v={p.issuedAt ? new Date(p.issuedAt).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—'} />
            <KV k="Document hash" v={<span className="break-all text-[10.5px]">{p.contentSha256?.slice(0, 32)}…</span>} />
          </dl>
          <p className="mt-3 border-t border-hair pt-3 text-[10.5px] leading-relaxed text-ink-faint">{p.legal}</p>
        </Panel>
      ) : null}
    </div>
  );
}
