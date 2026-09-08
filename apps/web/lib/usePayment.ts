'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export interface PaymentView {
  object: 'payment';
  id: string;
  reference: string;
  status: string;
  displayStatus: string;
  terminal: boolean;
  progress: number;
  steps: Array<{ step: number; label: string; state: string; status: string; at: string | null; simulated?: boolean }>;
  timeline: Array<{ from: string | null; to: string; actor: string; note: string | null; at: string }>;
  settlement?: { state: string; note?: string | null } | null;
  deposit?: Record<string, unknown> | null;
  payout?: Record<string, unknown> | null;
  failure?: { code: string; message: string; recovery: string } | null;
  receiptId?: string | null;
  refund?: Record<string, unknown> | null;
  risk?: Record<string, unknown> | null;
  route?: Record<string, unknown> | null;
  sandbox?: { available: boolean; note?: string } | null;
  legalNote?: string;
  strongConfirmationRequired?: boolean;
  amounts?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * One payment, kept current.
 *
 * SSE tells us *when* to refetch and polling guarantees we still get there if the
 * stream is severed (a phone locking, a proxy restarting). Neither path can advance
 * a step by itself: the view is always whatever the API last said.
 */
export function usePayment(id: string | null): {
  payment: PaymentView | null;
  error: unknown;
  loading: boolean;
  refresh: () => void;
  via: 'stream' | 'poll' | 'initial' | 'manual';
} {
  const [payment, setPayment] = useState<PaymentView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(id));
  const [via, setVia] = useState<'stream' | 'poll' | 'initial' | 'manual'>('initial');
  const alive = useRef(true);

  const refresh = useCallback(
    async (source: 'stream' | 'poll' | 'initial' | 'manual' = 'manual') => {
      if (!id) return;
      try {
        const next = await api<PaymentView>(`/payments/${id}`);
        if (!alive.current) return;
        setPayment(next);
        setError(null);
        setVia(source);
      } catch (e) {
        if (alive.current) setError(e);
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    alive.current = true;
    void refresh('initial');
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  // Poll while unsettled, gently once settled. A terminal payment needs no timer.
  useEffect(() => {
    if (!id) return;
    const terminal = payment?.terminal === true;
    const ms = terminal ? 60_000 : 2_500;
    const timer = setInterval(() => void refresh('poll'), ms);
    return () => clearInterval(timer);
  }, [id, payment?.terminal, refresh]);

  useEffect(() => {
    if (!id || typeof EventSource === 'undefined') return;
    const stream = new EventSource('/v1/realtime/stream', { withCredentials: true });
    const onEvent = (event: MessageEvent<string>) => {
      let data: { paymentId?: string; id?: string } = {};
      try {
        data = JSON.parse(event.data) as { paymentId?: string; id?: string };
      } catch {
        return;
      }
      if (data.paymentId === id || data.id === id || !data.paymentId) void refresh('stream');
    };
    const names = ['payment.updated', 'payment.completed', 'payment.failed', 'payment.review', 'resync', 'connected', 'ping'];
    for (const name of names) stream.addEventListener(name, onEvent as EventListener);
    stream.onerror = () => {
      // EventSource retries by itself. The poll loop is the fallback, so the worst
      // case after a lost connection is a few extra seconds of "still waiting".
    };
    return () => {
      for (const name of names) stream.removeEventListener(name, onEvent as EventListener);
      stream.close();
    };
  }, [id, refresh]);

  return { payment, error, loading, refresh: () => void refresh('manual'), via };
}
