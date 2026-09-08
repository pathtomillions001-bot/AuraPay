import { DomainError } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { hashToken, maskSecret, randomToken } from '../lib/crypto.js';
import { id, nowIso } from '../lib/ids.js';
import { stringify } from '../lib/json.js';

/**
 * Platform API keys.
 *
 * `pk_test_…` / `sk_test_…` in sandbox, `pk_live_…` / `sk_live_…` in production.
 * Only the SHA-256 hash of the secret is stored: the plaintext is returned once,
 * at creation, and cannot be read back — including by an operator. Publishable
 * keys may create quotes and payment links; they can never move money, which is
 * why the browser is allowed to hold them.
 */

/** Everything a secret key may be granted. Money-moving scopes are explicit. */
export type ApiKeyScope =
  | 'read:balances'
  | 'read:transactions'
  | 'write:payments'
  | 'write:refunds'
  | 'write:payouts'
  | 'read:quotes'
  | 'write:quotes'
  | 'read:links'
  | 'write:links'
  | 'read:webhooks'
  | 'write:webhooks';

export const SCOPES: ApiKeyScope[] = [
  'read:balances',
  'read:transactions',
  'write:payments',
  'write:refunds',
  'write:payouts',
  'read:quotes',
  'write:quotes',
  'read:links',
  'write:links',
  'read:webhooks',
  'write:webhooks',
];

export interface KeyRow {
  id: string;
  user_id: string | null;
  business_id: string | null;
  name: string;
  environment: string;
  publishable_key: string;
  secret_hash: string;
  secret_hint: string;
  scopes: string;
  status: string;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface KeyView {
  id: string;
  name: string;
  environment: 'test' | 'live';
  publishableKey: string;
  hint: string;
  scopes: ApiKeyScope[];
  status: 'ACTIVE' | 'REVOKED';
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

function toView(row: KeyRow): KeyView {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment as 'test' | 'live',
    publishableKey: row.publishable_key,
    hint: row.secret_hint,
    scopes: JSON.parse(row.scopes) as ApiKeyScope[],
    status: row.status as 'ACTIVE' | 'REVOKED',
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function create(input: {
  userId: string | null;
  businessId: string | null;
  name: string;
  environment?: 'test' | 'live';
  scopes?: ApiKeyScope[];
}): { key: KeyView; secret: string } {
  if (!input.name.trim()) throw new DomainError('VALIDATION_FAILED', 'Give the key a name so you know what to revoke later.');
  const environment = input.environment ?? (config.isSandbox ? 'test' : 'live');
  if (environment === 'live' && config.isSandbox) {
    throw new DomainError('FORBIDDEN', 'Live keys cannot be created from the sandbox environment.');
  }
  const scopes = (input.scopes?.length ? input.scopes : (['write:payments', 'read:balances', 'read:transactions'] as ApiKeyScope[])).filter((s) =>
    SCOPES.includes(s),
  );
  const secret = `sk_${environment}_${randomToken(24)}`;
  const publishable = `pk_${environment}_${randomToken(24)}`;
  const keyId = id('key');
  getDb().run(
    `INSERT INTO api_keys
     (id, user_id, business_id, name, environment, publishable_key, secret_hash, secret_hint, scopes, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?, 'ACTIVE', ?)`,
    [
      keyId,
      input.userId,
      input.businessId,
      input.name.trim(),
      environment,
      publishable,
      hashToken(secret),
      maskSecret(secret),
      stringify(scopes),
      nowIso(),
    ],
  );
  return { key: toView(getDb().one<KeyRow>('SELECT * FROM api_keys WHERE id = ?', [keyId])), secret };
}

export function list(userId: string | null, businessId: string | null): KeyView[] {
  return getDb()
    .all<KeyRow>(
      `SELECT * FROM api_keys WHERE (? IS NULL OR user_id = ?) AND (? IS NULL OR business_id = ?) ORDER BY created_at DESC`,
      [userId, userId, businessId, businessId],
    )
    .map(toView);
}

export function revoke(keyId: string, userId: string | null): void {
  const db = getDb();
  const row = db.maybeOne<KeyRow>('SELECT * FROM api_keys WHERE id = ?', [keyId]);
  if (!row) throw new DomainError('NOT_FOUND', 'That API key no longer exists.');
  if (userId && row.user_id !== userId) throw new DomainError('FORBIDDEN', 'You can only revoke your own API keys.');
  db.run(`UPDATE api_keys SET status = 'REVOKED', revoked_at = ? WHERE id = ?`, [nowIso(), keyId]);
}

export interface AuthenticatedKey {
  keyId: string;
  name: string;
  environment: 'test' | 'live';
  scopes: ApiKeyScope[];
  userId: string | null;
  businessId: string | null;
  publishable: boolean;
}

/** Verify a bearer secret key. Returns null when it is unknown or revoked. */
export function verifySecret(secret: string, requiredScope?: ApiKeyScope): AuthenticatedKey | null {
  if (!secret.startsWith('sk_')) return null;
  const row = getDb().maybeOne<KeyRow>('SELECT * FROM api_keys WHERE secret_hash = ?', [hashToken(secret)]);
  if (!row || row.status !== 'ACTIVE' || row.revoked_at) return null;
  const scopes = JSON.parse(row.scopes) as ApiKeyScope[];
  if (requiredScope && !scopes.includes(requiredScope)) return null;
  getDb().run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [nowIso(), row.id]);
  return {
    keyId: row.id,
    name: row.name,
    environment: row.environment as 'test' | 'live',
    scopes,
    userId: row.user_id,
    businessId: row.business_id,
    publishable: false,
  };
}

export function verifyPublishable(publishableKey: string): AuthenticatedKey | null {
  if (!publishableKey.startsWith('pk_')) return null;
  const row = getDb().maybeOne<KeyRow>('SELECT * FROM api_keys WHERE publishable_key = ?', [publishableKey]);
  if (!row || row.status !== 'ACTIVE' || row.revoked_at) return null;
  return {
    keyId: row.id,
    name: row.name,
    environment: row.environment as 'test' | 'live',
    scopes: JSON.parse(row.scopes) as ApiKeyScope[],
    userId: row.user_id,
    businessId: row.business_id,
    publishable: true,
  };
}

/** Keys whose environment does not match the running mode are refused. */
export function assertEnvironmentMatches(key: AuthenticatedKey): void {
  if (config.isSandbox && key.environment === 'live') {
    throw new DomainError('FORBIDDEN', 'A live secret key cannot be used against the sandbox environment.');
  }
  if (!config.isSandbox && key.environment === 'test') {
    throw new DomainError('FORBIDDEN', 'A test key cannot be used against the live environment.');
  }
}
