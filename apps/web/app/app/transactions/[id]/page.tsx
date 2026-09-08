'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, newKey } from '../../../../lib/api';
import { crypto as cryptoFmt, kes, when } from '../../../../lib/format';
import { useApi } from '../../../../lib/useApi';
import { usePayment } from '../../../../lib/usePayment';
import { Badge, ErrorNote, KV, Loading, Panel, SectionTitle, SimulatedTag } from '../../../../components/ui';
import { Stepper } from '../../../../components/Stepper';
import { Receipt } from '../../../../components/Receipt';
import { useSession } from '../../../../components/SessionProvider';

export default function TransactionPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? null;
  const { payment, loading, error, refresh } = usePayment(id);
  const { data: capability, refresh: refreshCap } = useApi<{ refundable: boolean; mode: string; reason: string; railLabel: string; partialAllowed: boolean; windowEndsAt: string | null }>(
    id ? `/payments/${id}/refund-capability` : null,
  );
  const { data: events } = useApi<{ events: Array<{ id: string; type: string; message: string | null; actor: string | null; at: string }> }>(
    id ? `/account/transactions/${id}/events` : null,
  );
  const { mode } = useSession();
  const [refundState, setRefundState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [refundError, setRefundError] = useState<unknown>(null);
  const [refund, setRefund] = useState<{ reference: string; state: string; detail: string } | null>(null);

  if (loading && !payment) return <div className="py-16"><Loading label="Loading the record" /></div>;
  if (error && !payment) return <div className="py-8"><ErrorNote error={error} onRetry={() => refresh()} /></div>;

  const showReceipt = Boolean(payment?.receiptId) && payment?.status === 'COMPLETED';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Badge tone={payment?.terminal ? (payment.status === 'FAILED' ? 'bad' : 'ok') : 'warn'}>{payment?.displayStatus}</Badge>
            {payment?.dataOrigin === 'sandbox' || mode === 'sandbox' ? <SimulatedTag text="sandbox record" /> : null}
          </div>
          <h1 className="mt-2 font-display text-[26px] tracking-tight text-ink">
            {kes(String(payment?.recipientAmountMinor ?? '0'))} <span className="text-ink-dim">·</span>{' '}
            <span className="money text-[18px] text-ink-dim">{payment?.reference}</span>
          </h1>
          <p className="mt-1 text-[12.5px] text-ink-dim">
            {String((payment?.recipient as { displayName?: string } | null)?.displayName ?? '')} · created {when(String(payment?.createdAt ?? ''))}
            {payment?.completedAt ? ` · settled ${when(String(payment.completedAt))}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {showReceipt ? (
            <Link href={`/receipts/print/${id}`} className="btn-ghost">
              Print or save as PDF
            </Link>
          ) : null}
          {!payment?.terminal ? (
            <Link href={`/app/processing/${id}`} className="btn-ghost">
              Watch settlement
            </Link>
          ) : null}
          {capability?.refundable && payment?.status === 'COMPLETED' ? (
            <button
              type="button"
              disabled={refundState !== 'idle'}
              className="btn-danger"
              onClick={async () => {
                setRefundState('busy');
                setRefundError(null);
                try {
                  const res = await api<{ reference: string; state: string; detail: string }>(`/payments/${id}/refund`, {
                    method: 'POST',
                    body: { reason: 'Refund requested by the payer from the activity screen.' },
                    headers: { 'idempotency-key': newKey('refund') },
                  });
                  setRefund(res);
                  setRefundState('done');
                  void refreshCap();
                } catch (e) {
                  setRefundError(e);
                  setRefundState('idle');
                }
              }}
            >
              {refundState === 'busy' ? 'Checking the rail…' : 'Request a refund'}
            </button>
          ) : null}
        </div>
      </div>

      {refund ? (
        <Panel className="border-mint/30 bg-mint/[0.05]">
          <div className="text-[13px] text-ink">Refund recorded as {refund.reference}</div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-dim">{refund.detail}</p>
        </Panel>
      ) : null}
      <ErrorNote error={refundError} />

      {capability && !capability.refundable && payment?.status === 'COMPLETED' ? (
        <div className="text-[11.5px] leading-relaxed text-ink-faint">
          No refund on this payment: {capability.reason} <span className="text-ink-dim">({capability.railLabel})</span>
        </div>
      ) : null}

      {showReceipt ? <Receipt paymentId={id!} /> : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_.85fr]">
        <Panel>
          <SectionTitle hint={<span className="text-[11px] text-ink-faint">as recorded, in order</span>}>Settlement trail</SectionTitle>
          {payment?.steps?.length ? <Stepper steps={payment.steps} status={String(payment.status)} simulated /> : <Loading label="Reading steps" />}
        </Panel>

        <div className="space-y-4">
          <Panel>
            <SectionTitle>Money</SectionTitle>
            <dl>
              <KV k="Recipient received" v={kes(String(payment?.recipientAmountMinor ?? '0'))} mono />
              <KV k="You sent" v={`${cryptoFmt(String(payment?.totalDebitMinor ?? '0'), String(payment?.asset ?? 'USDT'))} ${String(payment?.asset ?? '')}`} mono />
              <KV k="Crypto leg" v={cryptoFmt(String(payment?.cryptoAmountMinor ?? '0'), String(payment?.asset ?? 'USDT'))} mono />
              <KV k="Network fee" v={cryptoFmt(String(payment?.networkFeeMinor ?? '0'), String(payment?.asset ?? 'USDT'))} mono />
              <KV k="AuraPay fee" v={kes(String(payment?.serviceFeeMinor ?? '0'))} mono />
              <KV k="Rail" v={`${String(payment?.rail ?? '')} · ${String((payment?.payout as { provider?: string } | null)?.provider ?? '')}`} />
            </dl>
          </Panel>

          <Panel>
            <SectionTitle hint={<span className="text-[11px] text-ink-faint">{events?.events.length ?? 0} entries</span>}>Event log</SectionTitle>
            <ul className="max-h-[280px] space-y-2 overflow-y-auto pr-1">
              {(events?.events ?? []).map((e) => (
                <li key={e.id} className="border-l border-hair pl-2.5">
                  <div className="text-[12px] text-ink">{e.message ?? e.type}</div>
                  <div className="text-[10.5px] text-ink-faint">
                    {e.type} · {e.actor ?? 'system'} · {when(e.at)}
                  </div>
                </li>
              ))}
              {!events?.events.length ? <li className="text-[12px] text-ink-faint">No events recorded yet.</li> : null}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
