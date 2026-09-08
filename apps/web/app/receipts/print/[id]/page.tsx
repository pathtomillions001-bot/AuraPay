'use client';

import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { Receipt } from '../../../../components/Receipt';
import { useSession } from '../../../../components/SessionProvider';
import { Brand, Loading } from '../../../../components/ui';

/** A print document: the same payload, no chrome, ink-friendly. */
export default function ReceiptPrintPage() {
  const params = useParams<{ id: string }>();
  const { loading, user, refresh } = useSession();

  useEffect(() => {
    const t = setTimeout(() => {
      if (!user) void refresh();
    }, 150);
    return () => clearTimeout(t);
  }, [refresh, user]);

  useEffect(() => {
    if (!loading && user) setTimeout(() => window.print(), 400);
  }, [loading, user]);

  return (
    <div className="relative z-10 mx-auto max-w-[760px] px-6 py-10">
      <div className="no-print mb-6 flex items-center justify-between">
        <Brand />
        <button type="button" onClick={() => window.print()} className="btn-ghost">
          Print
        </button>
      </div>
      {loading ? <Loading label="Loading the document" /> : null}
      {!loading && !user ? <div className="text-[13px] text-ink-dim">Sign in to print this receipt.</div> : null}
      {user && params?.id ? <Receipt paymentId={params.id} embedded={false} /> : null}
    </div>
  );
}
