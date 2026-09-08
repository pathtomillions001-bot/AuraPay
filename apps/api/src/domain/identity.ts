import { DomainError, TIER_LIMITS, type PublicUser } from '@aurapay/shared';
import { normalizeRoles } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { decryptString, encryptString, hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { generateRecoveryCodes, generateTotpSecret, totpCode, totpUri, verifyTotp } from '../lib/totp.js';
import { id, isoIn, nowIso } from '../lib/ids.js';
import { createLogger } from '../logger.js';
import { stringify } from '../lib/json.js';

const log = createLogger('identity');

/**
 * Identity, sessions and step-up authentication.
 *
 *  - scrypt password hashing; nothing reversible is stored
 *  - opaque session tokens: the browser gets 32 random bytes once, the DB keeps
 *    only `sha256(token)`, so a database read cannot be replayed as a session
 *  - httpOnly + SameSite=Lax cookie (set in http/app.ts), idle timeout, max 8
 *    concurrent sessions, per-session and per-device revocation
 *  - login lockout after N failures, identical error for unknown email vs wrong
 *    password (no user enumeration)
 *  - TOTP 2FA + single-use recovery codes; 2FA gates password changes and
 *    limit changes as step-up
 */

export interface UserRow {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  country: string;
  locale: string;
  roles: string;
  status: string;
  kyc_status: string;
  kyc_tier: number;
  two_factor_enabled: number;
  passkey_credential_id: string | null;
  default_settlement_rail: string;
  created_at: string;
  updated_at: string;
}

export function audit(input: {
  actorUserId: string | null;
  actorType: 'USER' | 'ADMIN' | 'SYSTEM' | 'API_KEY' | 'PARTNER';
  action: string;
  targetType?: string;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: unknown;
}): void {
  getDb().run(
    `INSERT INTO audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, ip, user_agent, metadata, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id('aud'),
      input.actorUserId,
      input.actorType,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.ip ?? null,
      (input.userAgent ?? '').slice(0, 400) || null,
      input.metadata ? stringify(input.metadata) : null,
      nowIso(),
    ],
  );
}

export function register(input: {
  email: string;
  password: string;
  fullName: string;
  phone?: string | null;
  country?: string;
}): { userId: string; email: string } {
  const db = getDb();
  const email = input.email.toLowerCase();
  if (db.maybeOne<{ id: string }>('SELECT id FROM users WHERE email = ?', [email])) {
    throw new DomainError('CONFLICT', 'An account already exists with that email address.');
  }
  if (input.password.length < 10) {
    throw new DomainError('VALIDATION_FAILED', 'Use at least 10 characters for your password.');
  }
  const userId = id('usr');
  const now = nowIso();
  db.tx(() => {
    db.run(
      `INSERT INTO users (id, email, password_hash, password_algo, full_name, phone, country, locale, roles, status, kyc_status, kyc_tier, default_settlement_rail, created_at, updated_at)
       VALUES (?,?,?, 'scrypt', ?,?,?,?,'["user"]','ACTIVE','NOT_STARTED',0,'MPESA',?,?)`,
      [userId, email, hashPassword(input.password), input.fullName, input.phone ?? null, input.country ?? 'KE', 'en-KE', now, now],
    );
    db.run(
      `INSERT INTO profiles (user_id, avatar_seed, city, occupation, source_of_funds, pep, home_asset, updated_at)
       VALUES (?,?,NULL,NULL,NULL,0,'USDT',?)`,
      [userId, initials(input.fullName), now],
    );
    audit({ actorUserId: userId, actorType: 'SYSTEM', action: 'auth.register', targetType: 'user', targetId: userId });
  });
  log.info('user registered', { userId, country: input.country ?? 'KE' });
  return { userId, email };
}

export class TotpRequiredError extends Error {
  readonly code = 'TOTP_REQUIRED' as const;
  constructor() {
    super('Two-factor code required');
    this.name = 'TotpRequiredError';
  }
}

export function login(input: {
  email: string;
  password: string;
  totp?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): { token: string; csrfToken: string; expiresAt: string; sessionId: string; userId: string } {
  const db = getDb();
  const user = db.maybeOne<{
    id: string;
    password_hash: string;
    status: string;
    failed_login_count: number;
    locked_until: string | null;
    two_factor_enabled: number;
  }>('SELECT id, password_hash, status, failed_login_count, locked_until, two_factor_enabled FROM users WHERE email = ?', [
    input.email.toLowerCase(),
  ]);

  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    const seconds = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
    throw new DomainError('RATE_LIMITED', `Too many failed attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`, {
      retryAfterSeconds: seconds,
    });
  }
  if (!user || !verifyPassword(input.password, user.password_hash)) {
    if (user) {
      const attempts = user.failed_login_count + 1;
      const lock = attempts >= config.security.passwordLockoutThreshold;
      db.run('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?', [
        lock ? 0 : attempts,
        lock ? isoIn(config.security.passwordLockoutSeconds) : user.locked_until,
        user.id,
      ]);
      audit({
        actorUserId: user.id,
        actorType: 'USER',
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: user.id,
        ip: input.ip,
        userAgent: input.userAgent,
        metadata: { attempts, locked: lock },
      });
    }
    throw new DomainError('UNAUTHENTICATED', 'That email and password do not match an account.');
  }
  if (user.status !== 'ACTIVE') {
    throw new DomainError('FORBIDDEN', `This account is ${user.status.toLowerCase()}. Contact support if that is unexpected.`);
  }
  if (user.two_factor_enabled === 1) {
    const code = input.totp;
    if (!code) throw new TotpRequiredError();
    if (!verifyTotpForUser(user.id, code)) {
      db.run('UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = ?', [user.id]);
      throw new DomainError('UNAUTHENTICATED', 'That authentication code is not valid right now. Check your authenticator app.');
    }
  }
  db.run('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?', [
    nowIso(),
    nowIso(),
    user.id,
  ]);
  return createSession(user.id, {
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    method: user.two_factor_enabled === 1 ? 'password+totp' : 'password',
  });
}

export function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null; method?: string } = {},
): { token: string; csrfToken: string; expiresAt: string; sessionId: string; userId: string } {
  const db = getDb();
  const token = randomToken(32);
  const tokenHash = sha256(token);
  const csrfToken = randomToken(24);
  const sessionId = id('ses');
  const now = nowIso();
  const expiresAt = isoIn(config.security.sessionTtlSeconds);
  const userAgent = (meta.userAgent ?? '').slice(0, 400) || null;
  const fingerprint = sha256(`${userAgent ?? 'unknown'}|${deviceClass(userAgent ?? '')}`).slice(0, 32);

  db.tx(() => {
    db.run(
      `INSERT INTO sessions (id, user_id, device_id, token_hash, csrf_token, auth_method, ip, user_agent, created_at, last_seen_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [sessionId, userId, fingerprint, tokenHash, csrfToken, meta.method ?? 'password', meta.ip ?? null, userAgent, now, now, expiresAt],
    );
    const device = db.maybeOne<{ id: string; first_seen_at: string }>(
      'SELECT id, first_seen_at FROM devices WHERE user_id = ? AND fingerprint = ?',
      [userId, fingerprint],
    );
    if (device) {
      db.run('UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?', [now, meta.ip ?? null, device.id]);
      // A device seen for the first time in under an hour is treated as anomalous
      // for high-value step-up decisions.
      if (Date.now() - new Date(device.first_seen_at).getTime() < 3.6e6) {
        db.run('UPDATE devices SET anomaly = 1 WHERE id = ?', [device.id]);
      }
    } else {
      db.run(
        `INSERT INTO devices (id, user_id, name, platform, fingerprint, last_ip, trusted, anomaly, first_seen_at, last_seen_at)
         VALUES (?,?,?,?,?,?, 0, 0, ?, ?)`,
        [id('dev'), userId, deviceName(userAgent ?? ''), deviceClass(userAgent ?? ''), fingerprint, meta.ip ?? null, now, now],
      );
    }
    const stale = db.all<{ id: string }>(
      `SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT -1 OFFSET 8`,
      [userId],
    );
    for (const row of stale) db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now, row.id]);
  });

  audit({
    actorUserId: userId,
    actorType: 'USER',
    action: 'auth.login',
    targetType: 'session',
    targetId: sessionId,
    ip: meta.ip ?? null,
    userAgent,
  });
  return { token, csrfToken, expiresAt, sessionId, userId };
}

export interface ResolvedSession {
  userId: string;
  sessionId: string;
  csrfToken: string;
}

export function resolveSession(token: string | undefined | null): ResolvedSession | null {
  if (!token) return null;
  const db = getDb();
  const row = db.maybeOne<{
    id: string;
    user_id: string;
    csrf_token: string;
    expires_at: string;
    last_seen_at: string;
    revoked_at: string | null;
  }>('SELECT id, user_id, csrf_token, expires_at, last_seen_at, revoked_at FROM sessions WHERE token_hash = ?', [
    sha256(token),
  ]);
  if (!row || row.revoked_at) return null;
  if (new Date(row.expires_at) <= new Date()) return null;
  const idleCutoff = Date.now() - config.security.idleTimeoutSeconds * 1000;
  if (new Date(row.last_seen_at).getTime() < idleCutoff) return null;
  db.run('UPDATE sessions SET last_seen_at = ?, expires_at = MAX(expires_at, ?) WHERE id = ?', [
    nowIso(),
    isoIn(config.security.sessionTtlSeconds),
    row.id,
  ]);
  const user = db.maybeOne<{ status: string }>('SELECT status FROM users WHERE id = ?', [row.user_id]);
  if (!user || user.status !== 'ACTIVE') return null;
  return { userId: row.user_id, sessionId: row.id, csrfToken: row.csrf_token };
}

export function logout(token: string | undefined | null): void {
  if (!token) return;
  const db = getDb();
  const row = db.maybeOne<{ id: string; user_id: string }>('SELECT id, user_id FROM sessions WHERE token_hash = ?', [sha256(token)]);
  if (!row) return;
  db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [nowIso(), row.id]);
  audit({ actorUserId: row.user_id, actorType: 'USER', action: 'auth.logout', targetType: 'session', targetId: row.id });
}

export function revokeSession(userId: string, sessionId: string, actor: 'self' | 'admin' = 'self'): void {
  getDb().run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?', [nowIso(), sessionId, userId]);
  audit({
    actorUserId: userId,
    actorType: actor === 'self' ? 'USER' : 'ADMIN',
    action: 'session.revoked',
    targetType: 'session',
    targetId: sessionId,
  });
}

export function revokeOtherSessions(userId: string, keepSessionId: string | null): number {
  const db = getDb();
  const res = keepSessionId
    ? db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?', [nowIso(), userId, keepSessionId])
    : db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), userId]);
  return res.changes;
}

export function revokeDevice(userId: string, deviceId: string): void {
  const db = getDb();
  const sessions = db.all<{ id: string }>('SELECT id FROM sessions WHERE device_id = ? AND user_id = ?', [deviceId, userId]);
  db.tx(() => {
    db.run('UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ?', [nowIso(), deviceId, userId]);
    for (const s of sessions) db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [nowIso(), s.id]);
  });
  audit({ actorUserId: userId, actorType: 'USER', action: 'device.revoked', targetType: 'device', targetId: deviceId });
}

export function listSessions(userId: string, currentSessionId: string | null) {
  return getDb()
    .all<{
      id: string;
      created_at: string;
      last_seen_at: string;
      expires_at: string;
      ip: string | null;
      user_agent: string | null;
      auth_method: string;
      revoked_at: string | null;
    }>('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 25', [userId])
    .map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      ip: row.ip,
      userAgent: row.user_agent,
      authMethod: row.auth_method,
      active: !row.revoked_at,
      current: row.id === currentSessionId,
    }));
}

export function listDevices(userId: string) {
  return getDb()
    .all<{
      id: string;
      name: string;
      platform: string | null;
      last_ip: string | null;
      trusted: number;
      anomaly: number;
      first_seen_at: string;
      last_seen_at: string;
      revoked_at: string | null;
    }>('SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC', [userId])
    .map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      lastIp: d.last_ip,
      trusted: d.trusted === 1,
      anomaly: d.anomaly === 1,
      firstSeenAt: d.first_seen_at,
      lastSeenAt: d.last_seen_at,
      revoked: Boolean(d.revoked_at),
    }));
}

export function userById(userId: string): UserRow | null {
  return getDb().maybeOne<UserRow>('SELECT * FROM users WHERE id = ?', [userId]) ?? null;
}

export function emailFor(userId: string): string {
  return getDb().maybeOne<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId])?.email ?? '';
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    country: row.country,
    locale: row.locale,
    // Canonical casing on the way out, so every consumer — the admin gate, the merchant
    // nav, the browser — compares the same shape the database actually holds.
    roles: normalizeRoles(safeJsonArray(row.roles)),
    kycStatus: row.kyc_status as PublicUser['kycStatus'],
    kycTier: row.kyc_tier as PublicUser['kycTier'],
    twoFactorEnabled: row.two_factor_enabled === 1,
    passkeyEnabled: Boolean(row.passkey_credential_id),
    defaultSettlementRail: row.default_settlement_rail,
    createdAt: row.created_at,
  };
}

export function hasTwoFactor(userId: string): boolean {
  return (
    getDb().maybeOne<{ two_factor_enabled: number }>('SELECT two_factor_enabled FROM users WHERE id = ?', [userId])
      ?.two_factor_enabled ?? 0
  ) === 1;
}

export function verifyTotpForUser(userId: string, code: string): boolean {
  const db = getDb();
  const row = db.maybeOne<{ two_factor_secret_enc: string | null }>(
    'SELECT two_factor_secret_enc FROM users WHERE id = ?',
    [userId],
  );
  const secret = decryptString(row?.two_factor_secret_enc);
  if (secret && verifyTotp(secret, code)) return true;
  const recovery = db.maybeOne<{ id: string }>(
    'SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    [userId, sha256(code.replace(/[\s-]/g, ''))],
  );
  if (recovery) {
    db.run('UPDATE recovery_codes SET used_at = ? WHERE id = ?', [nowIso(), recovery.id]);
    audit({ actorUserId: userId, actorType: 'USER', action: '2fa.recovery_code_used', targetType: 'user', targetId: userId });
    return true;
  }
  return false;
}

export function beginTwoFactorEnrolment(userId: string): { secret: string; uri: string } {
  const secret = generateTotpSecret();
  getDb().run('UPDATE users SET two_factor_secret_enc = ?, updated_at = ? WHERE id = ?', [encryptString(secret), nowIso(), userId]);
  return { secret, uri: totpUri(secret, emailFor(userId)) };
}

export function confirmTwoFactorEnrolment(userId: string, code: string): { recoveryCodes: string[] } {
  const db = getDb();
  const row = db.maybeOne<{ two_factor_secret_enc: string | null }>(
    'SELECT two_factor_secret_enc FROM users WHERE id = ?',
    [userId],
  );
  const secret = decryptString(row?.two_factor_secret_enc);
  if (!secret) throw new DomainError('CONFLICT', 'Start 2FA setup again — the pending secret expired.');
  const trimmed = code.replace(/\D/g, '');
  const valid = [-1, 0, 1].some((step) => totpCode(secret, new Date(), step) === trimmed);
  if (!valid) throw new DomainError('VALIDATION_FAILED', 'That code does not match. Check your authenticator and try again.');
  const { plain } = generateRecoveryCodes();
  db.tx(() => {
    db.run('UPDATE users SET two_factor_enabled = 1, updated_at = ? WHERE id = ?', [nowIso(), userId]);
    db.run('DELETE FROM recovery_codes WHERE user_id = ?', [userId]);
    for (const recovery of plain) {
      db.run('INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?,?,?,?)', [
        id('rc'),
        userId,
        sha256(recovery),
        nowIso(),
      ]);
    }
    audit({ actorUserId: userId, actorType: 'USER', action: '2fa.enabled', targetType: 'user', targetId: userId });
  });
  return { recoveryCodes: plain };
}

export function disableTwoFactor(userId: string, code: string): void {
  if (!verifyTotpForUser(userId, code)) throw new DomainError('VALIDATION_FAILED', 'Confirm your authentication code to disable 2FA.');
  const db = getDb();
  db.tx(() => {
    db.run('UPDATE users SET two_factor_enabled = 0, two_factor_secret_enc = NULL, updated_at = ? WHERE id = ?', [nowIso(), userId]);
    db.run('DELETE FROM recovery_codes WHERE user_id = ?', [userId]);
    audit({ actorUserId: userId, actorType: 'USER', action: '2fa.disabled', targetType: 'user', targetId: userId });
  });
}

/**
 * Passkeys (WebAuthn). The registration ceremony needs a configured relying
 * party origin, so this build stores the registered credential id and treats
 * possession of the passkey as an equivalent step-up factor. The challenge
 * ceremony itself is delegated to `webauthnCeremony()` below, which throws a
 * clear "not configured" error rather than faking a verification.
 */
export function webauthnCeremony(): never {
  throw new DomainError(
    'PROVIDER_KEY_MISSING',
    'Passkeys require WEBAUTHN_RP_ID and an https origin to be configured. Password + TOTP remains available.',
  );
}

export function listPasskeys(userId: string) {
  const row = getDb().maybeOne<{ passkey_credential_id: string | null }>(
    'SELECT passkey_credential_id FROM users WHERE id = ?',
    [userId],
  );
  return row?.passkey_credential_id
    ? [{ id: row.passkey_credential_id, label: 'Primary passkey', createdAt: nowIso(), source: 'stored credential id' }]
    : [];
}

export function changePassword(userId: string, current: string, next: string, stepUpCode?: string | null, sessionId?: string | null): void {
  const db = getDb();
  const user = db.maybeOne<{ password_hash: string; two_factor_enabled: number }>('SELECT password_hash, two_factor_enabled FROM users WHERE id = ?', [
    userId,
  ]);
  if (!user) throw new DomainError('NOT_FOUND');
  if (!verifyPassword(current, user.password_hash)) throw new DomainError('UNAUTHENTICATED', 'Your current password is not correct.');
  if (next.length < 10) throw new DomainError('VALIDATION_FAILED', 'Use at least 10 characters for your new password.');
  if (user.two_factor_enabled === 1) {
    if (!stepUpCode) throw new DomainError('CONFLICT', 'Confirm your 2FA code to change your password.');
    if (!verifyTotpForUser(userId, stepUpCode)) throw new DomainError('VALIDATION_FAILED', 'That authentication code is not valid.');
  }
  db.tx(() => {
    db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(next), nowIso(), userId]);
    db.run(
      `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL${sessionId ? ' AND id != ?' : ''}`,
      sessionId ? [nowIso(), userId, sessionId] : [nowIso(), userId],
    );
    audit({ actorUserId: userId, actorType: 'USER', action: 'auth.password_changed', targetType: 'user', targetId: userId });
  });
}

export function updateProfile(userId: string, patch: { fullName?: string; phone?: string | null; city?: string | null; occupation?: string | null; sourceOfFunds?: string | null; defaultSettlementRail?: string; homeAsset?: string }): void {
  const db = getDb();
  const now = nowIso();
  const fields: string[] = [];
  const params: (string | null)[] = [];
  if (patch.fullName !== undefined) {
    fields.push('full_name = ?');
    params.push(patch.fullName);
  }
  if (patch.phone !== undefined) {
    fields.push('phone = ?');
    params.push(patch.phone);
  }
  if (patch.defaultSettlementRail !== undefined) {
    fields.push('default_settlement_rail = ?');
    params.push(patch.defaultSettlementRail);
  }
  if (fields.length) {
    fields.push('updated_at = ?');
    params.push(now, userId);
    db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params as string[]);
  }
  const profileFields: string[] = [];
  const profileParams: (string | null)[] = [];
  if (patch.city !== undefined) {
    profileFields.push('city = ?');
    profileParams.push(patch.city);
  }
  if (patch.occupation !== undefined) {
    profileFields.push('occupation = ?');
    profileParams.push(patch.occupation);
  }
  if (patch.sourceOfFunds !== undefined) {
    profileFields.push('source_of_funds = ?');
    profileParams.push(patch.sourceOfFunds);
  }
  if (patch.homeAsset !== undefined) {
    profileFields.push('home_asset = ?');
    profileParams.push(patch.homeAsset);
  }
  if (profileFields.length) {
    profileFields.push('updated_at = ?');
    profileParams.push(now, userId);
    db.run(`UPDATE profiles SET ${profileFields.join(', ')} WHERE user_id = ?`, profileParams as string[]);
  }
  audit({ actorUserId: userId, actorType: 'USER', action: 'profile.updated', targetType: 'user', targetId: userId });
}

export function limitsFor(userId: string) {
  const row = getDb().maybeOne<{ kyc_tier: number; payout_limit_override_minor: string | null }>(
    'SELECT kyc_tier, payout_limit_override_minor FROM users WHERE id = ?',
    [userId],
  );
  const tier = (row?.kyc_tier ?? 0) as 0 | 1 | 2 | 3;
  const base = TIER_LIMITS[tier];
  const override = row?.payout_limit_override_minor ? BigInt(row.payout_limit_override_minor) : null;
  return {
    ...base,
    tier,
    perPaymentKes: override !== null ? Number(override / 100n) : base.perPaymentKes,
    overrideActive: override !== null,
  };
}

export function safeJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function deviceName(userAgent: string): string {
  if (/iphone/i.test(userAgent)) return 'iPhone';
  if (/ipad/i.test(userAgent)) return 'iPad';
  if (/android/i.test(userAgent)) return 'Android device';
  if (/mac os x|macintosh/i.test(userAgent)) return 'Mac';
  if (/windows/i.test(userAgent)) return 'Windows PC';
  if (/linux/i.test(userAgent)) return 'Linux machine';
  return 'Unknown device';
}

function deviceClass(userAgent: string): 'mobile' | 'desktop' | 'other' {
  if (/android|iphone|mobile/i.test(userAgent)) return 'mobile';
  if (/macintosh|windows|linux x86|cros/i.test(userAgent)) return 'desktop';
  return 'other';
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}
