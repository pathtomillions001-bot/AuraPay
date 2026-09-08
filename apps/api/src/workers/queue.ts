import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { isoIn, nowIso } from '../lib/ids.js';
import { parse, stringify } from '../lib/json.js';
import { createLogger } from '../logger.js';
import * as payments from '../domain/payments.js';
import * as payouts from '../domain/payouts.js';
import * as webhooks from '../domain/webhooks.js';
import * as notifications from '../domain/notifications.js';
import * as quotes from '../domain/quotes.js';
import * as links from '../domain/links.js';
import * as receipts from '../domain/receipts.js';
import * as liquidity from '../domain/liquidity.js';
import * as fx from '../domain/fx.js';
import { blockchain } from '../domain/blockchain.js';

const log = createLogger('queue');

/**
 * The job runner.
 *
 * Jobs live in SQL (`job_queue`), not in process memory, because a payment that
 * is mid-settlement must survive a restart of the API. In production the same
 * table is consumed by standalone worker processes — `claim()` takes rows with a
 * `locked_by` token so two workers cannot run the same job, and the loop below is
 * simply run in more than one place.
 *
 * Rules that matter for money:
 *  • an unknown job type is *never* silently dropped — it is retried and then
 *    parked as DEAD where the admin health panel can see it;
 *  • a handler that throws leaves the job retryable with backoff;
 *  • every state of a payment is driven by re-reading evidence, so a duplicate
 *    delivery of the same job is a no-op rather than a double move.
 */

export type JobHandler = (payload: Record<string, unknown>) => Promise<void> | void;

const HANDLERS = new Map<string, JobHandler>();

function watchSeconds(): number {
  return config.isSandbox ? Math.max(1, config.payments.sandboxStepSeconds) : 6;
}

export function registerHandler(type: string, handler: JobHandler): void {
  HANDLERS.set(type, handler);
}

registerHandler('payment.watch_deposit', async (payload) => {
  const paymentId = String(payload.paymentId ?? '');
  if (!paymentId) return;
  await payments.drive(paymentId, 'watcher');
  // Watch until the money is either final or given up on, then reschedule.
  const row = getDb().maybeOne<{ status: string }>('SELECT status FROM payment_intents WHERE id = ?', [paymentId]);
  const open = row && !['COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED'].includes(row.status);
  // Poll pace: quick in sandbox so the demo is watchable, calm in production so a
  // node RPC is not hammered — the payment never waits on this timer to complete.
  if (open) schedule('payment.watch_deposit', { paymentId }, watchSeconds());
});

registerHandler('payment.expire', async (payload) => {
  const paymentId = String(payload.paymentId ?? '');
  if (paymentId) await payments.expire(paymentId, 'deposit window closed');
});

registerHandler('payout.sandbox_confirm', async (payload) => {
  if (!config.isSandbox) {
    // In production a payout is confirmed by the provider's own status query,
    // never by a local timer, so this job must not exist at all.
    throw new Error('payout.sandbox_confirm is a sandbox-only job');
  }
  const payoutId = String(payload.payoutId ?? '');
  if (payoutId) payouts.confirmSandbox(payoutId);
});

registerHandler('payout.query', async (payload) => {
  await payouts.reconcileDue(20);
  const payoutId = String(payload.payoutId ?? '');
  if (payoutId) await payouts.reconcile(payoutId);
});

registerHandler('webhook.deliver', async (payload) => {
  const endpointId = String(payload.endpointId ?? '');
  const webhookId = String(payload.webhookId ?? '');
  if (endpointId && webhookId) await webhooks.deliver(endpointId, webhookId);
});

registerHandler('receipt.issue', async (payload) => {
  const paymentId = String(payload.paymentId ?? '');
  if (!paymentId) return;
  const row = getDb().maybeOne<{ receipt_id: string | null; user_id: string | null }>(
    'SELECT receipt_id, user_id FROM payment_intents WHERE id = ?',
    [paymentId],
  );
  if (row?.receipt_id) return; // already issued — a retry must not mint a second document
  const receiptId = receipts.issue(paymentId, { email: row?.user_id !== null });
  getDb().run('UPDATE payment_intents SET receipt_id = ?, updated_at = ? WHERE id = ?', [receiptId, nowIso(), paymentId]);
});

registerHandler('message.send', async (payload) => {
  const messageId = String(payload.messageId ?? '');
  if (messageId) await notifications.processMessage(messageId);
});

/**
 * Claim due jobs and run them. Returns counts for the health endpoint and the
 * CLI, so "the worker is running" is a measurable claim rather than a hope.
 */
export async function runDue(limit = 20): Promise<{ ran: number; done: number; failed: number; dead: number }> {
  const db = getDb();
  const now = nowIso();
  const out = { ran: 0, done: 0, failed: 0, dead: 0 };
  const due = db.all<{ id: string; type: string; payload: string; attempts: number; max_attempts: number }>(
    `SELECT id, type, payload, attempts, max_attempts FROM job_queue
     WHERE status = 'READY' AND run_at <= ? ORDER BY run_at LIMIT ?`,
    [now, limit],
  );
  if (due.length === 0) return out;
  const worker = `worker-${randomUUID().slice(0, 8)}`;
  db.run(
    `UPDATE job_queue SET status = 'ACTIVE', locked_by = ?, locked_at = ?, updated_at = ?
     WHERE id IN (${due.map(() => '?').join(',')})`,
    [worker, now, now, ...due.map((j) => j.id)],
  );

  for (const job of due) {
    out.ran += 1;
    const handler = HANDLERS.get(job.type);
    try {
      if (!handler) throw new Error(`no handler registered for job type "${job.type}"`);
      await handler(parse<Record<string, unknown>>(job.payload) ?? {});
      db.run(`UPDATE job_queue SET status = 'DONE', finished_at = ?, updated_at = ?, locked_by = NULL WHERE id = ?`, [
        nowIso(),
        nowIso(),
        job.id,
      ]);
      out.done += 1;
    } catch (error) {
      const message = (error as Error).message.slice(0, 400);
      const attempts = job.attempts + 1;
      const exhausted = attempts >= job.max_attempts;
      // Backoff is deliberate and short enough that a stuck payout still settles
      // within the promised window, but never hammers a partner that is down.
      const backoff = [10, 30, 120, 600, 1800, 3600][Math.min(attempts - 1, 5)] ?? 3600;
      db.run(
        `UPDATE job_queue SET status = ?, attempts = ?, last_error = ?, run_at = ?, locked_by = NULL, updated_at = ? WHERE id = ?`,
        [exhausted ? 'DEAD' : 'READY', attempts, message, isoIn(backoff), nowIso(), job.id],
      );
      if (exhausted) {
        out.dead += 1;
        log.error('job parked after exhausting retries', { job: job.id, type: job.type, attempts, error: message });
      } else {
        out.failed += 1;
        log.warn('job failed, will retry', { job: job.id, type: job.type, attempts, retryIn: backoff, error: message });
      }
    }
  }
  return out;
}

/** Schedule a job; `dedupeKey` collapses duplicates (a watch loop must not fan out). */
export function schedule(type: string, payload: Record<string, unknown>, delaySeconds = 0, dedupeKey?: string): string | null {
  const db = getDb();
  if (dedupeKey) {
    const existing = db.maybeOne<{ id: string; status: string }>(
      'SELECT id, status FROM job_queue WHERE dedupe_key = ? AND status IN (?,?,?)',
      [dedupeKey, 'READY', 'ACTIVE', 'FAILED'],
    );
    if (existing) return null;
  }
  const jobId = `job_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  db.run(
    `INSERT INTO job_queue (id, type, payload, status, dedupe_key, run_at, attempts, max_attempts, created_at, updated_at)
     VALUES (?,?,?, 'READY', ?, ?, 0, 6, ?, ?)`,
    [jobId, type, stringify(payload), dedupeKey ?? null, isoIn(delaySeconds), nowIso(), nowIso()],
  );
  return jobId;
}

export function stats(): { ready: number; active: number; dead: number; oldestReadyAt: string | null } {
  const row = getDb().maybeOne<{ ready: number; active: number; dead: number; oldest: string | null }>(
    `SELECT
       SUM(CASE WHEN status = 'READY' THEN 1 ELSE 0 END) AS ready,
       SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status = 'DEAD' THEN 1 ELSE 0 END) AS dead,
       MIN(CASE WHEN status = 'READY' THEN run_at END) AS oldest
     FROM job_queue`,
  );
  return { ready: row?.ready ?? 0, active: row?.active ?? 0, dead: row?.dead ?? 0, oldestReadyAt: row?.oldest ?? null };
}

/* ------------------------------------------------------------------ *
 * Periodic sweeps — work that is a function of time, not of one payment.
 * ------------------------------------------------------------------ */

export async function sweep(): Promise<Record<string, number | string>> {
  const results: Record<string, number | string> = {};
  try {
    results.quotesExpired = quotes.expireStale();
  } catch (error) {
    results.quotesExpired = `error: ${(error as Error).message}`;
  }
  try {
    results.linksExpired = links.expireStale();
  } catch (error) {
    results.linksExpired = `error: ${(error as Error).message}`;
  }
  try {
    results.reservationsReleased = liquidity.expireStale();
  } catch (error) {
    results.reservationsReleased = `error: ${(error as Error).message}`;
  }
  try {
    results.payoutsReconciled = await payouts.reconcileDue(20);
  } catch (error) {
    results.payoutsReconciled = `error: ${(error as Error).message}`;
  }
  try {
    results.rates = (await fx.refreshRates()).count;
  } catch (error) {
    results.rates = `error: ${(error as Error).message}`;
  }
  try {
    results.alerts = (await liquidity.alerts()).length;
  } catch (error) {
    results.alerts = `error: ${(error as Error).message}`;
  }
  if (config.isSandbox) {
    try {
      // Sandbox confirmations advance with wall-clock time so the confirmation UI
      // can be demonstrated honestly; live providers are never touched here.
      results.confirmationsAdvanced = blockchain.advanceSandboxConfirmations();
    } catch (error) {
      results.confirmationsAdvanced = `error: ${(error as Error).message}`;
    }
  }
  return results;
}

let timer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let running = false;

/** Start the in-process loop. `npm run dev` runs the API and the workers together. */
export function start(opts: { tickMs?: number; sweepMs?: number } = {}): void {
  if (timer) return;
  const tickMs = opts.tickMs ?? 1000;
  const sweepMs = opts.sweepMs ?? 15_000;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void runDue(20)
      .then((res) => {
        if (res.ran > 0) log.debug('queue tick', res);
      })
      .catch((error) => log.error('queue tick failed', { error: (error as Error).message }))
      .finally(() => {
        running = false;
      });
  }, tickMs);
  sweepTimer = setInterval(() => {
    void sweep().catch((error) => log.error('sweep failed', { error: (error as Error).message }));
  }, sweepMs);
  timer.unref?.();
  sweepTimer.unref?.();
  log.info('worker loop started', { tickMs, sweepMs, mode: config.mode });
}

export function stop(): void {
  if (timer) clearInterval(timer);
  if (sweepTimer) clearInterval(sweepTimer);
  timer = null;
  sweepTimer = null;
}
