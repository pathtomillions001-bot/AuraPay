'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * Fetch-on-mount with manual refresh. Deliberately small: a payment app has maybe
 * a dozen screens that read data, and a caching layer would add another way for the
 * UI to disagree with the ledger — which is the one failure mode we cannot have.
 */
export function useApi<T>(path: string | null, opts: { pollMs?: number } = {}): {
  data: T | null;
  error: unknown;
  loading: boolean;
  refresh: () => Promise<void>;
  setData: (next: T) => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const alive = useRef(true);
  const { pollMs } = opts;

  const refresh = useCallback(async () => {
    if (!path) return;
    try {
      const next = await api<T>(path);
      if (!alive.current) return;
      setData(next);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    setLoading(Boolean(path));
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh, path]);

  useEffect(() => {
    if (!pollMs || !path) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refresh, path]);

  return { data, error, loading, refresh, setData };
}
