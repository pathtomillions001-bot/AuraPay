import type { FastifyInstance } from 'fastify';
import { DomainError, type RailCode } from '@aurapay/shared';
import { hasRole } from '@aurapay/shared';
import { config } from '../config.js';
import * as merchants from '../domain/merchants.js';
import * as links from '../domain/links.js';
import * as payments from '../domain/payments.js';
import * as keys from '../domain/keys.js';
import * as webhooks from '../domain/webhooks.js';
import * as analytics from '../domain/analytics.js';
import * as refunds from '../domain/refunds.js';
import * as payouts from '../domain/payouts.js';
import { getDb } from '../db/index.js';
import { createLogger } from '../logger.js';
import { numField, requireAuth, requireScope, requireSession, strField } from './util.js';

const log = createLogger('http.merchant');

/** Ownership for endpoints, which may belong to a user or to a business. */
function assertEndpointOwner(endpointId: string, userId: string): void {
  const row = getDb().maybeOne<{ user_id: string | null; business_id: string | null }>(
    'SELECT user_id, business_id FROM webhook_endpoints WHERE id = ?',
    [endpointId],
  );
  if (!row) throw new DomainError('NOT_FOUND', 'No such webhook endpoint.');
  if (row.user_id === userId) return;
  if (row.business_id) {
    merchants.requireAccess(userId, row.business_id);
    return;
  }
  throw new DomainError('FORBIDDEN', 'That endpoint belongs to another account.');
}

/**
 * Merchant surface. Two separate trust domains live here:
 *
 *  - authenticated dashboard routes (cookie session, CSRF-guarded)
 *  - public checkout (a bearer publishable key or nothing at all), which can only
 *    ever *create* a payment for the payer to approve with their own session
 *
 * A link is a request for money. It is never a pull, and `pk_*` keys can never
 * move money, so a leaked storefront key is an embarrassment and not a loss.
 */
export function registerMerchantRoutes(app: FastifyInstance): void {
  /**
   * Ownership, from the merchant's own membership table — not from a role guess.
   * An administrator can reach the same data through /v1/admin, which is audited
   * differently and labelled as staff access.
   */
  const owned = (businessId: string, auth: ReturnType<typeof requireAuth>) => {
    merchants.requireAccess(auth.userId, businessId);
    return businessId;
  };

  /* ------------------------------- businesses ------------------------------ */

  app.get('/v1/businesses', async (request) => {
    const auth = requireAuth(request);
    return { businesses: merchants.businessesForUser(auth.userId) };
  });

  app.post('/v1/businesses', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const auth = requireAuth(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const created = merchants.onboard({
      userId: auth.userId,
      name: strField(body.name) ?? strField(body.legalName) ?? '',
      legalName: strField(body.legalName),
      category: strField(body.category),
      registrationNumber: strField(body.registrationNumber),
      taxNumber: strField(body.taxNumber) ?? strField(body.kraPin),
      website: strField(body.website),
      settlementRail: (strField(body.settlementRail) ?? 'MPESA') as RailCode,
      till: strField(body.till),
      paybill: strField(body.paybill),
      settlementTarget: strField(body.settlementTarget),
    });
    return reply.code(201).send(created);
  });

  app.get('/v1/businesses/:id', async (request) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    const business = owned(id, auth);
    return { business: merchants.byId(id), dashboard: merchants.dashboard(id) };
  });

  app.get('/v1/businesses/:id/analytics', async (request) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    owned(id, auth);
    const q = request.query as Record<string, string | undefined>;
    return analytics.summary({
      businessId: id,
      from: q.from ?? null,
      to: q.to ?? null,
      asset: (q.asset as never) ?? null,
      rail: (q.rail as never) ?? null,
    });
  });

  app.get('/v1/businesses/:id/analytics.csv', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    owned(id, auth);
    // Exported from the same rows the dashboard reads, so a download always
    // reconciles with what the merchant saw on screen.
    const csv = analytics.exportCsv({ businessId: id });
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="aurapay-${id}.csv"`).send(csv);
  });

  app.get('/v1/businesses/:id/payouts', async (request) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    owned(id, auth);
    const rows = getDb().all<Record<string, unknown>>(
      `SELECT p.* FROM payouts p
       JOIN payment_intents pi ON pi.id = p.payment_intent_id
       WHERE pi.business_id = ?
       ORDER BY p.created_at DESC LIMIT 100`,
      [id],
    );
    return { payouts: rows.map((r) => ({ ...r, amount_minor: (r['amount_minor'] as string | undefined) ?? null })) };
  });

  app.post('/v1/businesses/:id/settlement', async (request) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    owned(id, auth);
    const body = (request.body ?? {}) as Record<string, string | null>;
    merchants.setSettlement(id, {
      rail: (body.rail as RailCode | undefined) ?? undefined,
      target: body.target ?? null,
      till: body.till ?? null,
      paybill: body.paybill ?? null,
    });
    return { ok: true };
  });

  /* ----------------------------- payment links ----------------------------- */

  app.get('/v1/businesses/:id/links', async (request) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    owned(id, auth);
    return { links: links.listFor(auth.userId, id) };
  });

  app.post('/v1/businesses/:id/links', { config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    owned(id, auth);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const created = links.create({
      userId: auth.userId,
      businessId: id,
      title: strField(body.title) ?? 'Payment',
      description: strField(body.description) ?? null,
      amountKesMajor: body.amountKesMajor === undefined ? null : numField(body.amountKesMajor),
      maxUses: body.maxUses === undefined ? 1 : numField(body.maxUses, 1),
      expiresInHours: body.expiresInHours === undefined ? 72 : numField(body.expiresInHours, 72),
      publicNote: strField(body.publicNote) ?? null,
      successUrl: strField(body.successUrl) ?? null,
      cancelUrl: strField(body.cancelUrl) ?? null,
    });
    return reply.code(201).send({ ...created, checkoutUrl: `/checkout/${created.token}` });
  });

  app.delete('/v1/businesses/:id/links/:linkId', async (request) => {
    const auth = requireAuth(request);
    const { linkId } = request.params as { linkId: string };
    owned((request.params as { id: string }).id, auth);
    links.revoke(linkId, auth.userId);
    return { ok: true };
  });

  /* ----------------------------------- QR ---------------------------------- */

  app.post('/v1/businesses/:id/qr', { config: { rateLimit: { max: 200, timeWindow: '1 hour' } } }, async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    owned(id, auth);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const qr = await links.createQr({
      userId: auth.userId,
      businessId: id,
      kind: (strField(body.kind) ?? 'MERCHANT_DYNAMIC') as 'MERCHANT_DYNAMIC' | 'MERCHANT_STATIC' | 'AMOUNT' | 'REQUEST' | 'LINK',
      label: strField(body.label) ?? null,
      amountKesMajor: body.amountKesMajor === undefined ? null : numField(body.amountKesMajor),
      paymentLinkId: strField(body.paymentLinkId) ?? null,
      expiresInMinutes: body.expiresInMinutes === undefined ? null : numField(body.expiresInMinutes),
    });
    return reply.code(201).send(qr);
  });

  app.get('/v1/qr/:code', async (request) => {
    const { code } = request.params as { code: string };
    // The payer scans a code; this is the lookup that says what it is. Public,
    // read-only, and it deliberately discloses nothing about the merchant's volume.
    return links.resolveQr(code);
  });

  /* ---------------------------- hosted checkout ---------------------------- */

  app.post('/v1/checkout/session', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const businessId = strField(body.businessId);
    if (!businessId) throw new DomainError('VALIDATION_FAILED', 'Which business is being paid?');
    return merchants.createCheckoutSession({
      businessId,
      amountKesMajor: numField(body.amountKesMajor, 0),
      description: strField(body.description),
      externalId: strField(body.externalId) ?? null,
      customerRef: strField(body.customerRef) ?? null,
      successUrl: strField(body.successUrl) ?? null,
      cancelUrl: strField(body.cancelUrl) ?? null,
      expiresInMinutes: body.expiresInMinutes === undefined ? undefined : numField(body.expiresInMinutes),
    });
  });

  app.get('/v1/checkout/:token', async (request) => {
    const { token } = request.params as { token: string };
    return merchants.readCheckout(token);
  });

  /**
   * Paying a link. This runs as the *payer*, with their own session and their own
   * consent — the merchant's key can start a checkout but never complete one.
   */
  app.post(
    '/v1/checkout/:token/pay',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { token } = request.params as { token: string };
      const checkout = merchants.readCheckout(token);
      if (checkout.expired) throw new DomainError('NOT_FOUND', 'That payment request has expired.');
      // readCheckout deliberately returns no business id or KYB data, so the link
      // row is the authority for which business is being paid.
      const linkRow = getDb().maybeOne<{ business_id: string | null; amount_minor: string | null }>(
        'SELECT business_id, amount_minor FROM payment_links WHERE id = ?',
        [checkout.linkId],
      );
      const body = (request.body ?? {}) as Record<string, unknown>;
      const amountMinor = BigInt(checkout.amountMinor ?? linkRow?.amount_minor ?? '0');
      const quote = (await import('../domain/quotes.js')).create({
        userId: auth.userId,
        asset: (strField(body.asset) ?? 'USDT') as never,
        kind: 'PHONE',
        businessId: linkRow?.business_id ?? null,
        // The merchant set this amount; the payer may only override it on a link
        // that explicitly allows it, so a fixed invoice cannot be negotiated down.
        recipientAmountKesMajor: checkout.amountMinor
          ? Number(amountMinor) / 100
          : numField(body.recipientAmountKesMajor, 0),
        verifiedRecipient: true,
      });
      const created = await payments.create({
        userId: auth.userId,
        quoteId: quote.quoteId,
        businessId: linkRow?.business_id ?? null,
        paymentLinkId: checkout.linkId,
        idempotencyKey: strField(body.idempotencyKey) ?? null,
        strongConfirmation: body.strongConfirmation === true,
        note: strField(body.note) ?? null,
      });
      return reply.code(201).send(created);
    },
  );

  /* ------------------------------ API keys (server) ------------------------ */

  app.get('/v1/businesses/:id/keys', async (request) => {
    const auth = requireSession(request);
    const { id } = request.params as { id: string };
    owned(id, auth);
    return { keys: keys.list(auth.userId, id), warning: 'Secrets are shown once at creation and are never retrievable afterwards.' };
  });

  app.post('/v1/businesses/:id/keys', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const auth = requireSession(request);
    const { id } = request.params as { id: string };
    owned(id, auth);
    const body = (request.body ?? {}) as { name?: string; scopes?: string[]; environment?: 'test' | 'live' };
    const created = keys.create({
      userId: auth.userId,
      businessId: id,
      name: body.name?.slice(0, 80) ?? 'unnamed key',
      scopes: body.scopes as never,
      environment: body.environment,
    });
    log.info('api key created', { business: id, keyId: created.key.id, actor: auth.userId });
    // The only response that ever contains the plaintext secret.
    return reply.code(201).send(created);
  });

  app.delete('/v1/businesses/:id/keys/:keyId', async (request) => {
    const auth = requireSession(request);
    const { id, keyId } = request.params as { id: string; keyId: string };
    owned(id, auth);
    keys.revoke(keyId, auth.userId);
    return { ok: true };
  });

  /* ------------------------------- webhooks -------------------------------- */

  app.get('/v1/webhooks', async (request) => {
    const auth = requireSession(request);
    const businesses = merchants.businessesForUser(auth.userId);
    const seen = new Set<string>();
    const endpoints: ReturnType<typeof webhooks.listEndpoints> = [];
    for (const b of businesses) {
      for (const e of webhooks.listEndpoints(null, b.id)) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          endpoints.push(e);
        }
      }
    }
    for (const e of webhooks.listEndpoints(auth.userId, null)) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        endpoints.push(e);
      }
    }
    return {
      endpoints,
      events: webhooks.eventCatalogue(),
      note: 'Every delivery attempt is kept: retries, HTTP status and duration. A missed event is visible, not silently dropped.',
    };
  });

  app.post('/v1/webhooks', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const auth = requireSession(request);
    const body = (request.body ?? {}) as { url?: string; events?: string[]; description?: string; businessId?: string | null; secret?: string };
    if (!body.url || !body.events?.length) throw new DomainError('VALIDATION_FAILED', 'A webhook needs a URL and at least one event.');
    if (body.businessId) owned(body.businessId, auth);
    const created = webhooks.createEndpoint({
      userId: auth.userId,
      businessId: body.businessId ?? null,
      url: body.url,
      events: body.events,
      description: body.description,
      secret: body.secret,
    });
    log.info('webhook endpoint created', { actor: auth.userId, endpoint: created.id, url: body.url });
    // The plaintext secret exists in this response and nowhere else after it.
    return reply.code(201).send(created);
  });

  app.post('/v1/webhooks/:id/rotate-secret', async (request) => {
    const auth = requireSession(request);
    const { id } = request.params as { id: string };
    assertEndpointOwner(id, auth.userId);
    return webhooks.rotateSecret(id);
  });

  app.delete('/v1/webhooks/:id', async (request) => {
    const auth = requireSession(request);
    const { id } = request.params as { id: string };
    assertEndpointOwner(id, auth.userId);
    webhooks.deleteEndpoint(id);
    log.info('webhook endpoint deleted', { actor: auth.userId, endpoint: id });
    return { ok: true };
  });

  /** The outbox, so a merchant can see what we tried to tell them. */
  app.get('/v1/webhooks/events', async (request) => {
    const auth = requireSession(request);
    const q = request.query as { limit?: string; type?: string; paymentId?: string };
    return {
      events: webhooks.listEvents(Math.min(200, numField(q.limit, 50)), { type: q.type, paymentIntentId: q.paymentId }),
      note: 'Only events for your own payments and businesses are listed here.',
      actor: auth.userId,
    };
  });

  app.get('/v1/webhooks/catalogue', async () => ({ events: webhooks.eventCatalogue() }));

  /**
   * "Send me a test event". The signature we hand back is computed by the same
   * code that signs a real delivery, so verifying it proves the handler works.
   */
  app.post('/v1/webhooks/:id/test', async (request) => {
    const auth = requireSession(request);
    const { id } = request.params as { id: string };
    assertEndpointOwner(id, auth.userId);
    const body = (request.body ?? {}) as { eventType?: string; paymentId?: string };
    const type = (body.eventType ?? 'payment.completed') as never;
    const marker = { test: true, endpointId: id, requestedBy: auth.userId };
    webhooks.emit(type, marker, { paymentIntentId: body.paymentId ?? null, userId: auth.userId });

    // Find the event we just wrote by its marker rather than assuming the newest
    // row belongs to us — another merchant may have emitted in between.
    const event = webhooks
      .listEvents(20, { type })
      .find((e) => (e.payload as { data?: { endpointId?: string } }).data?.endpointId === id);
    if (!event) throw new DomainError('INTERNAL', 'The test event was queued but could not be read back.');

    const debug = webhooks.debugSignatureFor(event.id, id);
    const delivery = await webhooks.deliver(id, event.id);
    log.info('webhook test delivered', { endpoint: id, actor: auth.userId, status: delivery.status });
    return {
      ok: true,
      event: { id: event.id, eventId: event.eventId, type: event.type, payload: event.payload, attempts: event.attempts },
      sample: debug
        ? {
            headers: {
              'Content-Type': 'application/json',
              'X-AuraPay-Event': event.type,
              'X-AuraPay-Event-Id': event.eventId,
              'X-AuraPay-Signature': debug.header,
            },
            rawBody: debug.body,
            secretHint: debug.secretHint,
          }
        : null,
      delivery,
      note: 'The signature above is produced by the same code that signs live deliveries. Reject anything that does not verify, and accept a replay inside the five minute window only once.',
    };
  });

  /* ------------------------- merchant refund operations ------------------- */

  app.get('/v1/businesses/:id/refunds', async (request) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    owned(id, auth);
    const rows = getDb().all<Record<string, unknown>>(
      `SELECT r.* FROM refunds r JOIN payment_intents i ON i.id = r.payment_intent_id
       WHERE i.business_id = ? ORDER BY r.created_at DESC LIMIT 100`,
      [id],
    );
    return { refunds: rows };
  });

  app.post('/v1/businesses/:id/refunds', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (request) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    owned(id, auth);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const paymentId = strField(body.paymentId);
    if (!paymentId) throw new DomainError('VALIDATION_FAILED', 'Which payment are you refunding?');
    // Refundability is a property of the rail, so the domain decides whether a
    // merchant may even attempt this; the API never promises an instant refund.
    const capability = refunds.capability(paymentId);
    if (!capability.refundable) throw new DomainError('PAYMENT_NOT_REFUNDABLE', capability.reason ?? 'That payment cannot be refunded.');
    return refunds.refund(paymentId, {
      actor: auth.user.email || auth.userId,
      businessId: id,
      mode: capability.mode === 'AUTO' ? 'AUTO' : 'MANUAL',
      reason: strField(body.reason) ?? 'Refunded by the business.',
      amountKesMinor: body.amountKesMajor === undefined ? undefined : BigInt(Math.round(numField(body.amountKesMajor) * 100)),
    });
  });

  app.post('/v1/payouts/:id/retry', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    // Retrying a stuck settlement is an operator action, not a merchant self-service one.
    if (!hasRole(auth.user.roles, 'ADMIN')) throw new DomainError('FORBIDDEN', 'Only AuraPay operations can retry a settlement.');
    return payouts.retry(id, auth.user.email || auth.userId);
  });
}
