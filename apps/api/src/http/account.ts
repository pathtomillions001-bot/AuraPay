import type { FastifyInstance } from 'fastify';
import { DomainError, type PayableAsset, type NetworkCode } from '@aurapay/shared';
import * as payments from '../domain/payments.js';
import * as wallets from '../domain/wallets.js';
import * as notifications from '../domain/notifications.js';
import * as analytics from '../domain/analytics.js';
import * as compliance from '../domain/compliance.js';
import { getDb } from '../db/index.js';
import { numField, requireAuth, requireId, strField } from './util.js';

/** Everything a customer can see about themselves. */
export function registerAccountRoutes(app: FastifyInstance): void {
  app.get('/v1/account/overview', async (request) => {
    const auth = requireAuth(request);
    return payments.dashboard(auth.userId);
  });

  app.get('/v1/account/balances', async (request) => {
    const auth = requireAuth(request);
    return wallets.balancesFor(auth.userId);
  });

  app.get('/v1/account/analytics', async (request) => {
    const auth = requireAuth(request);
    const q = request.query as Record<string, string | undefined>;
    return analytics.summary({
      userId: auth.userId,
      from: q.from ?? null,
      to: q.to ?? null,
      asset: (q.asset as never) ?? null,
      rail: (q.rail as never) ?? null,
    });
  });

  app.get('/v1/account/transactions/:id', async (request) => {
    const auth = requireAuth(request);
    const id = requireId((request.params as { id?: string }).id);
    return payments.view(id, { userId: auth.userId });
  });

  /**
   * The audit trail behind the "what happened" expander on a transaction. Only
   * events recorded for that payment, only for its owner, in order.
   */
  app.get('/v1/account/transactions/:id/events', async (request) => {
    const auth = requireAuth(request);
    const id = requireId((request.params as { id?: string }).id);
    payments.view(id, { userId: auth.userId });
    const rows = getDb().all<{
      id: string;
      type: string;
      message: string | null;
      actor: string | null;
      created_at: string;
      data: string | null;
    }>(
      // The table records transitions, not generic events: `type` is the state reached
      // and `message` is the note the engine wrote with it, so the timeline in the app
      // reads the same whether it is rendered from payment_events or an event bus row.
      `SELECT id, to_state AS type, note AS message, actor, created_at, metadata AS data
       FROM payment_events
       WHERE payment_intent_id = ? ORDER BY created_at, id`,
      [id],
    );
    return {
      events: rows.map((r) => ({
        id: r.id,
        type: r.type,
        message: r.message,
        actor: r.actor,
        at: r.created_at,
        // An unreadable metadata blob is a display detail, not a reason to fail the
        // whole timeline: pass it through as text so the row is still there.
        data: (() => {
          if (!r.data) return null;
          try {
            return JSON.parse(r.data) as unknown;
          } catch {
            return r.data;
          }
        })(),
      })),
    };
  });

  app.get('/v1/account/notifications', async (request) => {
    const auth = requireAuth(request);
    const q = request.query as { unread?: string; limit?: string };
    const items = notifications.list(auth.userId, { unreadOnly: q.unread === '1', limit: Math.min(100, numField(q.limit, 25)) });
    return { items, unread: notifications.unreadCount(auth.userId) };
  });

  app.post('/v1/account/notifications/read', async (request) => {
    const auth = requireAuth(request);
    const body = (request.body ?? {}) as { id?: string };
    notifications.markRead(auth.userId, body.id ?? null);
    return { ok: true, unread: notifications.unreadCount(auth.userId) };
  });

  /* --------------------------------- wallets ------------------------------- */

  app.get('/v1/wallets', async (request) => {
    const auth = requireAuth(request);
    return { wallets: wallets.listWallets(auth.userId), dataOriginNote: 'Balances come from the ledger, never from a client estimate.' };
  });

  app.post('/v1/wallets/link', async (request) => {
    const auth = requireAuth(request);
    const body = (request.body ?? {}) as Record<string, string>;
    if (!body.asset || !body.network || !body.address || !body.label) {
      throw new DomainError('VALIDATION_FAILED', 'An external wallet needs an asset, a network, an address and a label.');
    }
    // We never take custody of an external wallet: only its address is stored, and
    // anything sent there is outside AuraPay's ledger and outside its protection.
    return wallets.linkExternalWallet({
      userId: auth.userId,
      asset: body.asset as PayableAsset,
      network: body.network as NetworkCode,
      address: body.address,
      label: body.label,
    });
  });

  app.delete('/v1/wallets/:id', async (request) => {
    const auth = requireAuth(request);
    const id = requireId((request.params as { id?: string }).id);
    wallets.unlinkWallet(auth.userId, id);
    return { ok: true };
  });

  app.post('/v1/wallets/reconcile', async (request) => {
    const auth = requireAuth(request);
    return wallets.reconcile(auth.userId);
  });

  /* ------------------------------ compliance ------------------------------- */

  app.get('/v1/account/kyc', async (request) => {
    const auth = requireAuth(request);
    return compliance.kycFor(auth.userId);
  });

  app.post('/v1/account/kyc', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request) => {
    const auth = requireAuth(request);
    const body = (request.body ?? {}) as Record<string, string>;
    if (!body.documentType || !body.documentNumber || !body.tier) {
      throw new DomainError('VALIDATION_FAILED', 'We need a document type, its number and the tier you are applying for.');
    }
    return compliance.submitKyc({
      userId: auth.userId,
      documentType: body.documentType,
      documentNumber: body.documentNumber,
      country: body.country ?? auth.user.country ?? 'KE',
      tier: body.tier as never,
    });
  });

  app.get('/v1/account/limits', async (request) => {
    const auth = requireAuth(request);
    const { limitsFor } = await import('../domain/identity.js');
    return limitsFor(auth.userId);
  });

  /* ---------------------------- replay protection -------------------------- */

  /** Lets a client ask "did my last submit go through?" without guessing. */
  app.get('/v1/account/idempotency/:key', async (request) => {
    const auth = requireAuth(request);
    const { key } = request.params as { key: string };
    const row = getDb().maybeOne<{ key: string; scope: string; response_code: number | null; response_body: string | null; created_at: string; expires_at: string }>(
      `SELECT key, scope, response_code, response_body, created_at, expires_at FROM idempotency_keys
       WHERE user_id = ? AND key = ? ORDER BY created_at DESC LIMIT 1`,
      [auth.userId, key],
    );
    if (!row) throw new DomainError('NOT_FOUND', 'No submit was recorded with that key.');
    // The point of this route is that an unknown outcome is *reported as unknown*:
    // a key with no response code means the first request is still in flight, and
    // the client must poll the payment rather than assume it failed and resubmit.
    return {
      key: row.key,
      scope: row.scope,
      state: row.response_code === null ? 'IN_FLIGHT' : row.response_code === 200 ? 'COMPLETED' : 'COMPLETED_WITH_ERROR',
      responseCode: row.response_code,
      response: row.response_body ? (JSON.parse(row.response_body) as unknown) : null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  });
}
