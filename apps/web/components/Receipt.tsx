'use client';

import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { Badge, ErrorNote, KV, Panel, SectionTitle, SimulatedTag } from './ui';

export interface ReceiptPayload {
  document: string;
  version: number;
  receiptId: string;
  reference: string;
  shortReference: string;
  issuedAt: string;
  mode: string;
  dataOrigin: string;
  status: string;
  payer: { label: string; email: string | null };
  recipient: { name: string | null; verified: boolean; handle: string; railLabel: string };
  amounts: {
    recipientAmountFormatted: string;
    recipientCurrency: string;
    cryptoFormatted: string;
    cryptoAsset: string;
    networkFeeMinor: string;
    platformFeeKesMinor: string;
    railFeeFormatted: string;
    totalDebitFormatted: string;
    network: string;
  };
  rates: { midRateFormatted: string; appliedRateFormatted: string; spreadBps: number; spreadNote: string };
  rail: { provider: string; providerDisplayName: string; localReference: string | null; submittedAt: string | null; confirmedAt: string | null };
  blockchain: { txHash: string | null; confirmations: number; confirmationsRequired: number; detectedAt: string | null; finalizedAt: string | null; explorer: string | null };
  timeline: Array<{ state: string; at: string }>;
  refund: { id: string; status: string; amountMinor: string; requestedAt: string; completedAt: string | null; note: string | null } | null;
  legal: string;
  contentSha256: string;
}

/**
 * The receipt is rendered from the API's payload — every figure below is a string the
 * server formatted, and the hash is computed over that same object. The client does no
 * money arithmetic, so what you read, what prints and what verifies cannot drift apart.
 */
export function Receipt({ paymentId, embedded = true }: { paymentId: string; embedded?: boolean }) {
  const { data, error } = useApi<{ payload: ReceiptPayload; integrity: string }>(`/payments/${paymentId}/receipt?format=json`);
  const [share, setShare] = useState<{ url: string; expiresAt: string } | null>(null);
  const [shareError, setShareError] = useState<unknown>(null);
  if (error) return <ErrorNote error={error} />;
  const p = data?.payload;
  if (!p) return null;

  const stamp = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  return (
    <Panel className={embedded ? '' : '!border-0 !bg-transparent !shadow-none'}>
      <SectionTitle
        hint={
          <span className="flex items-center gap-2">
            {p.dataOrigin === 'sandbox' ? <SimulatedTag text="sandbox document" /> : null}
            <Badge tone="neutral">{p.mode}</Badge>
            <span className="money text-[11px] text-ink-faint">{p.reference}</span>
          </span>
        }
      >
        Receipt · {p.shortReference}
      </SectionTitle>

      <dl>
        <KV k="Issued" v={stamp(p.issuedAt)} />
        <KV k="From" v={`${p.payer.label}${p.payer.email ? ` · ${p.payer.email}` : ''}`} />
        <KV k="To" v={`${p.recipient.name ?? '—'} · ${p.recipient.handle}`} />
        <KV
          k="Recipient name check"
          v={p.recipient.verified ? <Badge tone="ok">verified</Badge> : <Badge tone="warn">unverified</Badge>}
        />
        <KV k="Rail" v={p.recipient.railLabel} />
        <KV k="Recipient received" v={p.amounts.recipientAmountFormatted} mono />
        <KV k="You sent" v={`${p.amounts.totalDebitFormatted} ${p.amounts.cryptoAsset}`} mono />
        <KV k="Crypto delivered to custody" v={`${p.amounts.cryptoFormatted} ${p.amounts.cryptoAsset} on ${p.amounts.network}`} mono />
        <KV k="AuraPay fee" v={p.amounts.railFeeFormatted} mono />
        <KV k="Rate applied" v={`${p.rates.appliedRateFormatted} Ksh`} mono />
        <KV k="Mid-market at the time" v={`${p.rates.midRateFormatted} Ksh`} mono />
        <KV k="Rail reference" v={p.rail.localReference ?? '—'} mono />
        <KV k="Payout confirmed" v={stamp(p.rail.confirmedAt)} />
        <KV
          k="Chain evidence"
          v={
            p.blockchain.txHash ? (
              <span title={p.blockchain.txHash}>
                {p.blockchain.confirmations}/{p.blockchain.confirmationsRequired} confirmations
              </span>
            ) : (
              '—'
            )
          }
          mono
        />
      </dl>

      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-dim">{p.rates.spreadNote}</p>

      {p.refund ? (
        <div className="mt-3 rounded-lg border border-hair bg-slate-950/50 p-3 text-[12px]">
          <div className="text-ink">Refund {p.refund.status.toLowerCase().replace(/_/g, ' ')}</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-dim">
            {p.refund.note ?? 'No note recorded.'} · requested {stamp(p.refund.requestedAt)}
          </div>
        </div>
      ) : null}

      <div className="mt-3 rounded-lg border border-hair bg-slate-950/50 p-3">
        <div className="label">Integrity</div>
        <div className="money mt-1 break-all text-[11px] leading-relaxed text-ink-dim">sha256 {data?.integrity}</div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
          Recompute the hash over this receipt payload and it must match. Edit any number in a copy of this document and it stops matching — that is
          the only purpose the field has.
        </p>
      </div>

      {embedded ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a className="btn-ghost !py-1.5 text-[12px]" href={`/v1/payments/${paymentId}/receipt?format=txt`}>
              Download plain text
            </a>
            <a className="btn-ghost !py-1.5 text-[12px]" href={`/receipts/print/${paymentId}`}>
              Print view
            </a>
            <button
              type="button"
              className="btn-ghost !py-1.5 text-[12px]"
              onClick={async () => {
                setShareError(null);
                try {
                  const res = await api<{ url: string; expiresAt: string }>(`/payments/${paymentId}/receipt/share`, { method: 'POST', body: { days: 7 } });
                  setShare({ url: res.url, expiresAt: res.expiresAt });
                } catch (e) {
                  setShareError(e);
                }
              }}
            >
              Create expiring share link
            </button>
            {share ? (
              <span className="text-[11.5px] text-ink-dim">
                <span className="money break-all">{share.url}</span> · expires {stamp(share.expiresAt)}
              </span>
            ) : null}
          </div>
          <ErrorNote error={shareError} />
        </>
      ) : null}

      <details className="mt-3">
        <summary className="cursor-pointer text-[11.5px] text-ink-dim">Settlement timeline ({p.timeline.length})</summary>
        <ul className="mt-2 space-y-1">
          {p.timeline.map((t, i) => (
            <li key={`${t.state}-${i}`} className="flex justify-between gap-4 text-[11.5px] text-ink-faint">
              <span>{t.state.replace(/_/g, ' ').toLowerCase()}</span>
              <span className="money">{stamp(t.at)}</span>
            </li>
          ))}
        </ul>
      </details>

      <p className="mt-3 border-t border-hair pt-3 text-[10.5px] leading-relaxed text-ink-faint">{p.legal}</p>
    </Panel>
  );
}
