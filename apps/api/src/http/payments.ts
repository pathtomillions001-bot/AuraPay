import type { FastifyInstance } from 'fastify';
import { DomainError, isTerminal, type PayableAsset, type NetworkCode, type RailCode, type RecipientKind } from '@aurapay/shared';
import { config } from '../config.js';
import * as payments from '../domain/payments.js';
import * as quotes from '../domain/quotes.js';
import * as recipients from '../domain/recipients.js';
import * as receipts from '../domain/receipts.js';
import * as refunds from '../domain/refunds.js';
import * as wallets from '../domain/wallets.js';
import * as sandbox from '../domain/sandbox.js';
import * as notifications from '../domain/notifications.js';
import { idempotencyKeyOf, numField, requireAuth, requireId, strField } from './util.js';

/**
 * The money-moving surface.
 *
 * Two rules apply to every route here:
 *  1. Anything that can move value takes an idempotency key and is rate limited
 *     per account, so a double-click or a retrying client cannot double-pay.
 *  2. Reads return backend state only. The client never learns "confirmed" from a
 *     timer, and neither do we.
 */
export function registerPaymentRoutes(app: FastifyInstance): void {
  /* ------------------------------- recipients ------------------------------ */

  app.get('/v1/recipients', async (request) => {
    const auth = requireAuth(request);
    const q = request.query as { query?: string; favourites?: string };
    return {
      recipients: recipients.list(auth.userId, { query: q.query, favouritesOnly: q.favourites === '1' }),
    };
  });

  app.post('/v1/recipients', { config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (request, reply) => {
    const auth = requireAuth(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const kind = strField(body.kind) as RecipientKind | undefined;
    if (!kind) throw new DomainError('VALIDATION_FAILED', 'Choose who you are paying: a phone number, a till, a PayBill or a bank account.');
    const rail = (strField(body.rail) ?? undefined) as RailCode | undefined;
    const saved = recipients.upsert(
      auth.userId,
      {
        kind,
        displayName: String(body.displayName ?? '').slice(0, 120),
        phone: strField(body.phone),
        till: strField(body.till),
        paybill: strField(body.paybill),
        accountReference: strField(body.accountReference),
        bankCode: strField(body.bankCode),
        bankAccount: strField(body.bankAccount),
        walletAddress: strField(body.walletAddress),
        network: strField(body.network) as NetworkCode | undefined,
        country: strField(body.country) ?? 'KE',
        note: strField(body.note),
        favourite: body.favourite === true,
        defaultAmountKesMajor: body.defaultAmountKesMajor === undefined ? undefined : numField(body.defaultAmountKesMajor),
      },
      rail ?? (kind === 'PHONE' ? 'MPESA' : kind === 'TILL' ? 'MPESA_TILL' : kind === 'PAYBILL' ? 'MPESA_PAYBILL' : 'BANK_TRANSFER'),
    );
    // Name resolution runs at save time so the *pay* screen can warn before money moves.
    const nameLookup = recipients.verify(saved);
    return reply.code(201).send({ recipient: saved, nameLookup });
  });

  app.patch('/v1/recipients/:id', async (request) => {
    const auth = requireAuth(request);
    const id = requireId((request.params as { id?: string }).id);
    const body = (request.body ?? {}) as { favourite?: boolean };
    if (typeof body.favourite === 'boolean') {
      recipients.setFavourite(auth.userId, id, body.favourite);
      return { ok: true, favourite: body.favourite };
    }
    throw new DomainError('VALIDATION_FAILED', 'Nothing to update was sent.');
  });

  app.delete('/v1/recipients/:id', async (request) => {
    const auth = requireAuth(request);
    const id = requireId((request.params as { id?: string }).id);
    recipients.remove(auth.userId, id);
    return { ok: true };
  });

  /* --------------------------------- quotes -------------------------------- */

  app.post(
    '/v1/quotes',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireAuth(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const kind = (strField(body.kind) ?? 'PHONE') as RecipientKind;
      const quote = quotes.create({
        userId: auth.userId,
        asset: (strField(body.asset) ?? 'USDT') as PayableAsset,
        network: strField(body.network) as NetworkCode | undefined,
        rail: strField(body.rail) as RailCode | undefined,
        kind,
        country: strField(body.country) ?? auth.user.country ?? 'KE',
        recipientAmountKesMajor: body.recipientAmountKesMajor === undefined ? undefined : numField(body.recipientAmountKesMajor),
        payAmountMinor: typeof body.payAmountMinor === 'string' ? body.payAmountMinor : undefined,
        recipientId: strField(body.recipientId) ?? null,
        verifiedRecipient: body.verifiedRecipient === true,
      });
      return reply.code(201).send({ quote, ttlSeconds: config.quotes.ttlSeconds });
    },
  );

  app.get('/v1/quotes/:id', async (request) => {
    const auth = requireAuth(request);
    const id = requireId((request.params as { id?: string }).id);
    // Re-reading a quote re-reads the market: a quote whose rate went stale is
    // reported as stale, not silently re-priced.
    return { quote: quotes.get(id, auth.userId) };
  });

  /* -------------------------------- payments ------------------------------- */

  app.post(
    '/v1/payments',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireAuth(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const quoteId = strField(body.quoteId);
      if (!quoteId) throw new DomainError('VALIDATION_FAILED', 'Ask for a price before you pay — no quote, no payment.');
      const recipientId = strField(body.recipientId) ?? null;
      const inline = body.recipient as Record<string, unknown> | undefined;
      // Checked here, before the domain consumes the quote. A missing recipient is a
      // form error, not a reason to burn a 90-second price and make the customer ask
      // for a new one.
      if (!recipientId && !inline && !strField(body.paymentLinkId)) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'Choose who you are paying before you confirm the price.',
          { field: 'recipientId', required: ['recipientId or recipient'] },
        );
      }
      const created = await payments.create({
        userId: auth.userId,
        quoteId,
        recipientId,
        recipient: inline
          ? {
              kind: (strField(inline.kind) ?? 'PHONE') as never,
              displayName: strField(inline.displayName) ?? null,
              phone: strField(inline.phone) ?? null,
              till: strField(inline.till) ?? null,
              paybill: strField(inline.paybill) ?? null,
              accountReference: strField(inline.accountReference) ?? null,
              bankCode: strField(inline.bankCode) ?? null,
              bankAccount: strField(inline.bankAccount) ?? null,
            }
          : undefined,
        externalId: strField(body.externalId) ?? null,
        idempotencyKey: idempotencyKeyOf(request) ?? null,
        paymentLinkId: strField(body.paymentLinkId) ?? null,
        strongConfirmation: body.strongConfirmation === true,
        note: strField(body.note),
      });
      return reply.code(201).send(created);
    },
  );

  app.get('/v1/payments', async (request) => {
    const auth = requireAuth(request);
    const q = request.query as Record<string, string | undefined>;
    return payments.list({
      userId: auth.userId,
      status: (q.status as never) ?? null,
      asset: (q.asset as never) ?? null,
      rail: (q.rail as never) ?? null,
      search: q.search ?? null,
      from: q.from ?? null,
      to: q.to ?? null,
      limit: Math.min(100, numField(q.limit, 25)),
      cursor: q.cursor ?? null,
    });
  });

  /**
   * The single object behind the processing screen, the success screen and the
   * admin detail. The client polls this (and subscribes to SSE); it never
   * constructs a state of its own.
   */
  app.get('/v1/payments/:id', async (request) => {
    const auth = requireAuth(request);
    const id = requireId((request.params as { id?: string }).id);
    return payments.view(id, { userId: auth.userId });
  });

  app.post('/v1/payments/:id/cancel', async (request) => {
    const auth = requireAuth(request);
    const id = requireId((request.params as { id?: string }).id);
    await payments.cancel(id, auth.userId);
    return payments.view(id, { userId: auth.userId });
  });

  app.post('/v1/payments/:id/refresh', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    const auth = requireAuth(request);
    const id = requireId((request.params as { id?: string }).id);
    // One eager look at the chain when the user asks for it. The watcher does the
    // waiting; this only avoids a few seconds of "still waiting" after a tap.
    await payments.drive(id, 'user-refresh');
    return payments.view(id, { userId: auth.userId });
  });

  /* -------------------------------- receipts ------------------------------- */

  app.get('/v1/payments/:id/receipt', async (request, reply) => {
    const auth = requireAuth(request);
    const id = requireId((request.params as { id?: string }).id);
    const payload = receipts.byPayment(id);
    if (!payload) throw new DomainError('NOT_FOUND', 'The receipt for that payment has not been issued yet.');
    const want = (request.query as { format?: string }).format;
    if (want === 'txt' || want === 'text') {
      return reply.type('text/plain; charset=utf-8').send(receipts.asText(payload));
    }
    // One envelope for every format, so a client that asks for JSON reads the same
    // fields it reads for the printed document.
    if (want === 'json') return { payload, integrity: payload.contentSha256 };
    return { payload, printUrl: `/receipts/print/${id}`, integrity: payload.contentSha256 };
  });

  app.post('/v1/payments/:id/receipt/share', async (request) => {
    const auth = requireAuth(request);
    const id = requireId((request.params as { id?: string }).id);
    // Ownership comes from the payment, which the domain already scopes per user.
    const view = payments.view(id, { userId: auth.userId });
    const receiptId = view.receiptId;
    if (!receiptId) throw new DomainError('NOT_FOUND', 'No receipt to share yet.');
    const days = Math.max(1, Math.min(90, numField((request.body as { days?: number } | undefined)?.days, 30)));
    return receipts.createShareLink(receiptId, days * 86_400);
  });

  app.get('/v1/receipts/shared/:token', async (request) => {
    const { token } = request.params as { token: string };
    // A share link is read-only, expires, and reveals no account identifiers.
    const payload = receipts.byShareToken(token);
    if (!payload) throw new DomainError('NOT_FOUND', 'That shared receipt link has expired or was revoked.');
    return payload;
  });

  /* -------------------------------- refunds -------------------------------- */

  app.get('/v1/payments/:id/refund-capability', async (request) => {
    const auth = requireAuth(request);
    const id = requireId((request.params as { id?: string }).id);
    payments.view(id, { userId: auth.userId }); // ownership check before describing anything
    return refunds.capability(id);
  });

  app.post('/v1/payments/:id/refund', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const auth = requireAuth(request);
    const id = requireId((request.params as { id?: string }).id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = await refunds.refund(id, {
      actor: auth.user.email || auth.userId,
      mode: body.mode === 'MANUAL' ? 'MANUAL' : 'AUTO',
      reason: strField(body.reason) ?? 'Refund requested from the app.',
      reasonCode: strField(body.reasonCode),
      amountKesMinor: body.amountKesMajor === undefined ? undefined : BigInt(Math.round(numField(body.amountKesMajor) * 100)),
    });
    if (auth.userId) {
      notifications.push(auth.userId, {
        title: 'Refund recorded',
        body: result.detail,
        severity: 'info',
        link: `/app/transactions/${id}`,
        paymentIntentId: id,
      });
    }
    return reply.code(202).send(result);
  });

  /* ------------------------- sandbox-only affordances ---------------------- */

  /**
   * Present in sandbox mode only, and refused with a clear message otherwise —
   * an operator must never be able to hand a customer "confirmed" money.
   */
  app.post('/v1/sandbox/simulate-deposit', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    if (!config.demo.sandboxActions) {
      throw new DomainError('FORBIDDEN', 'Simulating a deposit is only possible in sandbox mode.');
    }
    const body = (request.body ?? {}) as { paymentId?: string; amountMajor?: string; asset?: PayableAsset };
    if (!body.paymentId) throw new DomainError('VALIDATION_FAILED', 'Which payment are you funding?');
    const result = await sandbox.simulateDeposit({ paymentId: body.paymentId, amountMajor: body.amountMajor, asset: body.asset });
    return { ...result, payments: payments.view(body.paymentId, {}) };
  });

  app.post('/v1/sandbox/force-outcome', async (request) => {
    if (!config.demo.sandboxActions) {
      throw new DomainError('FORBIDDEN', 'Forcing an outcome is only possible in sandbox mode.');
    }
    const body = (request.body ?? {}) as { paymentId?: string; outcome?: 'PAYOUT_FAIL' | 'MANUAL_REVIEW' | 'CONFIRM_NOW' | 'QUOTE_EXPIRE' };
    if (!body.paymentId || !body.outcome) throw new DomainError('VALIDATION_FAILED', 'Pick a payment and an outcome.');
    return sandbox.forceOutcome(body.paymentId, body.outcome);
  });

  app.post('/v1/sandbox/top-up', async (request) => {
    if (!config.demo.sandboxActions) throw new DomainError('FORBIDDEN', 'Top-up is a sandbox demo control.');
    const auth = requireAuth(request);
    const body = (request.body ?? {}) as { asset?: PayableAsset; network?: NetworkCode; amountMajor?: string };
    if (!body.asset || !body.network || !body.amountMajor) {
      throw new DomainError('VALIDATION_FAILED', 'Choose an asset, a network and an amount.');
    }
    const result = sandbox.topUp({ userId: auth.userId, asset: body.asset, network: body.network, amountMajor: body.amountMajor });
    return { ...result, balances: wallets.balancesFor(auth.userId) };
  });
}
