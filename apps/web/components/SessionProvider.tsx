'use client';

import { hasRole } from '@aurapay/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, setCsrf } from '../lib/api';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  country: string;
  roles: string[];
  kycStatus: string;
  kycTier: number;
  twoFactorEnabled: boolean;
  defaultSettlementRail: string;
}

interface SessionValue {
  user: SessionUser | null;
  mode: 'sandbox' | 'production';
  loading: boolean;
  isAdmin: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionValue>({
  user: null,
  mode: 'sandbox',
  loading: true,
  isAdmin: false,
  refresh: async () => {},
  signOut: async () => {},
});

export function useSession(): SessionValue {
  return useContext(Ctx);
}

/**
 * The session is read from the httpOnly cookie, so a refresh of any page returns to
 * the same signed-in state without a token in JS memory. `mode` comes from the
 * server too: the UI must not decide for itself whether it is showing real money.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [mode, setMode] = useState<'sandbox' | 'production'>('sandbox');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ user: SessionUser | null; csrfToken?: string; environment?: { mode?: string } }>('/auth/session');
      setUser(res.user ?? null);
      if (res.csrfToken) setCsrf(res.csrfToken);
      if (res.environment?.mode === 'production') setMode('production');
      else setMode('sandbox');
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      setUser(null);
      setCsrf(null);
    }
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ user, mode, loading, isAdmin: hasRole(user?.roles, 'ADMIN'), refresh, signOut }),
    [user, mode, loading, refresh, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
