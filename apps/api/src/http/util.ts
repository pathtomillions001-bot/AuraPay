import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
// Imported for its declaration merging: it is what puts `request.cookies` and
// `reply.cookie` on the types. The plugin itself is registered in app.ts.
import '@fastify/cookie';
import { config } from '../config.js';
import * as identity from '../domain/identity.js';
import { DomainError, ERROR_CODES, messageFor, recoveryFor, statusFor, type ErrorCode } from '@aurapay/shared';
import { hasAnyRole, hasRole } from '@aurapay/shared';
import type { PublicUser } from '@aurapay/shared';

export const SESSION_COOKIE = 'aurapay_session';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved in the global preHandler: a session, an API key, or nothing. */
    auth?: AuthContext | null;
    apiKeyId?: string | null;
  }
}

export interface AuthContext {
  kind: 'session' | 'apikey';
  userId: string;
  sessionId: string;
  /** The raw session token: needed to revoke *this* session on logout. */
  sessionToken: string | null;
  csrfToken: string;
  user: PublicUser;
  /** Present only for API-key calls: the scopes granted to that key. */
  scopes?: string[];
  businessId?: string | null;
  apiKeyId?: string | null;
}

/**
 * Request-level auth + CSRF posture.
 *
 * Cookie auth is same-site-lax and the session token is signed and httpOnly, so a
 * cross-site *read* is not possible; a cross-site *write* is stopped by requiring
 * the session's CSRF secret in a header. Browser traffic must therefore send
 * `x-csrf-token`; API-key traffic sends none of that and is guarded by the
 * `Authorization` header plus an origin allowlist of its own (see keys.ts).
 */
export function declareAuth(app: FastifyInstance): void {
  app.decorateRequest('auth', null as unknown as AuthContext | null);
  app.decorateRequest('apiKeyId', null as string | null);

  // Resolved in onRequest, before the rate limiter: the limiter needs to know whose
  // budget this request is spending, and a per-IP limit would punish whole offices.
  app.addHook('onRequest', async (request) => {
    const token = request.cookies?.[SESSION_COOKIE] ?? null;
    const session = identity.resolveSession(token);
    if (session) {
      const row = identity.userById(session.userId);
      if (row) {
        request.auth = {
          kind: 'session',
          sessionToken: token,
          user: identity.toPublicUser(row),
          ...session,
        } satisfies AuthContext;
      }
    }
    if (request.auth) return;

    // `Authorization: Bearer sk_test_…` — verified against a hash, never a lookup
    // by plaintext, and never allowed to move money unless the key's scopes say so.
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const { verifySecret, assertEnvironmentMatches } = await import('../domain/keys.js');
      const resolved = verifySecret(header.slice(7).trim());
      if (resolved) {
        // A test key must never touch live money and vice versa — checked here so
        // no route can forget it.
        assertEnvironmentMatches(resolved);
        request.apiKeyId = resolved.keyId;
        request.auth = {
          kind: 'apikey',
          // A business-scoped key may have no personal account behind it. Routes
          // that need a person check `kind` before using this.
          userId: resolved.userId ?? '',
          sessionId: `key:${resolved.keyId}`,
          sessionToken: null,
          csrfToken: '',
          businessId: resolved.businessId ?? null,
          apiKeyId: resolved.keyId,
          scopes: resolved.scopes,
          // A key is not a person. `user` is filled from the owning account so the
          // routes have something to log, and roles never include `admin`: an API
          // key can never reach the operations surface no matter what it is sent.
          user: keySubject(resolved),
        } satisfies AuthContext;
      }
    }
  });

  // Origin + CSRF for cookie-authenticated writes.
  app.addHook('preHandler', async (request) => {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    const auth = request.auth;
    if (!auth || auth.sessionId.startsWith('key:')) return;
    const origin = request.headers.origin;
    if (origin && !config.security.csrfAllowOrigins.includes(origin) && !sameHostname(origin, request)) {
      throw new DomainError('FORBIDDEN', 'This request came from a host that is not allowed to act on your behalf.', { origin });
    }
    const supplied = request.headers['x-csrf-token'];
    if (!supplied || supplied !== auth.csrfToken) {
      throw new DomainError('CSRF_FAILED', 'Your session changed or the page is stale. Reload and try again.', {
        hint: 'missing or mismatched x-csrf-token',
      });
    }
  });
}

function keySubject(resolved: { userId: string | null; businessId?: string | null; keyId?: string }): PublicUser {
  const user = resolved.userId ? identity.userById(resolved.userId) : null;
  if (user) return identity.toPublicUser(user);
  return {
    id: resolved.userId ?? '',
    email: `api-key:${resolved.keyId ?? 'unknown'}`,
    fullName: 'API key',
    phone: null,
    country: 'KE',
    locale: 'en-KE',
    roles: resolved.businessId ? ['merchant'] : [],
    kycStatus: 'APPROVED',
    kycTier: 0,
    twoFactorEnabled: false,
    passkeyEnabled: false,
    defaultSettlementRail: 'MPESA',
    createdAt: new Date().toISOString(),
  } satisfies PublicUser;
}

/** Any authenticated caller: a signed-in session or a scoped API key. */
export function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.auth;
  if (!auth) {
    throw new DomainError('UNAUTHENTICATED', 'Sign in to continue.', {
      recovery: 'POST /v1/auth/login with an email and password, then send the session cookie.',
    });
  }
  return auth;
}

/**
 * Session-only routes (the dashboard and anything a key must not be able to do,
 * like reading a secret that is only ever shown once). Answering a key caller with
 * "use the API endpoint" is more honest than silently doing something different.
 */
export function requireSession(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request);
  if (auth.kind !== 'session') {
    throw new DomainError('FORBIDDEN', 'This action needs a signed-in session; an API key cannot do it.', {
      recovery: 'Use the corresponding REST endpoint for server-to-server calls.',
    });
  }
  return auth;
}

/** Scope check for API-key callers; a session caller passes by owning the account. */
export function requireScope(scope: string, auth: AuthContext): void {
  if (auth.kind !== 'apikey') return;
  if (!(auth.scopes ?? []).includes(scope)) {
    throw new DomainError('FORBIDDEN', `That API key was not granted ${scope}.`, {
      recovery: 'Create a key with the scope, or edit the existing one.',
    });
  }
}

export function requireAdmin(request: FastifyRequest): AuthContext {
  const auth = requireSession(request);
  if (!hasRole(auth.user.roles, 'ADMIN')) {
    throw new DomainError('FORBIDDEN', 'Administrator rights are required for operations data.');
  }
  return auth;
}

export function requireRole(request: FastifyRequest, roles: string[]): AuthContext {
  const auth = requireAuth(request);
  const held = auth.user.roles ?? [];
  if (!hasAnyRole(held, roles)) {
    throw new DomainError('FORBIDDEN', 'That area is for AuraPay staff accounts.', { held });
  }
  return auth;
}

/**
 * A cross-site page cannot send a request whose Origin host is the API's own host,
 * so an origin that matches the host being addressed is same-origin and CSRF-safe by
 * construction. That is what lets the app be served behind any hostname (a tunnel, a
 * preview, a partner deployment) without pasting origins into an env var — and a
 * request forged from another site still has that other site as its Origin and is
 * refused, with the CSRF token check applied on top either way.
 */
function sameHostname(origin: string, request: FastifyRequest): boolean {
  try {
    const from = new URL(origin).hostname;
    // The forwarded host is only honoured when this instance is configured to sit
    // behind a proxy: otherwise a client could name whatever host it liked.
    const forwarded = config.security.trustProxy ? request.headers['x-forwarded-host'] : '';
    const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded) || request.headers.host || '';
    const to = host.split(',')[0]!.split(':')[0] ?? '';
    if (!from || !to) return false;
    if (from === to) return true;
    // localhost and 127.0.0.1 are the same machine, not two different sites.
    return (from === 'localhost' && to === '127.0.0.1') || (from === '127.0.0.1' && to === 'localhost');
  } catch {
    return false;
  }
}

export function clientMeta(request: FastifyRequest) {
  return {
    ip: request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

/** Idempotency is opt-in per route but mandatory for anything that moves money. */
export function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const key = request.headers['idempotency-key'] ?? request.headers['x-idempotency-key'];
  return typeof key === 'string' && key.trim() ? key.trim().slice(0, 200) : undefined;
}

/**
 * Money leaves this API as decimal *strings*. A JSON number would silently turn a
 * 64-bit minor unit into a float, and "0.1 + 0.2" on a receipt is not a rounding
 * error — it is a broken promise.
 */
export function registerSerializers(app: FastifyInstance): void {
  app.addHook('preSerialization', async (_request, _reply, payload) => rewriteBigints(payload));
}

function rewriteBigints(value: unknown, depth = 0): unknown {
  if (depth > 24) return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => rewriteBigints(v, depth + 1));
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = rewriteBigints(v, depth + 1);
    return out;
  }
  return value;
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    const log = request.log;
    if (error instanceof DomainError) {
      const status = error.status;
      log.warn({ code: error.code, route: request.url }, error.message);
      return reply.code(status).send(error.toBody());
    }
    // A domain failure that arrives as a plain Error (the FX layer does this when a
    // rate is too old to quote from) is still a *known* condition. Turning it into
    // a 500 would tell the customer "our fault, try again" when the truth is
    // "the market moved, ask for a new price" — and a wrong retry instruction on a
    // payment screen costs money.
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code in ERROR_CODES) {
      const known = code as ErrorCode;
      const details = (error as { details?: Record<string, unknown> }).details;
      const err = new DomainError(known, (error as Error).message || messageFor(known), details);
      log.warn({ code: known, route: request.url }, (error as Error).message);
      return reply.code(statusFor(known)).send(err.toBody());
    }
    const validation = (error as { validation?: unknown[] }).validation;
    if (Array.isArray(validation) && validation.length) {
      return reply.code(422).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some of the details you entered are not valid.',
          fields: validation.map((v) => ({
            field: String((v as { instancePath?: string }).instancePath ?? ''),
            message: String((v as { message?: string }).message ?? 'invalid'),
          })),
        },
      });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many attempts in a short time. Wait a minute and try again.',
        },
      });
    }
    log.error({ err: error, url: request.url }, 'unhandled error');
    // Never leak internals; the request id is the handle support needs.
    return reply.code(500).send({
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong on our side, and the payment was not changed. Quote APX-1138 if you contact support.',
        requestId: request.id,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/v1')) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: `No AuraPay endpoint exists at ${request.method} ${request.url}.` },
      });
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });
}

export const boolField = (v: unknown): boolean => v === true || v === 'true' || v === '1' || v === 1;
export const numField = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
/**
 * A path parameter that arrives blank (a client that built `/v1/payments/` from an
 * undefined id) must be answered with a 404 of ours, not a 500 from the repository.
 */
export function requireId(value: string | undefined | null, what = 'payment'): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 120) {
    throw new DomainError('NOT_FOUND', `No ${what} id was given, so there is nothing to look up.`, { recovery: 'go_back' });
  }
  return id;
}

export const strField = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
/** For domain inputs whose optional fields are typed `string | null`. */
export const nullStrField = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
