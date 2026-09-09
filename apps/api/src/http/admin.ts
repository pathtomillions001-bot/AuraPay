import type { FastifyInstance } from 'fastify';
import { DomainError, formatKes, unitOf, type PayableAsset, type RailCode } from '@aurapay/shared';
import { hasRole } from '@aurapay/shared';
import { config } from '../config.js';
import * as analytics from '../domain/analytics.js';
import * as treasury from '../domain/treasury.js';
import * as compliance from '../domain/compliance.js';
import * as feesDomain from '../domain/fees.js';
import * as sandbox from '../domain/sandbox.js';
import * as ledger from '../domain/ledger.js';
import * as payments from '../domain/payments.js';
import * as refunds from '../domain/refunds.js';
import * as payouts from '../domain/payouts.js';
import * as merchants from '../domain/merchants.js';
import * as providers from '../domain/providers.js';
import * as routing from '../domain/routing.js';
import * as realtime from '../domain/realtime.js';
import { getDb } from '../db/index.js';
import { createLogger } from '../logger.js';
import { numField, requireSession, strField } from './util.js';

const log = createLogger('http.admin');

/**
 * Operations surface. Two disciplines hold here:
 *
 *  - every number is read from the same tables the customer-facing screens use, so
 *    an operator and a customer can never be shown different truths;
 *  - every mutation carries an actor and a written reason and lands in the audit
 *    trail. Nothing here edits the ledger: corrections are compensating entries,
 *    which is why there is no "adjust balance" route to misuse.
 */
export function registerAdminRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/v1/admin')) return;
    const auth = requireSession(request);
    if (!hasRole(auth.user.roles, 'ADMIN')) {
      log.warn('admin route denied', { userId: auth.userId, route: request.url });
      return reply.code(403).send({
        code: 'FORBIDDEN',
        message: 'Administrator rights are required for operations data.',
        recovery: 'Ask an AuraPay administrator to grant access.',
      });
    }
    if (request.method !== 'GET') {
      recordAudit({
        actorType: 'ADMIN',
        actor: auth.userId,
        action: `admin.${request.method.toLowerCase()} ${requestRoute(request.url)}`,
        request,
      });
    }
  });

  /* -------------------------------- overview -------------------------------- */

  app.get('/v1/admin/overview', async () => {
    const db = getDb();
    const open = db.maybeOne<{ c: number; oldest: string | null }>(
      `SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM payment_intents
       WHERE status NOT IN ('COMPLETED','FAILED','REFUNDED','CANCELLED')`,
    );
    const stuck = db.maybeOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM payment_intents
       WHERE status NOT IN ('COMPLETED','FAILED','REFUNDED','CANCELLED')
         AND updated_at < datetime('now','-30 minutes')`,
    );
    const cases = db.maybeOne<{ open: number; breach: number }>(
      `SELECT SUM(CASE WHEN status IN ('OPEN','INVESTIGATING') THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN status IN ('OPEN','INVESTIGATING') AND due_at < datetime('now') THEN 1 ELSE 0 END) AS breach
       FROM compliance_cases`,
    );
    return {
      mode: config.mode,
      // Ordered the way the business actually hurts: money in flight first.
      payments: {
        open: open?.c ?? 0,
        oldestOpen: open?.oldest ?? null,
        // "Open" is normal. "Open and untouched for 30 minutes" is an incident.
        stalledOver30m: stuck?.c ?? 0,
      },
      cases: { open: cases?.open ?? 0, slaBreached: cases?.breach ?? 0 },
      queue: (await import('../workers/queue.js')).stats(),
      treasury: treasury.overview(),
      alerts: treasury.alerts(),
      platform: analytics.platform(),
      providers: providers.PROVIDERS.map((p) => {
        const health = routing.readProviderHealth(p.code);
        return {
          code: p.code,
          name: p.displayName,
          kind: p.kind,
          configured: p.configured(),
          simulated: p.sandboxOnly,
          operational: health.operational,
          successRatePct: health.successRatePct,
          errorRatePct: health.errorRatePct,
          latencyP50Ms: health.latencyP50Ms,
        };
      }),
      simulated: config.isSandbox,
    };
  });

  /* ------------------------------ analytics & exports ------------------------ */

  app.get('/v1/admin/analytics', async (request) => {
    const q = request.query as Record<string, string | undefined>;
    return analytics.summary({
      from: q.from ?? null,
      to: q.to ?? null,
      asset: (q.asset as never) ?? null,
      rail: (q.rail as never) ?? null,
      userId: q.userId ?? null,
      businessId: q.businessId ?? null,
    });
  });

  app.get('/v1/admin/merchants/analytics', async () => ({ merchants: analytics.merchants() }));

  /* -------------------------------- treasury -------------------------------- */

  app.get('/v1/admin/treasury', async () => ({
    ...treasury.overview(),
    alerts: treasury.alerts(),
    fxBoard: treasury.fxBoard(),
    sweepQueue: treasury.sweepQueue(),
    custody: treasury.custodyReport(),
    note: 'Float and custody figures describe what this deployment records as held and owed. They are not a bank statement.',
  }));

  /**
   * The only way a number moves in the treasury: an explicit, reasoned, audited
   * adjustment. There is deliberately no "set balance" route.
   */
  app.post('/v1/admin/treasury/float', async (request) => {
    const auth = requireSession(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const rail = strField(body.rail);
    const currency = strField(body.currency);
    const reason = strField(body.reason);
    if (!rail || !currency) throw new DomainError('VALIDATION_FAILED', 'Which rail and which currency?');
    if (!reason) throw new DomainError('VALIDATION_FAILED', 'A treasury movement needs a written reason.');
    const amountMajor = numField(body.amountMajor, 0);
    if (!amountMajor) throw new DomainError('VALIDATION_FAILED', 'Enter an amount greater than zero.');
    treasury.adjustFloat({
      rail,
      currency,
      amountMinor: BigInt(Math.round(amountMajor * Number(unitOf(currency as PayableAsset) / 100n))),
      direction: body.direction === 'OUT' ? 'OUT' : 'IN',
      reason,
      actor: auth.user.email || auth.userId,
    });
    log.warn('treasury float adjusted', { rail, currency, amountMajor, direction: body.direction, actor: auth.userId });
    return { ok: true, overview: treasury.overview(), alerts: treasury.alerts() };
  });

  app.get('/v1/admin/revenue', async (request) => {
    const q = request.query as { from?: string; to?: string };
    const to = q.to ?? new Date().toISOString();
    const from = q.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
    const rows = ledger.incomeStatement(from, to);
    return {
      from,
      to,
      lines: rows.map((r) => ({
        account: r.account,
        asset: r.asset,
        amountMinor: r.amountMinor.toString(),
        formatted: r.asset === 'KES' ? formatKes(r.amountMinor) : r.amountMinor.toString(),
      })),
      note: 'Figures are derived from the ledger, so they tie out to the journals behind every payment.',
      simulated: config.isSandbox,
    };
  });

  /* ------------------------------- compliance ------------------------------- */

  app.get('/v1/admin/compliance/cases', async (request) => {
    const q = request.query as { status?: string; limit?: string };
    const rows = getDb().all<Record<string, unknown>>(
      `SELECT * FROM compliance_cases WHERE (? IS NULL OR status = ?) ORDER BY priority, due_at LIMIT ?`,
      [q.status ?? null, q.status ?? null, Math.min(500, numField(q.limit, 100))],
    );
    return {
      cases: rows.map((r) => ({
        id: r['id'],
        reference: r['reference'],
        kind: r['kind'],
        status: r['status'],
        riskLevel: r['risk_level'],
        priority: r['priority'],
        subject: r['subject'],
        userId: r['user_id'],
        businessId: r['business_id'],
        paymentId: r['payment_intent_id'],
        assignedTo: r['assigned_to'],
        dueAt: r['due_at'],
        overdue: Boolean(r['due_at']) && String(r['due_at']) < new Date().toISOString() && r['status'] !== 'CLOSED',
        openedAt: r['opened_at'],
        closedAt: r['closed_at'],
        outcome: r['outcome'],
        dataOrigin: r['data_origin'],
      })),
      note: "Screening verdicts in this deployment come from AuraPay's own sandbox ruleset and are labelled as such. They are not a regulator-approved determination.",
    };
  });

  app.get('/v1/admin/compliance/cases/:id', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const row = db.maybeOne<Record<string, unknown>>('SELECT * FROM compliance_cases WHERE id = ?', [id]);
    if (!row) throw new DomainError('NOT_FOUND', 'No such case.');
    return {
      case: row,
      notes: db.all<Record<string, unknown>>(
        `SELECT id, author, text, outcome, created_at FROM compliance_case_notes WHERE case_id = ? ORDER BY created_at`,
        [id],
      ),
      signals: db.all<Record<string, unknown>>(
        `SELECT * FROM compliance_signals WHERE case_id = ? ORDER BY created_at`,
        [id],
      ),
      payment: row['payment_intent_id'] ? payments.view(String(row['payment_intent_id']), { admin: true }) : null,
    };
  });

  app.post('/v1/admin/compliance/cases/:id/notes', async (request) => {
    const auth = requireSession(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { text?: string; outcome?: string };
    if (!body.text) throw new DomainError('VALIDATION_FAILED', 'Write what you found.');
    compliance.addCaseNote(id, auth.user.email || auth.userId, body.text, body.outcome);
    return { ok: true };
  });

  app.post('/v1/admin/compliance/cases/:id/assign', async (request) => {
    const auth = requireSession(request);
    const { id } = request.params as { id: string };
    getDb().run('UPDATE compliance_cases SET assigned_to = ?, updated_at = ? WHERE id = ?', [auth.userId, new Date().toISOString(), id]);
    return { ok: true, assignedTo: auth.userId };
  });

  app.post('/v1/admin/compliance/cases/:id/close', async (request) => {
    const auth = requireSession(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { outcome?: 'CLEARED' | 'REJECTED' | 'ESCALATED'; note?: string };
    if (!body.outcome || !body.note) {
      throw new DomainError('VALIDATION_FAILED', 'Closing a case needs an outcome and a written reason.');
    }
    compliance.closeCase(id, auth.user.email || auth.userId, body.outcome, body.note);
    log.warn('compliance case closed', { id, outcome: body.outcome, actor: auth.userId });
    return { ok: true, outcome: body.outcome };
  });

  /* ------------------------------- fee schedule ------------------------------ */

  app.get('/v1/admin/fees', async () => ({ schedules: feesDomain.list(), history: feesDomain.history(60) }));

  app.get('/v1/admin/fees/preview', async (request) => {
    const q = request.query as Record<string, string | undefined>;
    return feesDomain.preview({
      asset: (q.asset ?? 'USDT') as PayableAsset,
      network: q.network as never,
      rail: (q.rail ?? 'MPESA') as RailCode,
      recipientAmountKesMajor: numField(q.recipientAmountKesMajor, 1000),
    });
  });

  /**
   * Fees are append-only too: a change takes effect from a date forward and never
   * restates a quote a customer was already shown.
   */
  app.put('/v1/admin/fees', async (request) => {
    const auth = requireSession(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.platformFeeBps === undefined || body.spreadBps === undefined) {
      throw new DomainError('VALIDATION_FAILED', 'State both the platform fee and the spread.');
    }
    if (!body.note) throw new DomainError('VALIDATION_FAILED', 'Say why the price changed — this is a customer-facing decision.');
    const schedule = feesDomain.update({
      asset: (body.asset ?? 'USDT') as PayableAsset,
      rail: (body.rail ?? '*') as never,
      platformFeeBps: numField(body.platformFeeBps, 0),
      platformFeeMinKes: numField(body.platformFeeMinKes, 0),
      spreadBps: numField(body.spreadBps, 0),
      railSurchargeMinor: body.railSurchargeMinor === undefined ? undefined : Math.round(numField(body.railSurchargeMinor) * 100),
      note: String(body.note),
      actor: auth.user.email || auth.userId,
      effectiveFrom: strField(body.effectiveFrom) ?? undefined,
    });
    log.warn('fee schedule changed', { actor: auth.userId, asset: body.asset, rail: body.rail });
    return { schedule, note: 'Applies to quotes created from now on. Quotes already issued keep the price shown to the customer until they expire.' };
  });

  /* --------------------------------- payments ------------------------------- */

  app.get('/v1/admin/payments', async (request) => {
    const q = request.query as Record<string, string | undefined>;
    return payments.list({
      status: (q.status as never) ?? null,
      asset: (q.asset as never) ?? null,
      rail: (q.rail as never) ?? null,
      search: q.search ?? null,
      from: q.from ?? null,
      to: q.to ?? null,
      limit: Math.min(200, numField(q.limit, 50)),
      includeSimulated: true,
    });
  });

  app.get('/v1/admin/payments/:id', async (request) => {
    const { id } = request.params as { id: string };
    const view = payments.view(id, { admin: true });
    const db = getDb();
    return {
      ...view,
      journals: db.all<Record<string, unknown>>(
        `SELECT j.id, j.type, j.description, j.created_at,
                (SELECT COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN CAST(e.amount_minor AS INTEGER) ELSE 0 END),0)
                 FROM ledger_entries e WHERE e.journal_id = j.id) AS debit_minor,
                (SELECT COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN CAST(e.amount_minor AS INTEGER) ELSE 0 END),0)
                 FROM ledger_entries e WHERE e.journal_id = j.id) AS credit_minor
         FROM journals j WHERE j.payment_intent_id = ? ORDER BY j.created_at`,
        [id],
      ),
      refundCapability: refunds.capability(id),
      events: db.all<Record<string, unknown>>(
        `SELECT type, message, actor, created_at FROM payment_events WHERE payment_intent_id = ? ORDER BY created_at, id`,
        [id],
      ),
    };
  });

  app.post('/v1/admin/payments/:id/resume', async (request) => {
    const auth = requireSession(request);
    const { id } = request.params as { id: string };
    await payments.resumeFromReview(id, auth.user.email || auth.userId);
    return payments.view(id, { admin: true });
  });

  app.get('/v1/admin/refunds', async (request) => {
    const q = request.query as { limit?: string };
    return { refunds: refunds.listRecent(Math.min(200, numField(q.limit, 50))) };
  });

  /**
   * An operator refund still goes through the rail's own capability check. We do
   * not get to promise an instant refund on a rail that cannot reverse.
   */
  app.post('/v1/admin/payments/:id/refund', async (request) => {
    const auth = requireSession(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const capability = refunds.capability(id);
    if (!capability.refundable) throw new DomainError('PAYMENT_NOT_REFUNDABLE', capability.reason ?? 'That payment cannot be refunded.');
    const result = await refunds.refund(id, {
      actor: auth.user.email || auth.userId,
      mode: capability.mode === 'AUTO' ? 'AUTO' : 'MANUAL',
      reason: strField(body.reason) ?? 'Refund issued by AuraPay operations.',
      reasonCode: strField(body.reasonCode),
      amountKesMinor: body.amountKesMajor === undefined ? undefined : BigInt(Math.round(numField(body.amountKesMajor) * 100)),
    });
    log.warn('refund issued by operations', { payment: id, refund: result.refundId, state: result.state, actor: auth.userId });
    return result;
  });

  app.post('/v1/admin/payouts/:id/retry', async (request) => {
    const auth = requireSession(request);
    const { id } = request.params as { id: string };
    const result = await payouts.retry(id, auth.user.email || auth.userId);
    log.warn('payout retried', { payout: id, actor: auth.userId });
    return result;
  });

  /* ------------------------------ queues & jobs ----------------------------- */

  app.get('/v1/admin/queue', async () => {
    const db = getDb();
    return {
      stats: (await import('../workers/queue.js')).stats(),
      byKind: db.all<{ kind: string; status: string; c: number }>(
        `SELECT type AS kind, status, COUNT(*) AS c FROM job_queue GROUP BY type, status ORDER BY type, status`,
      ),
      // A dead job means the platform gave up on a step. It is shown, never hidden.
      dead: db.all<Record<string, unknown>>(
        `SELECT id, type AS kind, dedupe_key, attempts, last_error, updated_at FROM job_queue WHERE status = 'DEAD' ORDER BY updated_at DESC LIMIT 25`,
      ),
    };
  });

  app.post('/v1/admin/queue/run', async () => {
    const queue = await import('../workers/queue.js');
    const result = await queue.runDue(50);
    return { ...result, stats: queue.stats() };
  });

  /* -------------------------- integrity & auditability ---------------------- */

  /**
   * Runs the same checks the CI job runs, on demand: does every journal balance,
   * does every conversion tie out, does the wallet cache match customer
   * liabilities. A green result here is the only "all is well" we are willing to say.
   */
  app.get('/v1/admin/ledger/verify', async (request) => {
    const q = request.query as { limit?: string; paymentId?: string };
    const problems = ledger.verify({ limit: Math.min(5000, numField(q.limit, 1000)), paymentIntentId: q.paymentId ?? undefined });
    return {
      ok: problems.length === 0,
      problems: problems.slice(0, 50),
      checkedAt: new Date().toISOString(),
      note: problems.length === 0
        ? 'Every journal balances, conversions tie out, and wallet balances match customer liabilities.'
        : 'Do not dismiss these. An unbalanced journal means money is somewhere we have not recorded.',
    };
  });

  app.get('/v1/admin/audit', async (request) => {
    const q = request.query as { actor?: string; action?: string; target?: string; limit?: string };
    const rows = getDb().all<Record<string, unknown>>(
      `SELECT * FROM audit_logs
       WHERE (? IS NULL OR actor_user_id = ?) AND (? IS NULL OR action LIKE ?) AND (? IS NULL OR target_id = ?)
       ORDER BY created_at DESC LIMIT ?`,
      [
        q.actor ?? null,
        q.actor ?? null,
        q.action ?? null,
        `%${q.action ?? ''}%`,
        q.target ?? null,
        q.target ?? null,
        Math.min(1000, numField(q.limit, 100)),
      ],
    );
    return {
      entries: rows.map((r) => ({
        id: r['id'],
        actorType: r['actor_type'],
        actor: r['actor_user_id'],
        action: r['action'],
        targetType: r['target_type'],
        targetId: r['target_id'],
        ip: r['ip'],
        userAgent: r['user_agent'],
        metadata: r['metadata'] ? JSON.parse(String(r['metadata'])) : null,
        at: r['created_at'],
      })),
    };
  });

  /* ---------------------------------- users --------------------------------- */

  app.get('/v1/admin/users', async (request) => {
    const q = request.query as { q?: string; limit?: string };
    const term = q.q ? `%${q.q}%` : null;
    const rows = getDb().all<Record<string, unknown>>(
      `SELECT id, email, full_name, phone, country, roles, status, kyc_status, kyc_tier, two_factor_enabled, created_at, last_login_at
       FROM users WHERE (? IS NULL OR email LIKE ? OR full_name LIKE ?) ORDER BY created_at DESC LIMIT ?`,
      [term, term, term, Math.min(100, numField(q.limit, 25))],
    );
    return {
      users: rows.map((r) => ({
        ...r,
        // Roles are stored as JSON text; parse so the UI never re-implements it.
        roles: JSON.parse(String(r['roles'] ?? '[]')) as string[],
      })),
      note: 'No password material, session tokens or 2FA secrets are ever returned here.',
    };
  });

  app.get('/v1/admin/users/:id', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const user = db.maybeOne<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) throw new DomainError('NOT_FOUND', 'No such user.');
    delete user['password_hash'];
    delete user['password_algo'];
    delete user['two_factor_secret_enc'];
    delete user['passkey_credential_id'];
    return {
      user,
      limits: (await import('../domain/identity.js')).limitsFor(id),
      balances: (await import('../domain/wallets.js')).balancesFor(id),
      businesses: db.all<Record<string, unknown>>('SELECT id, legal_name, status FROM businesses WHERE owner_user_id = ?', [id]),
      devices: (await import('../domain/identity.js')).listDevices(id),
      sessions: (await import('../domain/identity.js')).listSessions(id, null),
    };
  });

  app.get('/v1/admin/merchants/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { business: merchants.byId(id), dashboard: merchants.dashboard(id) };
  });

  app.post('/v1/admin/merchants/:id/kyb', async (request) => {
    const auth = requireSession(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { status?: 'NOT_STARTED' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED'; note?: string };
    if (!body.status) throw new DomainError('VALIDATION_FAILED', 'Which KYB decision?');
    if (body.status === 'APPROVED' && !body.note) throw new DomainError('VALIDATION_FAILED', 'Approving a business needs a written reason.');
    merchants.setKybStatus(id, body.status, auth.user.email || auth.userId, body.note ?? '');
    log.warn('kyb decision recorded', { business: id, status: body.status, actor: auth.userId });
    return { ok: true, business: merchants.byId(id) };
  });

  /* --------------------------------- sandbox -------------------------------- */

  // Mounted only when the sandbox is switched on. In a live deployment the routes
  // do not exist, so there is nothing to probe or to mistake for a control.
  if (config.demo.sandboxActions) {
    app.get('/v1/admin/sandbox', async () => ({
      ...sandbox.status(),
      supportedAssets: sandbox.supportedAssets(),
      supportedNetworks: sandbox.supportedNetworks(),
      integrity: sandbox.integrity(),
    }));

    app.post('/v1/admin/sandbox/advance-confirmations', async () => {
      // The simulator advances every payment that is waiting on confirmations.
      // A "confirm this one" button would be a nicer lie than the truth, which is
      // that the watcher decides when a deposit is deep enough.
      return sandbox.advanceConfirmations();
    });

    app.post('/v1/admin/sandbox/force-outcome', async (request) => {
      const body = (request.body ?? {}) as { paymentId?: string; outcome?: 'PAYOUT_FAIL' | 'MANUAL_REVIEW' | 'CONFIRM_NOW' | 'QUOTE_EXPIRE' };
      if (!body.paymentId || !body.outcome) throw new DomainError('VALIDATION_FAILED', 'Pick a payment and an outcome.');
      log.warn('sandbox outcome forced', { payment: body.paymentId, outcome: body.outcome });
      return await sandbox.forceOutcome(body.paymentId, body.outcome);
    });

    app.post('/v1/admin/sandbox/retry-payout', async (request) => {
      const body = (request.body ?? {}) as { paymentId?: string };
      if (!body.paymentId) throw new DomainError('VALIDATION_FAILED', 'Which payment?');
      return await sandbox.retryPayout(body.paymentId);
    });

    /**
     * Feeds a provider-shaped callback into the same handler a live partner hits,
     * so the ingest path is the one being tested. Sandbox only, obviously.
     */
    app.post('/v1/admin/sandbox/provider-callback', async (request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      await payouts.handleCallback(body);
      return { ok: true, note: 'Processed through the live callback handler. Nothing was invented about the outcome.' };
    });

    app.post('/v1/admin/realtime/ping', async (request) => {
      const body = (request.body ?? {}) as { scope?: string };
      const scope = strField(body.scope) ?? 'public';
      realtime.publish(scope, 'notifications', 'ping', { at: new Date().toISOString(), simulated: true });
      return { ok: true, scope, subscribers: realtime.subscriberCount(scope) };
    });
  }
}

function requestRoute(url: string): string {
  return url.split('?')[0]!.replace(/\/[a-z0-9]{8,}$/i, '/:id');
}

/** Writes to the append-only audit table, best effort: never fails a request. */
function recordAudit(input: {
  actorType: 'ADMIN' | 'USER' | 'SYSTEM';
  actor: string | null;
  action: string;
  request: { ip?: string; headers: Record<string, string | string[] | undefined> };
  target?: { type: string; id: string };
  metadata?: unknown;
}): void {
  try {
    const db = getDb();
    const row = {
      id: `audit_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      actor_user_id: input.actor,
      actor_type: input.actorType,
      action: input.action,
      target_type: input.target?.type ?? null,
      target_id: input.target?.id ?? null,
      ip: input.request.ip ?? null,
      user_agent: typeof input.request.headers['user-agent'] === 'string' ? input.request.headers['user-agent'] : null,
      metadata: input.metadata === undefined ? null : JSON.stringify(input.metadata),
      created_at: new Date().toISOString(),
    };
    db.run(
      `INSERT INTO audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, ip, user_agent, metadata, created_at)
       VALUES (?,?,?,?,?,?,?,?,?, ?)`,
      [row.id, row.actor_user_id, row.actor_type, row.action, row.target_type, row.target_id, row.ip, row.user_agent, row.metadata, row.created_at],
    );
  } catch (error) {
    log.error('audit write failed', { error: error instanceof Error ? error.message : String(error) });
  }
}
