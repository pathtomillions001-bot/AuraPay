import { EventEmitter } from 'node:events';
import type { RealtimeChannel } from '@aurapay/shared';

/**
 * In-process realtime fan-out for SSE.
 *
 * Scopes are authorization boundaries — a subscriber must prove access to the
 * scope when it opens the stream, and the route never subscribes to a scope it
 * did not authorize:
 *   user:<userId>   — payer dashboard, payment progress, quotes, notifications
 *   merchant:<id>   — merchant console
 *   admin           — operations/compliance/treasury
 *   public          — labelled demo network visualization + public price ticker
 *
 * Multi-instance note: `RedisRealtimeBridge` (see docs/ARCHITECTURE.md) mirrors
 * every publish to a Redis pub/sub channel and re-emits locally, so SSE clients
 * attached to any node receive the same events. In sandbox the local bus is
 * authoritative.
 */

export interface BusEvent<T = unknown> {
  scope: string;
  channel: RealtimeChannel;
  type: string;
  data: T;
  at: string;
}

type Listener = (event: BusEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(500);

let seq = 0n;
const listeners = new Map<string, Set<Listener>>();

export function publish<T>(scope: string, channel: RealtimeChannel, type: string, data: T): void {
  seq += 1n;
  const event: BusEvent<T> = { scope, channel, type, data, at: new Date().toISOString() };
  const bucket = listeners.get(scope);
  if (!bucket || bucket.size === 0) return;
  for (const listener of bucket) {
    try {
      listener({ ...event, seq: Number(seq) } as BusEvent);
    } catch {
      // A broken subscriber must never break a settlement path.
    }
  }
}

export function subscribe(scope: string, listener: Listener): () => void {
  let bucket = listeners.get(scope);
  if (!bucket) {
    bucket = new Set();
    listeners.set(scope, bucket);
  }
  bucket.add(listener);
  return () => {
    bucket!.delete(listener);
    if (bucket!.size === 0) listeners.delete(scope);
  };
}

export function subscriberCount(scope: string): number {
  return listeners.get(scope)?.size ?? 0;
}

export function currentSeq(): number {
  return Number(seq);
}
