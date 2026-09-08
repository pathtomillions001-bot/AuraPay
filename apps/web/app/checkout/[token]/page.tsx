'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, newKey } from '../../../lib/api';
import { useApi } from '../../../lib/useApi';
import { Badge, Brand, ErrorNote, KV, Loading, Panel, SimulatedTag } from '../../../components/ui';
import { useSession } from '../../../components/SessionProvider';

interface Checkout {
  linkId: string;
  title: string;
  description: string | null;
  amountMinor: string | null;
  amountFormatted: string | null;
  currency: string;
  merchant: { name: string; merchantCode: string } | null;
  rail: string;
  expired: boolean;
  expiresAt: string | null;
  simulated: boolean;
}

export default function CheckoutPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? null;
  const { data, loading, error } = useApi<Checkout>(token ? `/checkout/${token}` : null, { pollMs: 20_000 });
  const { user } = useSession();
  const [paying, setPaying] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);

  return (
    <div className="relative z-10 mx-auto flex min-h-screen max-w-[560px] flex-col justify-center px-5 py-10">
      <div className="mb-6">
        <Brand />
      </div>
      <ErrorNote error={error ?? undefined} />
      {loading ? <Loading label="Loading the payment request" /> : null}
      {data ? (
        <Panel className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="label">{data.merchant?.name ?? 'AuraPay merchant'}</div>
              <h1 className="mt-1.5 font-display text-[24px] leading-tight text-ink">{data.title}</h1>
              {data.description ? <p className="mt-1 text-[12.5px] leading-relaxed text-ink-dim">{data.description}</p> : null}
            </div>
            {data.expired ? <Badge tone="bad">expired</Badge> : <Badge tone="ok">awaiting payment</Badge>}
          </div>

          <div className="mt-5 rounded-lg border border-hair bg-slate-950/60 p-4">
            <div className="label">Amount</div>
            <div className="money mt-1 text-[26px] leading-none text-ink">{data.amountFormatted ?? 'you choose'}</div>
            <div className="mt-1.5 text-[11.5px] text-ink-faint">
              settled to the merchant on {data.rail}
              {data.expiresAt ? ` · this request stops accepting payments ${new Date(data.expiresAt).toLocaleDateString('en-KE', { dateStyle: 'medium' })}` : ''}
              <SimulatedTag text="sandbox" />
            </div>
          </div>

          <dl className="mt-4">
            <KV k="Merchant code" v={data.merchant?.merchantCode ?? '—'} mono />
            <KV k="Link" v={token ?? '—'} mono />
          </dl>

          {!user ? (
            <Link href={`/signin?next=/checkout/${token}`} className="btn-primary mt-5 w-full">
              Sign in to pay
            </Link>
          ) : paymentId ? (
            <Link href={`/app/processing/${paymentId}`} className="btn-primary mt-5 w-full">
              Watch this settle →
            </Link>
          ) : (
            <button
              type="button"
              disabled={data.expired || paying}
              className="btn-primary mt-5 w-full"
              onClick={async () => {
                setPaying(true);
                setSubmitError(null);
                try {
                  const res = await api<{ payment: { id: string } }>(`/checkout/${token}/pay`, {
                    method: 'POST',
                    body: { idempotencyKey: newKey('checkout'), strongConfirmation: true },
                  });
                  setPaymentId(res.payment.id);
                } catch (e) {
                  setSubmitError(e);
                } finally {
                  setPaying(false);
                }
              }}
            >
              {paying ? 'Starting…' : data.expired ? 'This request has expired' : `Pay ${data.amountFormatted ?? ''} from my balance`}
            </button>
          )}
          <ErrorNote error={submitError} />
          <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
            Paying here uses your own session and your own confirmation. The merchant&rsquo;s key can create a request; it can never complete one, and
            a publishable key can never move money.
          </p>
        </Panel>
      ) : null}
      {!loading && !data && !error ? (
        <Panel className="p-6 text-[13px] leading-relaxed text-ink-dim">
          That link does not exist, was revoked, or belongs to a different environment. Nothing was charged.
        </Panel>
      ) : null}
    </div>
  );
}
