import { displayStatus, isTerminal, DomainError, type PaymentState } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { id, nowIso } from '../lib/ids.js';
import { displayHandle, type RecipientRecord } from './recipients.js';
import { stringify } from '../lib/json.js';

/**
 * Payment persistence + projections.
 *
 * This module is the only place that knows the shape of `payment_intents`,
 * `payment_events`, `payments`, `payouts` and the `transactions` history
 * projection. Keeping it dependency-light is what lets the state machine, the
 * payout engine and the refund engine all sit on the same data without an
 * import cycle.
 */

export interface PaymentRow {
  id: string;
  reference: string;
  external_id: string | null;
  idempotency_key: string | null;
  user_id: string | null;
  business_id: string | null;
  payment_link_id: string | null;
  quote_id: string | null;
  recipient_id: string | null;
  recipient_snapshot: string;
  direction: 'IN' | 'OUT';
  kind: string;
  status: PaymentState;
  asset: string;
  network: string;
  rail: string;
  provider: string;
  recipient_currency: string;
  recipient_amount_minor: string;
  crypto_amount_minor: string;
  network_fee_minor: string;
  service_fee_minor: string;
  total_debit_minor: string;
  fx_rate_scaled: string;
  mid_rate_scaled: string;
  fee_snapshot: string;
  route_snapshot: string;
  deposit_address: string | null;
  deposit_memo: string | null;
  deposit_expires_at: string | null;
  liquidity_reservation_id: string | null;
  settlement_state: 'FUNDED' | 'WAITING_FLOAT';
  risk_score: number;
  risk_level: string;
  risk_decision: string;
  risk_json: string | null;
  compliance_case_id: string | null;
  strong_confirmation: number;
  mode: 'sandbox' | 'production';
  data_origin: string;
  failure_code: string | null;
  failure_message: string | null;
  failure_recovery: string | null;
  receipt_id: string | null;
  amount_kes_real: number;
  amount_usd_real: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  completed_at: string | null;
}

export function byId(paymentId: string): PaymentRow | null {
  return getDb().maybeOne<PaymentRow>('SELECT * FROM payment_intents WHERE id = ?', [paymentId]) ?? null;
}

export function byReference(reference: string): PaymentRow | null {
  return getDb().maybeOne<PaymentRow>('SELECT * FROM payment_intents WHERE reference = ?', [reference]) ?? null;
}

export function requireById(paymentId: string): PaymentRow {
  const row = byId(paymentId);
  if (!row) {
    // A DomainError, not a bare Error: an id typed into a bookmark, a payment from a
    // reseeded database, or a stale link must read as "we have no such payment" (404).
    // As an unhandled error it became a 500 telling the customer "the payment was not
    // changed" — technically true, and about the most confusing thing we could say.
    throw new DomainError(
      'NOT_FOUND',
      'We have no payment with that id on this account.',
      { recovery: 'go_back', reference: paymentId },
    );
  }
  return row;
}

export function recipientOf(row: PaymentRow): RecipientRecord & { verification?: { verified: boolean; name: string | null } } {
  return JSON.parse(row.recipient_snapshot) as RecipientRecord & { verification?: { verified: boolean; name: string | null } };
}

export function routeOf(row: PaymentRow): {
  routeId?: string;
  provider?: string;
  providerDisplayName?: string;
  feeMinor?: string;
  fixedFeeMinor?: string;
  feeBps?: number;
  latencySeconds?: number;
  estimatedSettlementSeconds?: number;
  considered?: unknown[];
  fallbacks?: Array<{ rail: string; provider: string; reason: string }>;
  notes?: string[];
  refundable?: boolean;
  instant?: boolean;
} {
  return JSON.parse(row.route_snapshot) as ReturnType<typeof routeOf>;
}

export function feesOf(row: PaymentRow): Record<string, string> {
  try {
    return JSON.parse(row.fee_snapshot) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Insert a row from a record, so column/value lists can never drift apart. */
export function insertRow(table: 'payment_intents', data: Record<string, unknown>): void {
  const keys = Object.keys(data);
  getDb().run(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => normalize(data[k])),
  );
}

export function update(paymentId: string, patch: Partial<Record<string, unknown>>): void {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  if (!keys.length) return;
  const sql = `UPDATE payment_intents SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  const params = keys.map((k) => normalize(patch[k]));
  getDb().run(sql, [...params, nowIso(), paymentId]);
}

function normalize(value: unknown): string | number | bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return stringify(value);
  return value as string | number | bigint;
}

export function insertEvent(input: {
  paymentId: string;
  from: PaymentState | null;
  to: PaymentState;
  actor: string;
  note?: string | null;
  metadata?: unknown;
}): void {
  getDb().run(
    `INSERT INTO payment_events (payment_intent_id, from_state, to_state, actor, note, metadata, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [input.paymentId, input.from, input.to, input.actor, input.note ?? null, input.metadata ? stringify(input.metadata) : null, nowIso()],
  );
}

export function events(paymentId: string): Array<{ from_state: string | null; to_state: string; actor: string; note: string | null; created_at: string }> {
  return getDb().all(
    `SELECT from_state, to_state, actor, note, created_at FROM payment_events WHERE payment_intent_id = ? ORDER BY id`,
    [paymentId],
  );
}

/** Keeps the user-facing `transactions` history projection in step with the intent. */
export function syncTransactionProjection(row: PaymentRow, state?: PaymentState): void {
  const db = getDb();
  const current = state ?? row.status;
  const status = displayStatus(current);
  const snapshot = recipientOf(row);
  const merchant = row.business_id
    ? db.maybeOne<{ name: string }>('SELECT name FROM businesses WHERE id = ?', [row.business_id])?.name ?? null
    : null;
  const existing = db.maybeOne<{ id: string }>('SELECT id FROM transactions WHERE payment_intent_id = ?', [row.id]);
  const feeMinor = BigInt(row.network_fee_minor) + BigInt(row.service_fee_minor);
  if (existing) {
    db.run(
      `UPDATE transactions
       SET status = ?, state = ?, updated_at = ?, completed_at = ?, receipt_id = ?, recipient_label = ?, recipient_handle = ?, amount_minor = ?, crypto_amount_minor = ?
       WHERE id = ?`,
      [
        status,
        current,
        nowIso(),
        isTerminal(current) ? (row.completed_at ?? nowIso()) : null,
        row.receipt_id,
        snapshot.displayName ?? 'Recipient',
        displayHandle(snapshot),
        row.recipient_amount_minor,
        row.crypto_amount_minor,
        existing.id,
      ],
    );
    return;
  }
  db.run(
    `INSERT INTO transactions
     (id, reference, user_id, business_id, payment_intent_id, kind, direction, status, state, asset, network,
      amount_minor, crypto_amount_minor, fx_rate_scaled, fee_minor, recipient_label, recipient_handle, merchant_name,
      mode, amount_kes_real, amount_usd_real, created_at, updated_at, completed_at, receipt_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id('tx'),
      row.reference,
      row.user_id,
      row.business_id,
      row.id,
      row.kind,
      row.direction,
      status,
      current,
      row.asset,
      row.network,
      row.recipient_amount_minor,
      row.crypto_amount_minor,
      row.fx_rate_scaled,
      feeMinor.toString(),
      snapshot.displayName ?? 'Recipient',
      displayHandle(snapshot),
      merchant,
      row.mode,
      Number(BigInt(row.recipient_amount_minor)) / 100,
      Number(BigInt(row.total_debit_minor)) / 1_000_000,
      row.created_at,
      nowIso(),
      isTerminal(current) ? (row.completed_at ?? nowIso()) : null,
      row.receipt_id,
    ],
  );
}

export function depositRow(paymentId: string): {
  id: string;
  tx_hash: string | null;
  confirmations: number;
  confirmations_required: number;
  block_height: string | null;
  detected_at: string | null;
  finalized_at: string | null;
  data_origin: string;
  amount_minor: string;
} | null {
  return (
    getDb().maybeOne<{
      id: string;
      tx_hash: string | null;
      confirmations: number;
      confirmations_required: number;
      block_height: string | null;
      detected_at: string | null;
      finalized_at: string | null;
      data_origin: string;
      amount_minor: string;
    }>(
      `SELECT p.id, p.tx_hash, p.confirmations, p.confirmations_required, p.block_height, p.detected_at, p.finalized_at, p.data_origin, p.amount_minor
       FROM payments p WHERE p.payment_intent_id = ? ORDER BY p.created_at DESC LIMIT 1`,
      [paymentId],
    ) ?? null
  );
}

export function updateDeposit(paymentId: string, patch: Partial<Record<string, unknown>>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  getDb().run(
    `UPDATE payments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE payment_intent_id = ?`,
    [...keys.map((k) => normalize(patch[k])), nowIso(), paymentId],
  );
}

export function latestPayout(paymentId: string) {
  return (
    getDb().maybeOne<{
      id: string;
      state: string;
      rail: string;
      provider: string;
      provider_reference: string | null;
      phone: string | null;
      amount_minor: string;
      submitted_at: string | null;
      confirmed_at: string | null;
      failure_code: string | null;
      failure_message: string | null;
      attempts: number;
    }>('SELECT * FROM payouts WHERE payment_intent_id = ? ORDER BY created_at DESC LIMIT 1', [paymentId]) ?? null
  );
}

export function openCount(userId: string, within?: string): number {
  const db = getDb();
  const windowSql = within ? `AND created_at >= datetime('now', ?)` : '';
  const params: (string | number)[] = [userId];
  if (within) params.push(within);
  return (
    db.maybeOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM payment_intents WHERE user_id = ? AND status NOT IN ('COMPLETED','FAILED','REFUNDED') ${windowSql}`,
      params,
    )?.c ?? 0
  );
}

export function failedCount(userId: string, window: string): number {
  return (
    getDb().maybeOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM payment_intents WHERE user_id = ? AND status = 'FAILED' AND created_at >= datetime('now', ?)`,
      [userId, window],
    )?.c ?? 0
  );
}
