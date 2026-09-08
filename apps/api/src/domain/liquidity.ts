import { DomainError, formatKes, mulDiv, unitOf, type RailCode } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, nowIso, isoIn } from '../lib/ids.js';
import { publish } from './realtime.js';
import { createLogger } from '../logger.js';
import { insert } from '../db/rows.js';

const log = createLogger('liquidity');

/**
 * Liquidity engine.
 *
 * Answers one question before any crypto is accepted: *can we actually deliver
 * this amount of local currency through this rail right now?*
 *
 * Book of record is `liquidity_accounts` (float held at payout partners), and
 * every hold is a row in `liquidity_reservations` so a crash cannot strand a
 * reservation. Money flow:
 *
 *   available ──(reserve)──► reserved ──(consume)──► pending_payouts ──(provider confirm)──► out
 *      ▲                          │
 *      └────────(release)─────────┘
 */

export interface LiquidityAccountRow {
  id: string;
  provider: string;
  rail: string;
  currency: string;
  country: string;
  label: string | null;
  available_minor: string;
  reserved_minor: string;
  pending_payout_minor: string;
  float_target_minor: string;
  health: string;
  data_origin: string;
  updated_at: string;
}

export interface LiquidityView {
  accountId: string;
  provider: string;
  rail: string;
  currency: string;
  availableMinor: bigint;
  reservedMinor: bigint;
  pendingPayoutMinor: bigint;
  floatTargetMinor: bigint;
  utilisationPct: number;
  health: 'HEALTHY' | 'WATCH' | 'LOW' | 'CRITICAL';
  dataOrigin: 'sandbox' | 'live';
}

function toView(row: LiquidityAccountRow): LiquidityView {
  const available = BigInt(row.available_minor);
  const reserved = BigInt(row.reserved_minor);
  const pending = BigInt(row.pending_payout_minor);
  const target = BigInt(row.float_target_minor);
  const required = reserved + pending;
  const utilisation = target > 0n ? Number((required * 10_000n) / target) / 100 : 0;
  const lowMinor = BigInt(config.liquidity.lowThresholdKes) * unitOf('KES');
  const criticalMinor = BigInt(config.liquidity.criticalThresholdKes) * unitOf('KES');
  const health: LiquidityView['health'] =
    available <= criticalMinor ? 'CRITICAL' : available <= lowMinor ? 'LOW' : available <= target / 4n ? 'WATCH' : 'HEALTHY';
  return {
    accountId: row.id,
    provider: row.provider,
    rail: row.rail,
    currency: row.currency,
    availableMinor: available,
    reservedMinor: reserved,
    pendingPayoutMinor: pending,
    floatTargetMinor: target,
    utilisationPct: utilisation,
    health,
    dataOrigin: row.data_origin === 'live' ? 'live' : 'sandbox',
  };
}

export function findAccount(rail: RailCode, currency: string): LiquidityAccountRow | undefined {
  return getDb().maybeOne<LiquidityAccountRow>(
    'SELECT * FROM liquidity_accounts WHERE rail = ? AND currency = ? LIMIT 1',
    [rail, currency],
  );
}

export function viewFor(rail: RailCode, currency: string): LiquidityView | null {
  const row = findAccount(rail, currency);
  return row ? toView(row) : null;
}

export function listAccounts(): LiquidityView[] {
  return getDb().all<LiquidityAccountRow>('SELECT * FROM liquidity_accounts ORDER BY rail').map(toView);
}

/**
 * How much the platform must have on hand to promise this payout. Includes the
 * rail's own fee because the provider debits it from our float.
 */
export function requiredFloatMinor(recipientAmountMinor: bigint, providerFeeBps: number, providerFixedMinor: number): bigint {
  const fee = mulDiv(recipientAmountMinor, BigInt(providerFeeBps), 10_000n) + BigInt(providerFixedMinor);
  return recipientAmountMinor + fee;
}

export type ReservationResult =
  | { status: 'RESERVED'; reservationId: string; accountId: string; amountMinor: bigint }
  | { status: 'QUEUED'; reservationId: null; accountId: string | null; amountMinor: bigint; reason: string }
  | { status: 'UNAVAILABLE'; reason: string };

/**
 * Reserve KES for a payment. Called *before* we tell the user to send crypto,
 * so we never accept a deposit we cannot settle.
 */
export function reserve(input: {
  paymentIntentId: string;
  rail: RailCode;
  currency: string;
  amountMinor: bigint;
  providerFeeBps?: number;
  providerFixedMinor?: number;
  ttlSeconds?: number;
}): ReservationResult {
  const db = getDb();
  const total = requiredFloatMinor(
    input.amountMinor,
    input.providerFeeBps ?? 0,
    input.providerFixedMinor ?? 0,
  );
  const account = findAccount(input.rail, input.currency);
  if (!account) {
    return { status: 'UNAVAILABLE', reason: `no ${input.currency} float configured for rail ${input.rail}` };
  }
  const result = db.tx((): ReservationResult => {
    const row = findAccount(input.rail, input.currency)!;
    const available = BigInt(row.available_minor);
    if (available < total) {
      if (!config.liquidity.allowQueueOnInsufficient) {
        return {
          status: 'UNAVAILABLE',
          reason: `insufficient ${row.currency} liquidity on ${row.rail} (need ${total}, have ${available})`,
        };
      }
      return {
        status: 'QUEUED',
        reservationId: null,
        accountId: row.id,
        amountMinor: total,
        reason: `Awaiting ${row.currency} liquidity on ${row.rail}: need ${total}, available ${available}. ` +
          'The crypto deposit is still accepted and held as pending until the float is topped up.',
      };
    }
    const reservationId = id('liqres');
    db.run(
      `INSERT INTO liquidity_reservations
       (id, liquidity_account_id, payment_intent_id, amount_minor, status, created_at, expires_at)
       VALUES (?,?,?,?,'HELD',?,?)`,
      [reservationId, row.id, input.paymentIntentId, total.toString(), nowIso(), isoIn(input.ttlSeconds ?? 3600)],
    );
    db.run(
      `UPDATE liquidity_accounts
       SET available_minor = CAST((CAST(available_minor AS INTEGER) - CAST(? AS INTEGER)) AS TEXT),
           reserved_minor  = CAST((CAST(reserved_minor AS INTEGER) + CAST(? AS INTEGER)) AS TEXT),
           updated_at = ?
       WHERE id = ?`,
      [total.toString(), total.toString(), nowIso(), row.id],
    );
    return { status: 'RESERVED', reservationId, accountId: row.id, amountMinor: total };
  });

  if (result.status === 'RESERVED') {
    log.info('liquidity reserved', { payment: input.paymentIntentId, rail: input.rail, amount: total.toString() });
    publish('admin', 'network', 'liquidity.reserved', {
      paymentIntentId: input.paymentIntentId,
      rail: input.rail,
      amountMinor: total.toString(),
    });
    emitSnapshot();
  }
  return result;
}

export function consume(reservationId: string | null, payoutId: string | null): void {
  if (!reservationId) return;
  const db = getDb();
  db.tx(() => {
    const res = db.maybeOne<{ id: string; liquidity_account_id: string; amount_minor: string; status: string }>(
      'SELECT * FROM liquidity_reservations WHERE id = ?',
      [reservationId],
    );
    if (!res || res.status !== 'HELD') return;
    db.run(`UPDATE liquidity_reservations SET status = 'CONSUMED', consumed_at = ? WHERE id = ?`, [nowIso(), reservationId]);
    db.run(
      `UPDATE liquidity_accounts
       SET reserved_minor = CAST((CAST(reserved_minor AS INTEGER) - CAST(? AS INTEGER)) AS TEXT),
           pending_payout_minor = CAST((CAST(pending_payout_minor AS INTEGER) + CAST(? AS INTEGER)) AS TEXT),
           updated_at = ?
       WHERE id = ?`,
      [res.amount_minor, res.amount_minor, nowIso(), res.liquidity_account_id],
    );
  });
}

export function release(reservationId: string | null, reason: string): void {
  if (!reservationId) return;
  const db = getDb();
  db.tx(() => {
    const res = db.maybeOne<{ id: string; liquidity_account_id: string; amount_minor: string; status: string }>(
      'SELECT * FROM liquidity_reservations WHERE id = ?',
      [reservationId],
    );
    if (!res || res.status !== 'HELD') return;
    db.run(`UPDATE liquidity_reservations SET status = 'RELEASED', released_at = ? WHERE id = ?`, [nowIso(), res.id]);
    db.run(
      `UPDATE liquidity_accounts
       SET reserved_minor = CAST(MAX(0, CAST(reserved_minor AS INTEGER) - CAST(? AS INTEGER)) AS TEXT),
           available_minor = CAST(CAST(available_minor AS INTEGER) + CAST(? AS INTEGER) AS TEXT),
           updated_at = ?
       WHERE id = ?`,
      [res.amount_minor, res.amount_minor, nowIso(), res.liquidity_account_id],
    );
    log.warn('liquidity released', { reservationId: res.id, reason, amount: res.amount_minor });
  });
  emitSnapshot();
}

/** Called when the provider confirms delivery: float actually leaves the account. */
export function settleConsumed(accountId: string, amountMinor: bigint): void {
  const db = getDb();
  db.run(
    `UPDATE liquidity_accounts
     SET pending_payout_minor = CAST(MAX(0, CAST(pending_payout_minor AS INTEGER) - CAST(? AS INTEGER)) AS TEXT),
         updated_at = ?
     WHERE id = ?`,
    [amountMinor.toString(), nowIso(), accountId],
  );
}

/** Move a payout's KES from "reserved" to "pending outflow" without consuming availability twice. */
export function markPending(reservationId: string | null): void {
  if (!reservationId) return;
  const db = getDb();
  const res = db.maybeOne<{ liquidity_account_id: string; amount_minor: string }>(
    'SELECT * FROM liquidity_reservations WHERE id = ?',
    [reservationId],
  );
  if (!res) return;
  db.run(
    `UPDATE liquidity_accounts
     SET reserved_minor = CAST(MAX(0, CAST(reserved_minor AS INTEGER) - CAST(? AS INTEGER)) AS TEXT),
         pending_payout_minor = CAST(CAST(pending_payout_minor AS INTEGER) + CAST(? AS INTEGER) AS TEXT),
         updated_at = ?
     WHERE id = ?`,
    [res.amount_minor, res.amount_minor, nowIso(), res.liquidity_account_id],
  );
}

/** Money coming back to float (failed payout, reversal, treasury top-up). */
/** Operator withdrawal from a settlement account (treasury only, journaled by the caller). */
export function debitFloat(accountId: string, amountMinor: bigint, note: string): void {
  const db = getDb();
  const row = db.maybeOne<{ available_minor: string; label: string | null }>('SELECT available_minor, label FROM liquidity_accounts WHERE id = ?', [accountId]);
  if (!row) throw new DomainError('NOT_FOUND', 'That settlement account does not exist.');
  const available = BigInt(row.available_minor);
  if (available < amountMinor) {
    throw new DomainError(
      'INSUFFICIENT_LIQUIDITY',
      `Only ${formatKes(available)} is available in that account. AuraPay will not take the float below what in-flight payments need.`,
    );
  }
  db.run(
    `UPDATE liquidity_accounts
     SET available_minor = CAST((CAST(available_minor AS INTEGER) - CAST(? AS INTEGER)) AS TEXT), updated_at = ?
     WHERE id = ?`,
    [amountMinor.toString(), nowIso(), accountId],
  );
  insert('liquidity_events', {
    id: id('lqe'),
    account_id: accountId,
    direction: 'OUT',
    amount_minor: amountMinor.toString(),
    reason: note,
    actor: 'operator',
    created_at: nowIso(),
  });
}

export function credit(accountId: string, amountMinor: bigint, note: string): void {
  const db = getDb();
  db.run(
    `UPDATE liquidity_accounts
     SET available_minor = CAST(CAST(available_minor AS INTEGER) + CAST(? AS INTEGER) AS TEXT),
         pending_payout_minor = CAST(MAX(0, CAST(pending_payout_minor AS INTEGER) - CAST(? AS INTEGER)) AS TEXT),
         updated_at = ?
     WHERE id = ?`,
    [amountMinor.toString(), amountMinor.toString(), nowIso(), accountId],
  );
  log.info('liquidity credited', { accountId, amount: amountMinor.toString(), note });
  emitSnapshot();
}

/** Releases reservations whose payment died while we were waiting (crash safety net). */
export function expireStale(): number {
  const db = getDb();
  const stale = db.all<{ id: string }>(
    `SELECT r.id FROM liquidity_reservations r
     JOIN payment_intents p ON p.id = r.payment_intent_id
     WHERE r.status = 'HELD' AND (p.status IN ('FAILED','REFUNDED') OR r.expires_at < ?)`,
    [nowIso()],
  );
  for (const row of stale) release(row.id, 'expired or terminal payment');
  return stale.length;
}

/** Queue depth for pending (liquidity-starved) payments. */
export function pendingQueueDepth(): number {
  const db = getDb();
  return (
    db.maybeOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM payment_intents WHERE status = 'LIQUIDITY_RESERVED' AND recipient_amount_minor IS NOT NULL`,
    )?.c ?? 0
  );
}

export interface LiquidityAlert {
  kind: 'LOW_LIQUIDITY' | 'PROVIDER_FAILURE' | 'UNUSUAL_VOLUME' | 'BLOCKCHAIN_CONGESTION' | 'FX_VOLATILITY';
  severity: 'warning' | 'critical';
  message: string;
  at: string;
}

export function alerts(): LiquidityAlert[] {
  const db = getDb();
  const out: LiquidityAlert[] = [];
  for (const view of listAccounts()) {
    if (view.health === 'CRITICAL') {
      out.push({
        kind: 'LOW_LIQUIDITY',
        severity: 'critical',
        message: `${view.rail} ${view.currency} float is critically low — payouts on this rail will queue.`,
        at: nowIso(),
      });
    } else if (view.health === 'LOW') {
      out.push({
        kind: 'LOW_LIQUIDITY',
        severity: 'warning',
        message: `${view.rail} ${view.currency} float below threshold. Consider a treasury top-up.`,
        at: nowIso(),
      });
    }
  }
  const broken = db.all<{ provider: string; error_rate_bps: number }>(
    `SELECT provider, error_rate_bps FROM provider_accounts WHERE operational = 0 OR error_rate_bps > 500`,
  );
  for (const p of broken) {
    out.push({
      kind: 'PROVIDER_FAILURE',
      severity: 'critical',
      message: `${p.provider} is reporting ${((p.error_rate_bps ?? 0) / 100).toFixed(1)}% errors and has been removed from routing.`,
      at: nowIso(),
    });
  }
  const congestion = db.all<{ code: string; name: string; status: string }>(
    `SELECT code, name, status FROM networks WHERE status != 'OPERATIONAL'`,
  );
  for (const n of congestion) {
    out.push({
      kind: 'BLOCKCHAIN_CONGESTION',
      severity: 'warning',
      message: `${n.name} is ${n.status.toLowerCase()} — deposits on this network will confirm slower than usual.`,
      at: nowIso(),
    });
  }
  const rate = db.maybeOne<{ rate_scaled: string }>(
    `SELECT rate_scaled FROM exchange_rates WHERE base = 'USDT' AND quote = 'KES' ORDER BY fetched_at DESC LIMIT 1`,
  );
  const first = db.maybeOne<{ rate_scaled: string }>(
    `SELECT rate_scaled FROM exchange_rates WHERE base = 'USDT' AND quote = 'KES' ORDER BY fetched_at ASC LIMIT 1`,
  );
  if (rate && first) {
    const moveBps = Number(
      (BigInt(rate.rate_scaled) - BigInt(first.rate_scaled)) * 10_000n / (BigInt(first.rate_scaled) || 1n),
    );
    if (Math.abs(moveBps) > 400) {
      out.push({
        kind: 'FX_VOLATILITY',
        severity: 'warning',
        message: `USDT/KES moved ${(moveBps / 100).toFixed(2)}% inside the current feed window. Quote TTLs are shortened automatically.`,
        at: nowIso(),
      });
    }
  }
  return out;
}

function emitSnapshot(): void {
  publish('admin', 'network', 'liquidity.snapshot', { accounts: listAccounts().map(publicShape), alerts: alerts() });
}

export function publicAccount(view: LiquidityView) {
  return {
    id: view.accountId,
    provider: view.provider,
    rail: view.rail,
    currency: view.currency,
    availableMinor: view.availableMinor.toString(),
    reservedMinor: view.reservedMinor.toString(),
    pendingPayoutMinor: view.pendingPayoutMinor.toString(),
    floatTargetMinor: view.floatTargetMinor.toString(),
    utilisationPct: view.utilisationPct,
    health: view.health,
    dataOrigin: view.dataOrigin,
  };
}

const publicShape = publicAccount;

export function ensureAccountFor(rail: RailCode, currency: string, provider: string, floatTargetMinor: bigint): void {
  const db = getDb();
  const existing = findAccount(rail, currency);
  if (existing) {
    db.run('UPDATE liquidity_accounts SET provider = ?, float_target_minor = ? WHERE id = ?', [
      provider,
      floatTargetMinor.toString(),
      existing.id,
    ]);
    return;
  }
  db.run(
    `INSERT INTO liquidity_accounts
     (id, provider, rail, currency, country, label, available_minor, reserved_minor, pending_payout_minor, float_target_minor, health, data_origin, updated_at)
     VALUES (?,?,?,?,?,?,?, '0', '0', ?, 'HEALTHY', ?, ?)`,
    [
      id('liq'),
      provider,
      rail,
      currency,
      'KE',
      `${rail} float`,
      '0',
      floatTargetMinor.toString(),
      config.isSandbox ? 'sandbox' : 'live',
      nowIso(),
    ],
  );
}

export function assertSettlementFundsOrThrow(rail: RailCode, currency: string, amountMinor: bigint): void {
  const view = viewFor(rail, currency);
  if (!view) throw new DomainError('RAIL_UNAVAILABLE', `No ${currency} settlement account exists for ${rail}.`);
  if (view.availableMinor < amountMinor && !config.liquidity.allowQueueOnInsufficient) {
    throw new DomainError('INSUFFICIENT_LIQUIDITY', undefined, {
      rail,
      currency,
      requiredMinor: amountMinor.toString(),
      availableMinor: view.availableMinor.toString(),
    });
  }
}
