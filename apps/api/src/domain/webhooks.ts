import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_EVENTS, type WebhookEvent } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { decryptString, encryptString, maskSecret } from '../lib/crypto.js';
import { id, isoIn, nowIso } from '../lib/ids.js';
import { createLogger } from '../logger.js';
import { stringify } from '../lib/json.js';

const log = createLogger('webhooks');

/**
 * Outbound webhooks.
 *
 * Signature scheme (documented for integrators):
 *
 *   X-AuraPay-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
 *   signed payload      = `${t}.${event.id}.${rawBody}`
 *
 * Properties that matter for a payment integration:
 *   - `t` + a ±5 minute window + persisted `event_id` ⇒ replay protection
 *   - retries with exponential backoff (1m, 5m, 30m, 2h, 8h), 2xx within 10s = success
 *   - endpoints auto-pause after 20 consecutive failures and an operator alert fires
 *   - delivery attempts are recorded with the HTTP status and a truncated response
 *
 * The dispatcher is queue-backed: emitting an event never blocks or fails a
 * payment. If this process dies, the rows in `job_queue` retry on restart.
 */

const WINDOW_SECONDS = 300;
const BACKOFF_SECONDS = [0, 60, 300, 1800, 7200, 28_800];
const AUTO_PAUSE_AFTER = 20;

export interface WebhookPayload<T = unknown> {
  id: string;
  type: WebhookEvent;
  created: string;
  apiVersion: string;
  livemode: boolean;
  data: T;
}

export function signPayload(secret: string, timestamp: number, eventId: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${eventId}.${body}`).digest('hex');
}

/** Used by the API test endpoint and by integrators' own unit tests. */
export function verifySignature(input: { secret: string; header: string; body: string; eventId: string; now?: number }): {
  valid: boolean;
  reason?: 'no_valid_signature' | 'timestamp_out_of_range';
} {
  const parts = Object.fromEntries(
    input.header
      .split(',')
      .map((pair) => pair.split('='))
      .filter((kv) => kv.length === 2) as Array<[string, string]>,
  ) as { t?: string; v1?: string };
  if (!parts.t || !parts.v1) return { valid: false, reason: 'no_valid_signature' };
  const timestamp = Number(parts.t);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > WINDOW_SECONDS) {
    return { valid: false, reason: 'timestamp_out_of_range' };
  }
  const expected = signPayload(input.secret, timestamp, input.eventId, input.body);
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  if (a.length !== b.length) return { valid: false, reason: 'no_valid_signature' };
  return { valid: timingSafeEqual(a, b) };
}

export function emit<T>(type: WebhookEvent, data: T, meta: { paymentIntentId?: string | null; businessId?: string | null; userId?: string | null } = {}): void {
  const db = getDb();
  const eventId = id('evt');
  const payload: WebhookPayload<T> = {
    id: eventId,
    type,
    created: nowIso(),
    apiVersion: '2026-01',
    livemode: !config.isSandbox,
    data,
  };
  db.tx(() => {
    db.run(
      `INSERT INTO webhooks (id, event_id, type, api_version, live_mode, payment_intent_id, endpoint_scope, payload, created_at)
       VALUES (?,?,?,?,?,?,?, ?, ?)`,
      [
        eventId,
        eventId,
        type,
        payload.apiVersion,
        config.isSandbox ? 0 : 1,
        meta.paymentIntentId ?? null,
        meta.businessId ?? meta.userId ?? null,
        stringify(payload),
        payload.created,
      ],
    );
    const endpoints = db.all<{ id: string; events: string }>(
      `SELECT id, events FROM webhook_endpoints WHERE status = 'ACTIVE' AND environment = ?`,
      [config.isSandbox ? 'test' : 'live'],
    );
    for (const endpoint of endpoints) {
      const events = JSON.parse(endpoint.events || '[]') as string[];
      if (events.length && !events.includes(type)) continue;
      db.run(
        `INSERT INTO job_queue (id, type, payload, status, dedupe_key, run_at, attempts, max_attempts, created_at, updated_at)
         VALUES (?,?,?, 'READY',?,?, 0, 6, ?, ?)`,
        [
          id('job'),
          'webhook.deliver',
          stringify({ endpointId: endpoint.id, webhookId: eventId }),
          `webhook:${endpoint.id}:${eventId}`,
          nowIso(),
          nowIso(),
          nowIso(),
        ],
      );
    }
  });
}

export interface DeliverResult {
  status: 'SUCCEEDED' | 'FAILED' | 'THROTTLED';
  httpStatus: number | null;
  durationMs: number;
  error?: string;
}

/**
 * One delivery attempt. Network failures never throw into the queue loop: they
 * are recorded so the retry policy can act on them.
 */
export async function deliver(endpointId: string, webhookId: string): Promise<DeliverResult> {
  const db = getDb();
  const endpoint = db.maybeOne<{ id: string; url: string; secret_enc: string; consecutive_failures: number; status: string }>(
    'SELECT * FROM webhook_endpoints WHERE id = ?',
    [endpointId],
  );
  const event = db.maybeOne<{ id: string; payload: string; type: string; event_id: string }>(
    'SELECT id, payload, type, event_id FROM webhooks WHERE id = ?',
    [webhookId],
  );
  if (!endpoint || !event) return { status: 'FAILED', httpStatus: null, durationMs: 0, error: 'endpoint or event missing' };
  if (endpoint.status !== 'ACTIVE') return { status: 'THROTTLED', httpStatus: null, durationMs: 0, error: 'endpoint paused' };

  const secret = decryptString(endpoint.secret_enc) ?? '';
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(secret, timestamp, event.event_id, event.payload);
  const attempt = (db.maybeOne<{ c: number }>('SELECT COUNT(*) AS c FROM webhook_deliveries WHERE webhook_id = ? AND endpoint_id = ?', [
    webhookId,
    endpointId,
  ])?.c ?? 0) + 1;
  const deliveryId = id('whd');
  const started = Date.now();
  db.run(
    `INSERT INTO webhook_deliveries (id, endpoint_id, webhook_id, event_id, event_type, attempt, status, created_at)
     VALUES (?,?,?,?,?,?, 'SCHEDULED', ?)`,
    [deliveryId, endpointId, webhookId, event.event_id, event.type, attempt, nowIso()],
  );

  let result: DeliverResult;
  try {
    if (!/^https:\/\//i.test(endpoint.url) && !isLocalDevUrl(endpoint.url)) {
      throw new Error('endpoint URL must be https in production');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(endpoint.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'AuraPay-Webhooks/1.0',
        'x-aurapay-signature': `t=${timestamp},v1=${signature}`,
        'x-aurapay-event': event.type,
        'x-aurapay-event-id': event.event_id,
        'x-aurapay-timestamp': String(timestamp),
        'x-aurapay-delivery-attempt': String(attempt),
      },
      body: event.payload,
    });
    clearTimeout(timer);
    const durationMs = Date.now() - started;
    result = response.ok
      ? { status: 'SUCCEEDED', httpStatus: response.status, durationMs }
      : {
          status: response.status === 429 ? 'THROTTLED' : 'FAILED',
          httpStatus: response.status,
          durationMs,
          error: `endpoint replied ${response.status}`,
        };
  } catch (error) {
    result = { status: 'FAILED', httpStatus: null, durationMs: Date.now() - started, error: (error as Error).message };
  }

  db.tx(() => {
    db.run(
      `UPDATE webhook_deliveries
       SET status = ?, http_status = ?, duration_ms = ?, error = ?, delivered_at = ?
       WHERE id = ?`,
      [result.status, result.httpStatus, result.durationMs, result.error ?? null, result.status === 'SUCCEEDED' ? nowIso() : null, deliveryId],
    );
    if (result.status === 'SUCCEEDED') {
      db.run(
        `UPDATE webhook_endpoints SET consecutive_failures = 0, last_delivery_at = ?, updated_at = ? WHERE id = ?`,
        [nowIso(), nowIso(), endpointId],
      );
      return;
    }
    const failures = endpoint.consecutive_failures + 1;
    const pause = failures >= AUTO_PAUSE_AFTER;
    db.run(
      `UPDATE webhook_endpoints SET consecutive_failures = ?, last_delivery_at = ?, status = ?, updated_at = ? WHERE id = ?`,
      [failures, nowIso(), pause ? 'PAUSED' : 'ACTIVE', nowIso(), endpointId],
    );
    const backoff = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)]!;
    if (attempt <= BACKOFF_SECONDS.length && !pause) {
      db.run(
        `INSERT INTO job_queue (id, type, payload, status, dedupe_key, run_at, attempts, max_attempts, created_at, updated_at)
         VALUES (?,?,?, 'READY',?,?,?, 6, ?, ?)`,
        [
          id('job'),
          'webhook.deliver',
          stringify({ endpointId, webhookId }),
          `webhook:${endpointId}:${webhookId}:retry:${attempt}`,
          isoIn(backoff),
          attempt,
          nowIso(),
          nowIso(),
        ],
      );
    }
    if (pause) {
      db.run(
        `INSERT INTO notifications (id, user_id, title, body, channel, severity, link, created_at)
         SELECT ?, user_id, 'Webhook endpoint paused', ?, 'in_app', 'critical', '/app/developer/webhooks', ?
         FROM webhook_endpoints LEFT JOIN users ON users.id = webhook_endpoints.user_id WHERE webhook_endpoints.id = ?`,
        [
          id('ntf'),
          `${endpoint.url} was paused after ${failures} consecutive failures. Deliveries are queued and will resume when you re-enable the endpoint.`,
          nowIso(),
          endpointId,
        ],
      );
      log.error('webhook endpoint auto-paused', { endpointId, url: endpoint.url, failures });
    }
  });
  return result;
}

function isLocalDevUrl(url: string): boolean {
  if (!config.isSandbox) return false;
  return /^http:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal|ngrok\.io)(:\d+)?/i.test(url) || url.includes('.ngrok-free.app');
}

export function createEndpoint(input: {
  userId: string | null;
  businessId: string | null;
  url: string;
  description?: string;
  events: string[];
  environment?: 'test' | 'live';
  secret?: string;
}): { id: string; secretPlain: string; hint: string } {
  if (!/^https:\/\//i.test(input.url) && !isLocalDevUrl(input.url)) {
    throw new DomainWebhookError('Webhook URLs must use https.');
  }
  for (const event of input.events) {
    if (!WEBHOOK_EVENTS.includes(event as WebhookEvent)) throw new DomainWebhookError(`unknown event "${event}"`);
  }
  const secret = input.secret && input.secret.length >= 16 ? input.secret : `whsec_${randomBytes(24).toString('base64url')}`;
  const endpointId = id('whe');
  const now = nowIso();
  getDb().run(
    `INSERT INTO webhook_endpoints
     (id, user_id, business_id, environment, url, description, secret_enc, secret_hint, events, status, consecutive_failures, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?, 'ACTIVE', 0, ?, ?)`,
    [
      endpointId,
      input.userId,
      input.businessId,
      input.environment ?? (config.isSandbox ? 'test' : 'live'),
      input.url,
      input.description ?? null,
      encryptString(secret),
      maskSecret(secret),
      stringify(input.events),
      now,
      now,
    ],
  );
  return { id: endpointId, secretPlain: secret, hint: maskSecret(secret) };
}

export class DomainWebhookError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
  }
}

export function listEndpoints(userId: string | null, businessId: string | null) {
  return getDb()
    .all<{
      id: string;
      url: string;
      description: string | null;
      events: string;
      status: string;
      secret_hint: string;
      consecutive_failures: number;
      last_delivery_at: string | null;
      created_at: string;
      environment: string;
    }>(
      `SELECT * FROM webhook_endpoints WHERE (? IS NULL OR user_id = ? OR business_id = ?) ORDER BY created_at DESC`,
      [userId ?? businessId, userId, businessId],
    )
    .map((row) => ({
      id: row.id,
      url: row.url,
      description: row.description,
      events: JSON.parse(row.events || '[]') as string[],
      status: row.status as 'ACTIVE' | 'PAUSED',
      secretHint: row.secret_hint,
      consecutiveFailures: row.consecutive_failures,
      lastDeliveryAt: row.last_delivery_at,
      createdAt: row.created_at,
      environment: row.environment as 'test' | 'live',
    }));
}

export function updateEndpoint(endpointId: string, patch: { url?: string; events?: string[]; status?: 'ACTIVE' | 'PAUSED'; description?: string }): void {
  const db = getDb();
  const fields: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [nowIso()];
  if (patch.url) {
    if (!/^https:\/\//i.test(patch.url) && !isLocalDevUrl(patch.url)) throw new DomainWebhookError('Webhook URLs must use https.');
    fields.push('url = ?');
    params.push(patch.url);
  }
  if (patch.events) {
    for (const event of patch.events) if (!WEBHOOK_EVENTS.includes(event as WebhookEvent)) throw new DomainWebhookError(`unknown event "${event}"`);
    fields.push('events = ?');
    params.push(stringify(patch.events));
  }
  if (patch.description !== undefined) {
    fields.push('description = ?');
    params.push(patch.description);
  }
  if (patch.status) {
    fields.push('status = ?', 'consecutive_failures = 0');
    params.push(patch.status, 0);
  }
  params.push(endpointId);
  db.run(`UPDATE webhook_endpoints SET ${fields.join(', ')} WHERE id = ?`, params);
}

export function rotateSecret(endpointId: string): { secretPlain: string; hint: string } {
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  getDb().run('UPDATE webhook_endpoints SET secret_enc = ?, secret_hint = ?, updated_at = ? WHERE id = ?', [
    encryptString(secret),
    maskSecret(secret),
    nowIso(),
    endpointId,
  ]);
  return { secretPlain: secret, hint: maskSecret(secret) };
}

export function deleteEndpoint(endpointId: string): void {
  getDb().run('DELETE FROM webhook_endpoints WHERE id = ?', [endpointId]);
}

export function listEvents(limit = 50, filter: { type?: string; paymentIntentId?: string } = {}) {
  const db = getDb();
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.type) {
    clauses.push('w.type = ?');
    params.push(filter.type);
  }
  if (filter.paymentIntentId) {
    clauses.push('w.payment_intent_id = ?');
    params.push(filter.paymentIntentId);
  }
  params.push(limit);
  const rows = db.all<{
    id: string;
    event_id: string;
    type: string;
    payload: string;
    created_at: string;
    live_mode: number;
  }>(
    `SELECT w.* FROM webhooks w ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY w.created_at DESC LIMIT ?`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    type: row.type,
    createdAt: row.created_at,
    livemode: row.live_mode === 1,
    payload: JSON.parse(row.payload) as unknown,
    attempts: db.all<{
      id: string;
      endpoint_id: string;
      status: string;
      http_status: number | null;
      duration_ms: number | null;
      attempt: number;
      error: string | null;
      created_at: string;
    }>(
      `SELECT id, endpoint_id, status, http_status, duration_ms, attempt, error, created_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at`,
      [row.id],
    ).map((d) => ({
      id: d.id,
      endpointId: d.endpoint_id,
      status: d.status as 'SCHEDULED' | 'SUCCEEDED' | 'FAILED' | 'THROTTLED',
      httpStatus: d.http_status,
      durationMs: d.duration_ms,
      attempt: d.attempt,
      error: d.error,
      createdAt: d.created_at,
    })),
  }));
}

/** Signature of an event as it *was* sent — lets a developer debug their verifier. */
export function debugSignatureFor(webhookId: string, endpointId: string): { header: string; body: string; secretHint: string } | null {
  const db = getDb();
  const event = db.maybeOne<{ payload: string; event_id: string; created_at: string }>('SELECT * FROM webhooks WHERE id = ?', [webhookId]);
  const endpoint = db.maybeOne<{ secret_enc: string; secret_hint: string }>('SELECT secret_enc, secret_hint FROM webhook_endpoints WHERE id = ?', [
    endpointId,
  ]);
  if (!event || !endpoint) return null;
  const timestamp = Math.floor(new Date(event.created_at).getTime() / 1000);
  const secret = decryptString(endpoint.secret_enc) ?? '';
  return {
    body: event.payload,
    header: `t=${timestamp},v1=${signPayload(secret, timestamp, event.event_id, event.payload)}`,
    secretHint: endpoint.secret_hint,
  };
}

/** Lazy so the description map below is initialised first. */
export function eventCatalogue(): Array<{ type: string; description: string }> {
  return WEBHOOK_EVENTS.map((type) => ({ type, description: EVENT_DESCRIPTIONS[type] ?? '' }));
}

const EVENT_DESCRIPTIONS: Partial<Record<WebhookEvent, string>> = {
  'payment.created': 'A payment intent was created and is waiting for the crypto deposit.',
  'payment.detected': 'A matching on-chain transaction was seen (not yet final).',
  'payment.confirmed': 'The deposit reached the required confirmations for that network.',
  'payment.processing': 'Risk checks cleared and conversion started.',
  'payment.settling': 'A payout was submitted to the local rail.',
  'payment.completed': 'The recipient received the local-currency payment.',
  'payment.failed': 'The payment could not be completed; see data.failure for the reason.',
  'payment.refund_requested': 'A refund has been requested and is queued or awaiting the rail.',
  'payment.refunded': 'Funds were returned to the payer.',
  'payout.created': 'A payout instruction was handed to a provider.',
  'payout.completed': 'The provider confirmed delivery to the recipient.',
  'payout.failed': 'The provider could not deliver; refund path starts automatically.',
  'merchant.updated': 'Merchant settlement configuration, status or limits changed.',
  'quote.expired': 'A quote passed its expiry without being used.',
  'liquidity.low': 'A settlement account fell below its float threshold.',
  'compliance.review.opened': 'A payment or account was parked for manual review.',
  'compliance.review.closed': 'A compliance review reached a decision.',
};
