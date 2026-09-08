'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Chrome } from '../../components/Chrome';
import { useSession } from '../../components/SessionProvider';
import { Loading } from '../../components/ui';

/**
 * The signed-in shell. It redirects when the session is gone rather than rendering
 * an empty dashboard: a customer who sees a blank balance after a session timeout
 * will reasonably think the money is missing.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace('/signin?next=/app');
  }, [loading, user, router]);

  if (loading) {
    return (
      <Chrome>
        <div className="py-24">
          <Loading label="Restoring your session" />
        </div>
      </Chrome>
    );
  }
  if (!user) {
    return (
      <Chrome>
        <div className="py-24 text-[13px] text-ink-dim">Signing you in…</div>
      </Chrome>
    );
  }

  return <Chrome>{children}</Chrome>;
}
