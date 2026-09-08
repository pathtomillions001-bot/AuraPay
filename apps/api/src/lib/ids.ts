import { randomBytes, randomUUID } from 'node:crypto';
import { stringify } from '../lib/json.js';

/**
 * Prefixed, sortable identifiers.
 *
 * Format: `<prefix>_<base36 timestamp><12 hex chars>`. Sortable by creation
 * time (useful for cursors) and safe to expose publicly — they carry no user
 * data, unlike sequential ids.
 */
/** Alphabet for public URL tokens: no `i`/`o` so a hand-copied link round-trips. */
const ALPHABET = '0123456789abcdefghjklmnpqrstuvwxyz';

/**
 * Base-36 of a BigInt. `BigInt.prototype.toString(36)` rather than a hand-rolled
 * alphabet: an earlier version used a 34-character alphabet (no `i`/`o`) indexed
 * 0..35, which silently injected the text "undefined" into roughly 1 id in 18.
 * Ids must stay ambiguous to read, but they must never be *wrong*: they are the
 * primary keys of money records.
 */
function base36(n: bigint): string {
  return n.toString(36);
}

export function id(prefix: string): string {
  const time = base36(BigInt(Date.now()));
  const rand = randomBytes(6).toString('hex');
  return `${prefix}_${time}${rand}`;
}

/** Public references shown to users (receipts, payment refs). */
export function reference(prefix: string, bytes = 5): string {
  const raw = randomBytes(bytes).toString('hex').toUpperCase();
  return `${prefix}-${raw.slice(0, 4)}-${raw.slice(4, 8)}${bytes > 5 ? `-${raw.slice(8, 12)}` : ''}`;
}

export function urlToken(length = 12): string {
  const bytes = randomBytes(Math.ceil((length * 5) / 8));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out.slice(0, length);
}

export function uuid(): string {
  return randomUUID();
}

export const nowIso = (): string => new Date().toISOString();

export function isoIn(seconds: number, from: Date = new Date()): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

/** Hash of the request payload, used to detect idempotency-key reuse with a different body. */
export function fingerprint(payload: unknown): string {
  return fnv1a(stableStringify(payload));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as object)
    .sort()
    .map((k) => `${stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** Non-cryptographic 64-bit-ish hash — idempotency comparison only, never security. */
function fnv1a(input: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i += 1) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}

export { randomBytes };
