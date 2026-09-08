import { DomainError } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { fingerprint, id, isoIn, nowIso } from './ids.js';
import { stringify } from '../lib/json.js';

/**
 * Idempotency for money writes.
 *
 * Semantics (documented for integrators in docs/api.md):
 *   - the key is scoped per user + route, so two endpoints cannot collide
 *   - replaying the same key with the same body returns the *original* stored
 *     response; the operation is not executed twice
 *   - replaying the same key with a different body is `IDEMPOTENCY_CONFLICT`,
 *     because silently doing something else with a reused key is how a customer
 *     ends up paying twice
 *   - a key whose first attempt is still running blocks a second attempt
 *   - keys expire after 24h; a failure that provably moved no money clears the
 *     key so the caller can retry it
 */

interface Row {
  id: string;
  key: string;
  scope: string;
  user_id: string | null;
  request_hash: string;
  response_code: number | null;
  response_body: string | null;
  created_at: string;
  expires_at: string;
}

const IN_FLIGHT = 0;

export function lookup<T>(scope: string, key: string, userId: string | null, body: unknown): { replay: { code: number; body: T } | null } {
  const db = getDb();
  const row = db.maybeOne<Row>('SELECT * FROM idempotency_keys WHERE key = ? AND scope = ?', [key, scope]);
  if (!row) return { replay: null };
  if (row.request_hash !== fingerprint(body)) {
    throw new DomainError(
      'IDEMPOTENCY_CONFLICT',
      'That idempotency key was already used with a different request body. Use a new key to start a new payment.',
    );
  }
  if (row.response_code === null || row.response_code === IN_FLIGHT) {
    throw new DomainError('CONFLICT', 'The first request with this key is still being processed. Poll the payment instead of retrying.');
  }
  return { replay: { code: row.response_code, body: JSON.parse(row.response_body ?? 'null') as T } };
}

export function begin(scope: string, key: string, userId: string | null, body: unknown): string {
  const rowId = id('idk');
  getDb().run(
    `INSERT INTO idempotency_keys (id, key, scope, user_id, request_hash, response_code, created_at, expires_at)
     VALUES (?,?,?,?,?, ?, ?, ?)`,
    [rowId, key, scope, userId, fingerprint(body), IN_FLIGHT, nowIso(), isoIn(86_400)],
  );
  return rowId;
}

export function complete(scope: string, key: string, code: number, body: unknown): void {
  getDb().run('UPDATE idempotency_keys SET response_code = ?, response_body = ? WHERE key = ? AND scope = ?', [
    code,
    body === undefined ? null : stringify(body),
    key,
    scope,
  ]);
}

export function release(scope: string, key: string): void {
  getDb().run('DELETE FROM idempotency_keys WHERE key = ? AND scope = ?', [key, scope]);
}

/** Errors where nothing moved, so the same key may be reused. */
const RETRYABLE_CODES = new Set([
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'INSUFFICIENT_FUNDS',
  'INSUFFICIENT_LIQUIDITY',
  'QUOTE_EXPIRED',
  'QUOTE_STALE_RATE',
  'QUOTE_ASSET_CHANGED',
  'RAIL_UNAVAILABLE',
  'NETWORK_CONGESTED',
  'CSRF_FAILED',
]);

/**
 * Run `fn` under an idempotency key. When `fn` throws, the error's `code` decides
 * whether the key is released (no money moved) or kept (the caller must not
 * blindly retry an operation whose outcome is unknown).
 */
export async function run<T>(
  input: { scope: string; key?: string | null; userId: string | null; body: unknown },
  fn: () => Promise<T> | T,
): Promise<{ body: T; replayed: boolean }> {
  if (!input.key) return { body: await fn(), replayed: false };
  const { replay } = lookup<T>(input.scope, input.key, input.userId, input.body);
  if (replay) return { body: replay.body, replayed: true };
  begin(input.scope, input.key, input.userId, input.body);
  try {
    const body = await fn();
    complete(input.scope, input.key, 200, body);
    return { body, replayed: false };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code && RETRYABLE_CODES.has(code)) release(input.scope, input.key);
    else complete(input.scope, input.key, 409, { idempotencyNote: 'the original request failed; inspect the payment before retrying', code: code ?? 'INTERNAL' });
    throw error;
  }
}

/** Prune expired keys (worker). */
export function purgeExpired(): number {
  const db = getDb();
  const before = db.maybeOne<{ c: number }>('SELECT COUNT(*) AS c FROM idempotency_keys WHERE expires_at <= ?', [nowIso()])?.c ?? 0;
  db.run('DELETE FROM idempotency_keys WHERE expires_at <= ?', [nowIso()]);
  return before;
}
