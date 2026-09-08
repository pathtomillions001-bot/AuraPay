import {
  DomainError,
  RAILS,
  REFUND_STATES,
  formatKes,
  type AssetCode,
  type PayableAsset,
  type RefundState,
} from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, nowIso, reference } from '../lib/ids.js';
import { createLogger } from '../logger.js';
import { publish } from './realtime.js';
import * as ledger from './ledger.js';
import * as wallets from './wallets.js';
import * as notifications from './notifications.js';
import { emit as emitWebhook } from './webhooks.js';
import { advance, amountsOf, ownerOf, railKey, transition } from './paymentCore.js';
import * as compliance from './compliance.js';
import { latestPayout, requireById, update } from './paymentRepo.js';
import { adapterFor } from './payouts.js';
import { insert } from '../db/rows.js';

const log = createLogger('refunds');

/**
 * Refunds.
 *
 * Two very different things live here, and the platform must not blur them:
 *
 *   A. **Failure refunds** — a payment could not be completed, so the money the
 *      customer committed is returned. The ledger reversal already happened in
 *      `paymentCore.failPayment()` (compensating entries), and this module
 *      restores the customer's balance from custody. State goes
 *      `REFUND_PENDING → REFUNDED` once the balance is actually back.
 *
 *   B. **Merchant refunds** of a *completed* payment — the recipient already has
 *      the KES. Whether money can come back at all depends on the rail:
 *        - `refundable: false` rails (M-Pesa STK to a person, Till, PayBill) have
 *          no reversal API. A refund is a *request*: it is recorded, sent to the
 *          partner/merchant, and stays PENDING until someone confirms it. The UI
 *          says exactly that — AuraPay never promises an instant refund.
 *        - Where a partner exposes a reversal endpoint, the request is submitted
 *          and the outcome is read back from the provider, not assumed.
 *      Because the shillings are already gone, the customer is made whole from
 *      the settlement float, which is why the KES→asset leg is a *conversion* at
 *      today's rate: the FX movement between the original payment and the refund
 *      is booked as an explicit gain or loss, never buried.
 *
 * Amounts: a refund returns the crypto the customer actually paid, pro-rated by
 * the KES share being refunded, using the rate recorded on the payment. Fees that
 * were genuinely spent (on-chain gas) are not returned, and the receipt says so.
 */

export interface RefundRecord {
  id: string;
  paymentIntentId: string;
  reference: string;
  originalPaymentId: string;
  amountMinor: string;
  currency: string;
  asset: AssetCode;
  cryptoAmountMinor: string;
  destination: string;
  method: 'BALANCE_CREDIT' | 'RAIL_REVERSAL' | 'MANUAL_REQUEST';
  mode: 'AUTO' | 'MANUAL';
  status: RefundState;
  reasonCode: string | null;
  reason: string | null;
  providerReference: string | null;
  requestedAt: string;
  updatedAt: string;
  completedAt: string | null;
  note: string | null;
  dataOrigin: string;
  actor: string | null;
  recoveryState: 'NONE' | 'PENDING' | 'RECOVERED' | 'WRITTEN_OFF';
}

interface RefundRow {
  id: string;
  payment_intent_id: string;
  reference: string;
  amount_minor: string;
  currency: string;
  asset: string;
  crypto_amount_minor: string;
  destination: string | null;
  method: string;
  automation: string;
  state: string;
  reason_code: string | null;
  reason: string | null;
  provider_reference: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  note: string | null;
  data_origin: string;
  requested_by: string | null;
  approved_by: string | null;
  recovery_state: string;
}

function toRecord(row: RefundRow): RefundRecord {
  return {
    id: row.id,
    paymentIntentId: row.payment_intent_id,
    reference: row.reference,
    originalPaymentId: row.payment_intent_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    asset: row.asset as AssetCode,
    cryptoAmountMinor: row.crypto_amount_minor,
    destination: row.destination ?? '—',
    method: row.method as RefundRecord['method'],
    mode: row.automation === 'AUTO' ? 'AUTO' : 'MANUAL',
    status: row.state as RefundState,
    reasonCode: row.reason_code,
    reason: row.reason,
    providerReference: row.provider_reference,
    requestedAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    note: row.note,
    dataOrigin: row.data_origin,
    actor: row.approved_by,
    recoveryState: row.recovery_state as RefundRecord['recoveryState'],
  };
}

export function byId(refundId: string): RefundRecord | null {
  const row = getDb().maybeOne<RefundRow>('SELECT * FROM refunds WHERE id = ?', [refundId]);
  return row ? toRecord(row) : null;
}

export function listForPayment(paymentId: string): RefundRecord[] {
  return getDb().all<RefundRow>('SELECT * FROM refunds WHERE payment_intent_id = ? ORDER BY requested_at DESC', [paymentId]).map(toRecord);
}

export function listRecent(limit = 50): RefundRecord[] {
  return getDb().all<RefundRow>('SELECT * FROM refunds ORDER BY requested_at DESC LIMIT ?', [limit]).map(toRecord);
}

/** What the UI is allowed to promise for this payment, and why. */
const refundWindowDays = config.payments.refundWindowDays ?? 30;

export function capability(paymentId: string): {
  refundable: boolean;
  mode: 'AUTO' | 'MANUAL';
  reason: string;
  rail: string;
  railLabel: string;
  partialAllowed: boolean;
  windowEndsAt: string | null;
  alreadyRefundedMinor: bigint;
} {
  const db = getDb();
  const row = requireById(paymentId);
  const rail = RAILS[row.rail as keyof typeof RAILS];
  const railLabel = rail?.recipientFacing ?? row.rail;
  const already = refundedMinor(paymentId);
  const windowEndsAt = refundWindowDays
    ? new Date(new Date(row.created_at).getTime() + refundWindowDays * 86_400_000).toISOString()
    : null;
  const outOfWindow = windowEndsAt !== null && Date.now() > new Date(windowEndsAt).getTime();
  const payout = latestPayout(paymentId);
  const adapter = (() => {
    try {
      return payout ? adapterFor(payout.provider) : null;
    } catch {
      return null;
    }
  })();
  const reversible = adapter?.supportsReversal === true && adapter?.simulated === true;

  if (row.status === 'FAILED') {
    return {
      refundable: true,
      mode: 'AUTO',
      reason: 'The payment failed before delivery, so the committed crypto is returned to your AuraPay balance.',
      rail: row.rail,
      railLabel,
      partialAllowed: false,
      windowEndsAt: null,
      alreadyRefundedMinor: already,
    };
  }
  if (row.status !== 'COMPLETED') {
    return {
      refundable: false,
      mode: 'MANUAL',
      reason: `A refund can only be started once the payment finished. It is currently ${row.status.replace(/_/g, ' ').toLowerCase()}.`,
      rail: row.rail,
      railLabel,
      partialAllowed: false,
      windowEndsAt,
      alreadyRefundedMinor: already,
    };
  }
  if (outOfWindow) {
    return {
      refundable: false,
      mode: 'MANUAL',
      reason: `This payment is older than the ${refundWindowDays}-day refund window. Contact support with reference ${row.reference}.`,
      rail: row.rail,
      railLabel,
      partialAllowed: false,
      windowEndsAt,
      alreadyRefundedMinor: already,
    };
  }
  if (reversible) {
    return {
      refundable: true,
      mode: 'AUTO',
      reason: `${railLabel} supports reversal through the partner API. AuraPay submits the request and waits for the partner to confirm — it is not instant, and the status here follows the partner.`,
      rail: row.rail,
      railLabel,
      partialAllowed: true,
      windowEndsAt,
      alreadyRefundedMinor: already,
    };
  }
  return {
    refundable: true,
    mode: 'MANUAL',
    reason: `${railLabel} has no reversal API, so this becomes a refund request to the recipient's institution. It can take several working days and may be declined; AuraPay records every update but cannot promise the money will come back.`,
    rail: row.rail,
    railLabel,
    partialAllowed: true,
    windowEndsAt,
    alreadyRefundedMinor: already,
  };
}

function refundedMinor(paymentId: string): bigint {
  const rows = getDb().all<RefundRow>(
    // A refund only reduces what can still be refunded once the partner has
    // actually returned the money — SUBMITTED is not yet returned.
    `SELECT * FROM refunds WHERE payment_intent_id = ? AND state = 'COMPLETED'`,
    [paymentId],
  );
  return rows.reduce((acc, r) => acc + BigInt(r.amount_minor), 0n);
}

export interface RefundInput {
  amountKesMinor?: bigint;
  reasonCode?: string;
  reason?: string;
  mode?: 'AUTO' | 'MANUAL';
  actor: string;
  businessId?: string | null;
}

/**
 * Start a refund. `AUTO` returns funds to the payer's balance (failure refunds);
 * `MANUAL` records a request against the rail and leaves it pending.
 */
export async function refund(
  paymentId: string,
  input: RefundInput,
): Promise<{ refundId: string; reference: string; state: RefundState; detail: string }> {
  const db = getDb();
  const row = requireById(paymentId);
  if (row.status !== 'COMPLETED' && row.status !== 'FAILED' && row.status !== 'REFUND_PENDING') {
    throw new DomainError('PAYMENT_NOT_REFUNDABLE', `This payment is ${row.status.replace(/_/g, ' ').toLowerCase()}, so there is nothing to refund yet.`);
  }
  const cap = capability(paymentId);
  const reversible = cap.mode === 'AUTO';
  if (input.mode === 'AUTO' && row.status === 'COMPLETED' && cap.mode !== 'AUTO') {
    throw new DomainError('PAYMENT_NOT_REFUNDABLE', cap.reason);
  }
  const mode = row.status === 'FAILED' ? 'AUTO' : (input.mode ?? cap.mode);
  const a = amountsOf(row);
  const originalKes = a.deliverable;
  const already = refundedMinor(paymentId);
  const remainingKes = originalKes - already;
  if (remainingKes <= 0n) {
    throw new DomainError('PAYMENT_NOT_REFUNDABLE', 'This payment has already been refunded in full.');
  }
  const kesMinor = input.amountKesMinor !== undefined && input.amountKesMinor > 0n ? input.amountKesMinor : remainingKes;
  if (kesMinor > remainingKes) {
    throw new DomainError('VALIDATION_FAILED', `You can refund at most ${formatKes(remainingKes)} on this payment.`, {
      maxKesMinor: remainingKes.toString(),
    });
  }
  // Pro-rata share of the crypto the customer paid, priced on the payment's own
  // numbers — not on today's market.
  const ratio = kesMinor * 1_000_000_000n / originalKes;
  let cryptoBack = (a.totalDebit * ratio) / 1_000_000_000n;
  // The network fee was spent on-chain and cannot come back; drop it from the
  // refund and say so in the receipt.
  const gasShare = (a.networkFee * ratio) / 1_000_000_000n;
  cryptoBack = cryptoBack > gasShare ? cryptoBack - gasShare : 0n;
  if (cryptoBack <= 0n) {
    throw new DomainError(
      'PAYMENT_NOT_REFUNDABLE',
      'The amount left to refund is smaller than the on-chain fee already spent, so there is nothing returnable. Contact support if you need this handled manually.',
    );
  }

  const refundId = id('ref');
  const refundReference = reference('RF');
  const destination = describeDestination(row);
  const method: RefundRecord['method'] = mode === 'AUTO' ? 'BALANCE_CREDIT' : reversible ? 'RAIL_REVERSAL' : 'MANUAL_REQUEST';
  const state: RefundState = 'PENDING';
  const now = nowIso();

  db.tx(() => {
    insert('refunds', {
      id: refundId,
      payment_intent_id: paymentId,
      payout_id: latestPayout(paymentId)?.id ?? null,
      reference: refundReference,
      amount_minor: kesMinor.toString(),
      crypto_amount_minor: cryptoBack.toString(),
      asset: a.asset,
      currency: row.recipient_currency,
      destination,
      method,
      state,
      reason: input.reason ?? (row.status === 'FAILED' ? row.failure_message : 'Refund requested by the payer.'),
      reason_code: input.reasonCode ?? (row.status === 'FAILED' ? row.failure_code : 'MERCHANT_REFUND'),
      automation: mode,
      recovery_state: mode === 'AUTO' ? 'NONE' : 'PENDING',
      requested_by: row.user_id,
      approved_by: input.actor,
      data_origin: config.isSandbox ? 'sandbox' : 'live',
      created_at: now,
      updated_at: now,
    });
    if (row.status === 'COMPLETED') transition(paymentId, 'REFUND_PENDING', input.actor, `refund ${refundReference} started`);
  });

  let detail: string;
  let finalState: RefundState = state;

  if (mode === 'AUTO') {
    settleAutoRefund(refundId);
    const record = byId(refundId);
    finalState = record?.status ?? 'COMPLETED';
    detail =
      `Refunded ${formatCryptoSafe(cryptoBack, a.asset)} to your AuraPay balance (destination ${destination}). ` +
      `${formatKes(gasShare)} of network fee was already paid to the ${row.network.replace(/_/g, ' ')} network and cannot be returned.`;
  } else {
    const submitted = await submitRailReversal(refundId, input.reason ?? 'refund requested');
    finalState = submitted.state;
    detail = submitted.detail;
    db.run(`UPDATE refunds SET state = ?, note = ?, provider_reference = COALESCE(?, provider_reference), updated_at = ? WHERE id = ?`, [
      finalState,
      submitted.error ?? null,
      submitted.providerReference ?? null,
      nowIso(),
      refundId,
    ]);
  }

  update(paymentId, {});
  const updated = requireById(paymentId);
  emitRefundEvent(updated, refundId);
  if (updated.user_id) {
    notifications.push(updated.user_id, {
      title: finalState === 'COMPLETED' ? 'Refund completed' : 'Refund requested',
      body:
        finalState === 'COMPLETED'
          ? `${formatCryptoSafe(cryptoBack, a.asset)} was returned to your balance for ${updated.reference}.`
          : `We sent a refund request for ${formatKes(kesMinor)} (${updated.reference}) to ${cap.railLabel}. We will update you when the partner responds.`,
      severity: finalState === 'COMPLETED' ? 'success' : 'info',
      link: `/app/transactions/${paymentId}`,
      paymentIntentId: paymentId,
    });
    publish(`user:${updated.user_id}`, 'payment', 'refund.state', { paymentId, refundId, state: finalState, at: now });
  }
  log.info('refund', { payment: updated.reference, refundId, mode, state: finalState, actor: input.actor });
  return { refundId, reference: refundReference, state: finalState, detail };
}

/**
 * The state graph only reaches REFUNDED through REFUND_PENDING, so a payment that
 * failed outright passes through the pending state on its way back. Every hop is
 * logged, which is what the timeline shows.
 */
function markRefunded(paymentId: string, note: string): void {
  const row = requireById(paymentId);
  if (row.status === 'REFUNDED' || row.status === 'REFUND_PENDING') {
    if (row.status === 'REFUND_PENDING') transition(paymentId, 'REFUNDED', 'system', note);
    return;
  }
  if (advance(paymentId, 'REFUND_PENDING', 'system', 'refund started')) transition(paymentId, 'REFUNDED', 'system', note);
}

function describeDestination(row: ReturnType<typeof requireById>): string {
  const snapshot = JSON.parse(row.recipient_snapshot) as { phone?: string | null; till?: string | null; paybill?: string | null; accountReference?: string | null };
  if (snapshot.phone) return `M-Pesa ${snapshot.phone}`;
  if (snapshot.till) return `Till ${snapshot.till}`;
  if (snapshot.paybill) return `PayBill ${snapshot.paybill} (${snapshot.accountReference ?? 'no reference'})`;
  return RAILS[row.rail as keyof typeof RAILS]?.recipientFacing ?? row.rail;
}

/**
 * Put the crypto back where it came from. Only valid while the funds are still
 * in the platform's own custody (i.e. a failure before or during liquidation).
 */
function settleAutoRefund(refundId: string): void {
  const db = getDb();
  const refundRow = db.maybeOne<RefundRow>('SELECT * FROM refunds WHERE id = ?', [refundId]);
  if (!refundRow) throw new DomainError('NOT_FOUND', 'That refund no longer exists.');
  const payment = requireById(refundRow.payment_intent_id);
  const asset = refundRow.asset as AssetCode;
  const cryptoBack = BigInt(refundRow.crypto_amount_minor);
  const kesBack = BigInt(refundRow.amount_minor);
  const user = ownerOf(payment);

  db.tx(() => {
    if (payment.status === 'FAILED' && ledger.journalGroupsFor(payment.id).length === 0) {
      // Nothing was ever committed, so there is no balance to restore: the hold
      // release in failPayment already returned the money.
    } else {
      ledger.postJournal({
        group: `${refundId}:customer`,
        asset,
        paymentIntentId: payment.id,
        refundId,
        memo: `Refund ${refundRow.reference} to customer balance`,
        entries: [
          {
            accountCode: ledger.accounts.clearing(asset, payment.network),
            direction: 'DEBIT',
            asset,
            amountMinor: cryptoBack,
            code: 'REFUND_CRYPTO_DEBIT',
            memo: 'crypto returned to the payer from settlement custody',
          },
          {
            accountCode: ledger.accounts.user(user, asset),
            direction: 'CREDIT',
            asset,
            amountMinor: cryptoBack,
            code: 'REFUND_CRYPTO_CREDIT',
            memo: refundRow.reference,
          },
        ],
      });
    }
    wallets.credit({ userId: user, asset: asset as PayableAsset, network: payment.network as never, amountMinor: cryptoBack });
    db.run(`UPDATE refunds SET state = 'COMPLETED', recovery_state = 'NONE', completed_at = ?, updated_at = ? WHERE id = ?`, [
      nowIso(),
      nowIso(),
      refundId,
    ]);
    markRefunded(payment.id, `refund ${refundRow.reference} credited to the payer balance`);
    if (kesBack > 0n) {
      // The float keeps a claim on the rail/merchant for the KES side; it is
      // reported as a receivable until recovered (see treasury.recordRefundRecovery).
      log.info('refund KES side pending recovery', { refundId, kesBack: kesBack.toString() });
    }
  });
}

async function submitRailReversal(
  refundId: string,
  reason: string,
): Promise<{ state: RefundState; detail: string; error?: string; providerReference?: string | null }> {
  const db = getDb();
  const refundRow = db.maybeOne<RefundRow>('SELECT * FROM refunds WHERE id = ?', [refundId]);
  if (!refundRow) throw new DomainError('NOT_FOUND', 'That refund no longer exists.');
  const payout = latestPayout(refundRow.payment_intent_id);
  if (!payout) {
    return {
      state: 'PENDING',
      detail: 'There is no payout record to reverse, so this refund must be handled by an operator.',
      error: 'payout record missing',
    };
  }
  let adapter;
  try {
    adapter = adapterFor(payout.provider);
  } catch (error) {
    return { state: 'PENDING', detail: (error as Error).message, error: (error as Error).message };
  }
  if (!adapter.reversal) {
    return {
      state: 'PENDING',
      detail: `${adapter.displayName} has no reversal API. The request was logged for the partner support process; refunds on this rail typically take 3–5 working days and can be declined.`,
      error: 'no reversal API on this rail',
    };
  }
  try {
    const result = await adapter.reversal(
      {
        payoutId: payout.id,
        paymentIntentId: refundRow.payment_intent_id,
        reference: refundRow.reference,
        provider: payout.provider,
        rail: payout.rail as never,
        amountMinor: BigInt(refundRow.amount_minor),
        currency: refundRow.currency,
        phone: null,
        accountNumber: null,
        recipientName: null,
        payerComment: `Refund ${reason}`.slice(0, 80),
      },
      reason,
    );
    if (result.state === 'FAILED') {
      return { state: 'REJECTED', detail: `${adapter.displayName} declined the reversal: ${result.message ?? 'no reason given'}`, error: result.message ?? undefined, providerReference: result.providerReference };
    }
    if (result.state === 'CONFIRMED') {
      completeRefund(refundId, result.providerReference ?? null);
      return { state: 'COMPLETED', detail: `${adapter.displayName} confirmed the reversal.`, providerReference: result.providerReference };
    }
    return {
      state: 'PENDING',
      detail: `Reversal submitted to ${adapter.displayName}. The refund stays pending until the partner confirms it — that is their timeline, not ours.`,
      providerReference: result.providerReference,
    };
  } catch (error) {
    const message = (error as Error).message;
    db.run(`UPDATE payouts SET state = 'REVERSAL_FAILED', failure_message = ?, updated_at = ? WHERE id = ?`, [message, nowIso(), payout.id]);
    return {
      state: 'PENDING',
      detail: `The reversal request to ${adapter.displayName} did not go through (${message}). AuraPay will retry it; the refund stays pending until it succeeds.`,
      error: message,
    };
  }
}

export function completeRefund(refundId: string, providerReference: string | null): void {
  const db = getDb();
  const refundRow = db.maybeOne<RefundRow>('SELECT * FROM refunds WHERE id = ?', [refundId]);
  if (!refundRow || refundRow.state === 'COMPLETED') return;
  const payment = requireById(refundRow.payment_intent_id);
  const asset = refundRow.asset as AssetCode;
  const cryptoBack = BigInt(refundRow.crypto_amount_minor);
  const user = ownerOf(payment);
  db.tx(() => {
    // The rail returned the KES into the float: book it and fund the customer.
    ledger.postConversion({
      group: `${refundId}:reversal`,
      fromAsset: 'KES',
      toAsset: asset,
      fromAmountMinor: BigInt(refundRow.amount_minor),
      creditAccount: ledger.accounts.liquidity(railKey(payment.rail)),
      rateScaled: BigInt(payment.fx_rate_scaled),
      toleranceMinor: BigInt(refundRow.amount_minor) / 100n + 2n,
      paymentIntentId: payment.id,
      memo: `Rail reversal for ${refundRow.reference}`,
      toEntries: [
        {
          accountCode: ledger.accounts.user(user, asset),
          direction: 'DEBIT',
          asset,
          amountMinor: cryptoBack,
          code: 'REFUND_CUSTOMER_CREDIT',
          memo: refundRow.reference,
        },
      ],
    });
    wallets.credit({ userId: user, asset: asset as PayableAsset, network: payment.network as never, amountMinor: cryptoBack });
    db.run(
      `UPDATE refunds SET state = 'COMPLETED', provider_reference = COALESCE(?, provider_reference), recovery_state = 'RECOVERED', completed_at = ?, updated_at = ? WHERE id = ?`,
      [providerReference, nowIso(), nowIso(), refundId],
    );
    markRefunded(payment.id, `refund ${refundRow.reference} confirmed by the rail`);
  });
}

export function failRefund(refundId: string, message: string): void {
  const db = getDb();
  const refundRow = db.maybeOne<RefundRow>('SELECT * FROM refunds WHERE id = ?', [refundId]);
  if (!refundRow) return;
  db.run(`UPDATE refunds SET state = 'REJECTED', note = ?, recovery_state = 'WRITTEN_OFF', updated_at = ? WHERE id = ?`, [
    message,
    nowIso(),
    refundId,
  ]);
  const payment = requireById(refundRow.payment_intent_id);
  // The payment is not refundable; it stays in its completed state and the
  // reason is surfaced to both sides instead of being hidden.
  if (payment.user_id) {
    notifications.push(payment.user_id, {
      title: 'Refund declined',
      body: message,
      severity: 'warning',
      link: `/app/transactions/${payment.id}`,
      paymentIntentId: payment.id,
    });
  }
  if (payment.status === 'REFUND_PENDING') {
    // No legal way back to COMPLETED in the graph, so the outcome is recorded on
    // the payment and exposed to support via a compliance case.
    compliance.openCase({
      kind: 'DISPUTE',
      subject: `payment:${payment.reference}`,
      riskLevel: 'MEDIUM',
      userId: payment.user_id,
      paymentIntentId: payment.id,
      businessId: payment.business_id,
      note: `Refund ${refundRow.reference} was declined: ${message}`,
    });
  }
  emitRefundEvent(payment, refundId);
}

function emitRefundEvent(payment: ReturnType<typeof requireById>, refundId: string): void {
  const record = byId(refundId);
  if (!record) return;
  emitWebhook(record.status === 'COMPLETED' ? 'payment.refunded' : 'payment.refund_requested', {
    refund: { ...record, originalPaymentId: payment.id },
  }, { paymentIntentId: payment.id, businessId: payment.business_id, userId: payment.user_id });
}

/** Pending manual refunds for the admin/compliance queue. */
export function pendingQueue(): Array<RefundRecord & { paymentReference: string; userName: string | null }> {
  const db = getDb();
  return db
    .all<RefundRow & { payment_reference: string; user_name: string | null }>(
      `SELECT r.*, p.reference AS payment_reference, u.full_name AS user_name
       FROM refunds r
       JOIN payment_intents p ON p.id = r.payment_intent_id
       LEFT JOIN users u ON u.id = p.user_id
       WHERE r.state IN ('PENDING','SUBMITTED')
       ORDER BY r.created_at DESC LIMIT 100`,
    )
    .map((row) => ({ ...toRecord(row), paymentReference: row.payment_reference, userName: row.user_name }));

}

export function stateMachineNote(): string {
  return `Refund states: ${REFUND_STATES.join(' → ')}. A refund is never marked complete by AuraPay alone; it completes when the rail or the operator confirms the money moved.`;
}

function formatCryptoSafe(minor: bigint, asset: AssetCode): string {
  try {
    return `${(Number(minor) / 10 ** (asset === 'BTC' ? 8 : asset === 'ETH' ? 18 : 6)).toFixed(6).replace(/\.?0+$/, '')} ${asset}`;
  } catch {
    return `${minor} base units`;
  }
}

/** Register the handler used by paymentCore.failPayment(). */
export function asHandler() {
  return async (
    paymentId: string,
    input: { reasonCode: string; reason: string; mode?: 'AUTO' | 'MANUAL'; actor: string },
  ): Promise<{ refundId: string; state: string }> => {
    const result = await refund(paymentId, {
      reasonCode: input.reasonCode,
      reason: input.reason,
      mode: 'AUTO',
      actor: input.actor,
    });
    return { refundId: result.refundId, state: result.state };
  };
}
