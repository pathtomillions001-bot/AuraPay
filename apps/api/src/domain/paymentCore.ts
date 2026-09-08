import {
  DomainError,
  PAYMENT_STEPS,
  STATE_TO_WEBHOOK_EVENT,
  canTransition,
  displayStatus,
  isTerminal,
  type AssetCode,
  type PaymentState,
} from '@aurapay/shared';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { nowIso } from '../lib/ids.js';
import { createLogger } from '../logger.js';
import { publish } from './realtime.js';
import * as ledger from './ledger.js';
import * as liquidity from './liquidity.js';
import * as wallets from './wallets.js';
import * as receipts from './receipts.js';
import { emit as emitWebhook } from './webhooks.js';
import * as notifications from './notifications.js';
import * as compliance from './compliance.js';
import {
  events,
  feesOf,
  latestPayout,
  recipientOf,
  requireById,
  routeOf,
  syncTransactionProjection,
  update,
  type PaymentRow,
} from './paymentRepo.js';
import { stringify } from '../lib/json.js';

const log = createLogger('payment-flow');

/**
 * The state machine and the double-entry side of a payment.
 *
 * Every state change funnels through `transition()`:
 *   validate against the declared graph → UPDATE the intent → append to the
 *   immutable event log → publish on the scoped realtime channel → queue the
 *   signed webhook → keep the `transactions` projection in step.
 *
 * Money movement is booked as journals named after the payment, so
 * `ledger.verify({ paymentIntentId })` can prove the whole lifecycle balances,
 * and a failure reverses those journals with compensating entries (never an
 * UPDATE of history).
 *
 * Journal sequence for a completed payment (A = the funding asset):
 *   1. deposit        DR treasury custody      CR customer liability      (A: amount seen on chain)
 *   2. commit         DR customer liability    CR custody + fee wallets   (A: totalDebit)
 *   3. accept         DR FX clearing           CR payout liability        (KES: recipient + rail fee)
 *   4. liquidate      CONVERSION A→KES at the quoted rate; the disclosed
 *                     spread lands on REVENUE:FX_SPREAD, adverse drift on
 *                     EXPENSE:FX_SLIPPAGE
 *   5. in flight      DR payout in flight      CR rail float              (KES)
 *   6. delivery       DR payout liability + provider fee expense   CR in flight (KES)
 *   7. network fee    DR gas expense           CR custody-funded gas pool (A)
 */

export type Actor = 'customer' | 'system' | 'watcher' | 'risk' | 'partner' | string;

export function transition(paymentId: string, to: PaymentState, actor: Actor, note?: string, metadata?: unknown): void {
  const db = getDb();
  const row = requireById(paymentId);
  if (row.status === to) return;
  if (!canTransition(row.status, to)) {
    throw new DomainError('CONFLICT', `A payment cannot move from ${row.status} to ${to}.`, {
      current: row.status,
      requested: to,
    });
  }
  db.tx(() => {
    db.run(
      `UPDATE payment_intents SET status = ?, updated_at = ?${to === 'COMPLETED' ? ', completed_at = ?' : ''} WHERE id = ?`,
      [to, nowIso(), ...(to === 'COMPLETED' ? [nowIso()] : []), paymentId],
    );
    db.run(
      `INSERT INTO payment_events (payment_intent_id, from_state, to_state, actor, note, metadata, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [paymentId, row.status, to, actor, note ?? null, metadata === undefined ? null : stringify(metadata), nowIso()],
    );
  });
  const next = requireById(paymentId);
  syncTransactionProjection(next, to);
  if (next.user_id) {
    publish(`user:${next.user_id}`, 'payment', 'payment.state', {
      paymentId,
      reference: next.reference,
      from: row.status,
      state: to,
      displayStatus: displayStatus(to),
      note: note ?? null,
      at: nowIso(),
    });
  }
  publish('admin', 'network', 'payment.state', { paymentId, reference: next.reference, from: row.status, to, actor });
  const event = STATE_TO_WEBHOOK_EVENT[to];
  if (event) emitWebhook(event, publicSummary(next), { paymentIntentId: paymentId, businessId: next.business_id, userId: next.user_id });
  log.info('transition', { payment: next.reference, from: row.status, to, actor });
}

/** Best-effort advance used by watchers/jobs, where a race is normal. */
export function advance(paymentId: string, to: PaymentState, actor: Actor, note?: string): boolean {
  const row = requireById(paymentId);
  if (row.status === to || isTerminal(row.status) || !canTransition(row.status, to)) {
    if (row.status !== to) log.debug('transition not applicable', { payment: row.reference, from: row.status, to, actor });
    return false;
  }
  transition(paymentId, to, actor, note);
  return true;
}

/* ------------------------------------------------------------------ *
 * Processing timeline for the UI
 * ------------------------------------------------------------------ */

export type StepState = 'completed' | 'active' | 'pending' | 'failed';

export interface PaymentStep {
  step: number;
  label: string;
  state: PaymentState;
  status: StepState;
  at: string | null;
  simulated: boolean;
}

/**
 * Which of the six visible stages are done. A step is `completed` only when the
 * state exists in the immutable event log — the UI never marks money movement as
 * finished because an animation reached that point.
 */
export function buildSteps(paymentId: string): PaymentStep[] {
  const row = requireById(paymentId);
  const reached = new Map<string, string>();
  for (const event of events(paymentId)) {
    if (!reached.has(event.to_state)) reached.set(event.to_state, event.created_at);
  }
  const failed = row.status === 'FAILED' || row.status === 'REFUND_PENDING';
  return PAYMENT_STEPS.map((entry) => {
    const at = reached.get(entry.state) ?? null;
    const active = row.status === entry.state;
    const stepDone = at !== null || (entry.step === 1 && (row.status === 'QUOTED' || row.status === 'AWAITING_PAYMENT'));
    return {
      step: entry.step,
      label: entry.label,
      state: entry.state,
      status: stepDone && !active ? 'completed' : active ? 'active' : failed && !stepDone ? 'pending' : 'pending',
      at,
      simulated: config.isSandbox,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Ledger postings
 * ------------------------------------------------------------------ */

export interface Amounts {
  asset: AssetCode;
  network: string;
  rail: string;
  /** KES the recipient receives. */
  deliverable: bigint;
  /** KES the payout partner charges. */
  providerFee: bigint;
  /** Crypto covering the deliverable + rail fee. */
  principal: bigint;
  serviceFee: bigint;
  networkFee: bigint;
  totalDebit: bigint;
  midRateScaled: bigint;
  fxRateScaled: bigint;
}

export function amountsOf(row: PaymentRow): Amounts {
  const route = routeOf(row);
  return {
    asset: row.asset as AssetCode,
    network: row.network,
    rail: row.rail,
    deliverable: BigInt(row.recipient_amount_minor),
    providerFee: BigInt(route.feeMinor ?? '0'),
    principal: BigInt(row.crypto_amount_minor),
    serviceFee: BigInt(row.service_fee_minor),
    networkFee: BigInt(row.network_fee_minor),
    totalDebit: BigInt(row.total_debit_minor),
    midRateScaled: BigInt(row.mid_rate_scaled),
    fxRateScaled: BigInt(row.fx_rate_scaled),
  };
}

export function ownerOf(row: PaymentRow): string {
  if (!row.user_id) {
    throw new DomainError('INTERNAL', 'This payment has no owning account, so it cannot be booked to a ledger.');
  }
  return row.user_id;
}

export function railKey(rail: string): string {
  if (rail.startsWith('MPESA')) return 'MPESA';
  if (rail === 'AIRTEL_MONEY') return 'AIRTEL';
  if (rail === 'PESA_LINK' || rail === 'PESALINK') return 'PESALINK';
  if (rail === 'BANK_TRANSFER') return 'BANK';
  return 'MPESA';
}

/** 1. The deposit reached the required confirmations and is now held for the customer. */
export function bookDeposit(row: PaymentRow, seenMinor: bigint): void {
  const a = amountsOf(row);
  ledger.postJournal({
    group: `${row.id}:deposit`,
    asset: a.asset,
    paymentIntentId: row.id,
    memo: `Deposit confirmed for ${row.reference}`,
    entries: [
      {
        accountCode: ledger.accounts.custody(a.asset, a.network),
        direction: 'DEBIT',
        asset: a.asset,
        amountMinor: seenMinor,
        code: 'TREASURY_CRYPTO_DEBIT',
        memo: 'on-chain deposit held in custody',
      },
      {
        accountCode: ledger.accounts.user(ownerOf(row), a.asset),
        direction: 'CREDIT',
        asset: a.asset,
        amountMinor: seenMinor,
        code: 'USER_CRYPTO_CREDIT',
        memo: row.reference,
      },
    ],
  });
  wallets.credit({ userId: ownerOf(row), asset: a.asset, network: a.network as never, amountMinor: seenMinor });
}

/** 2. The customer's committed balance leaves their liability. */
export function bookCommit(row: PaymentRow): void {
  const a = amountsOf(row);
  const user = ownerOf(row);
  ledger.postJournal({
    group: `${row.id}:commit`,
    asset: a.asset,
    paymentIntentId: row.id,
    memo: `Customer commits ${row.reference}`,
    entries: [
      {
        accountCode: ledger.accounts.user(user, a.asset),
        direction: 'DEBIT',
        asset: a.asset,
        amountMinor: a.totalDebit,
        code: 'USER_CRYPTO_DEBIT',
        memo: `payment ${row.reference}`,
      },
      // The crypto stays in the vault until the desk actually sells it, so the
      // customer's balance is transferred to a *committed* account rather than
      // written out of custody here. Custody is only relieved by the conversion
      // (principal) and the gas sweep (network fee); the service fee is the one
      // piece custody keeps, which is why custody must end up exactly fee-positive.
      {
        accountCode: ledger.accounts.committed(a.asset),
        direction: 'CREDIT',
        asset: a.asset,
        amountMinor: a.totalDebit,
        code: 'COMMITTED_CRYPTO_CREDIT',
        memo: 'committed to the settlement pipeline',
      },
      {
        accountCode: ledger.accounts.committed(a.asset),
        direction: 'DEBIT',
        asset: a.asset,
        amountMinor: a.serviceFee + a.networkFee,
        code: 'COMMITTED_CRYPTO_RELEASE',
        memo: 'fees leave the commitment as soon as they are earned/earmarked',
      },
      {
        accountCode: ledger.accounts.platformRevenue(a.asset),
        direction: 'CREDIT',
        asset: a.asset,
        amountMinor: a.serviceFee,
        code: 'FEE_REVENUE_CREDIT',
        memo: 'platform service fee',
      },
      {
        accountCode: ledger.accounts.gasClearing(a.asset),
        direction: 'CREDIT',
        asset: a.asset,
        amountMinor: a.networkFee,
        code: 'NETWORK_FEE_CREDIT',
        memo: 'network fee collected, awaiting sweep',
      },
    ],
  });
}

/** 3. KES we now owe the recipient and the rail. */
export function bookPayoutLiability(row: PaymentRow): void {
  const a = amountsOf(row);
  ledger.postJournal({
    group: `${row.id}:payout`,
    asset: 'KES',
    paymentIntentId: row.id,
    memo: `Payout liability for ${row.reference}`,
    entries: [
      {
        accountCode: ledger.accounts.fxClearing(),
        direction: 'DEBIT',
        asset: 'KES',
        amountMinor: a.deliverable + a.providerFee,
        code: 'FX_CLEARING_DEBIT',
        memo: 'to be funded by the conversion of the customer crypto',
      },
      {
        accountCode: ledger.accounts.payoutLiability(),
        direction: 'CREDIT',
        asset: 'KES',
        amountMinor: a.deliverable + a.providerFee,
        code: 'PAYOUT_LIABILITY_CREDIT',
        memo: `owed via ${row.rail}`,
      },
    ],
  });
}

/**
 * 4. Liquidation: principal + service fee crypto leaves custody, KES arrives in
 * the rail float, the FX clearing position is settled and the disclosed spread is
 * recognized as income (or adverse drift as slippage).
 */
export function bookConversion(row: PaymentRow, opts: { proceedsMinor?: bigint } = {}): { pnlMinor: bigint } {
  const a = amountsOf(row);
  const owed = a.deliverable + a.providerFee;
  // The service fee is AuraPay's own and is not liquidated on the customer's
  // behalf; only the principal has to become KES to fund the payout.
  const cryptoSold = a.principal;
  const proceeds = opts.proceedsMinor ?? ledger.expectedToMinor(cryptoSold, a.asset, a.midRateScaled, 'KES');
  const spreadBps = Number(feesOf(row).spreadBps ?? 0);
  const { journalId, pnlMinor } = ledger.postConversion({
    group: `${row.id}:conversion`,
    fromAsset: a.asset,
    toAsset: 'KES',
    fromAmountMinor: cryptoSold,
    toEntries: [
      {
        accountCode: ledger.accounts.liquidity(railKey(row.rail)),
        direction: 'DEBIT',
        asset: 'KES',
        amountMinor: proceeds,
        code: 'LIQUIDITY_DEBIT',
        memo: `conversion proceeds for ${row.reference}`,
      },
      {
        accountCode: ledger.accounts.fxClearing(),
        direction: 'CREDIT',
        asset: 'KES',
        amountMinor: owed,
        code: 'FX_CLEARING_CREDIT',
        memo: 'clearing position settled',
      },
    ],
    rateScaled: a.midRateScaled,
    toleranceMinor: conversionTolerance(a, spreadBps),
    paymentIntentId: row.id,
    memo: `Sweep + liquidation for ${row.reference}`,
    creditAccount: ledger.accounts.custody(a.asset, a.network),
  });
  log.info('conversion booked', { payment: row.reference, journalId, pnlMinor: pnlMinor.toString(), proceeds: proceeds.toString() });
  return { pnlMinor };
}

/** Rounding on the quote plus the disclosed spread: the drift we accept without alerting. */
function conversionTolerance(a: Amounts, spreadBps = 0): bigint {
  const expected = ledger.expectedToMinor(a.principal, a.asset, a.midRateScaled, 'KES');
  // Rounding of the quote (±1 KES) plus the disclosed spread, which is booked
  // as margin rather than refused: the tolerance is what "roughly equal" means.
  return 2n + (expected * BigInt(Math.max(0, spreadBps))) / 10_000n;
}

/** 5. Money leaves the float and is in the partner's hands. */
export function bookPayoutInFlight(row: PaymentRow): void {
  const a = amountsOf(row);
  ledger.postJournal({
    group: `${row.id}:inflight`,
    asset: 'KES',
    paymentIntentId: row.id,
    memo: `Payout in flight for ${row.reference}`,
    entries: [
      {
        accountCode: ledger.accounts.payoutInFlight(),
        direction: 'DEBIT',
        asset: 'KES',
        amountMinor: a.deliverable + a.providerFee,
        code: 'PAYOUT_IN_FLIGHT_DEBIT',
        memo: 'submitted to the payout partner',
      },
      {
        accountCode: ledger.accounts.liquidity(railKey(row.rail)),
        direction: 'CREDIT',
        asset: 'KES',
        amountMinor: a.deliverable + a.providerFee,
        code: 'LIQUIDITY_CREDIT',
        memo: 'float drawn down',
      },
    ],
  });
}

/** 6. The partner confirmed delivery: the liability is extinguished. */
export function bookDelivery(row: PaymentRow): void {
  const a = amountsOf(row);
  ledger.postJournal({
    group: `${row.id}:delivery`,
    asset: 'KES',
    paymentIntentId: row.id,
    memo: `Delivery confirmed for ${row.reference}`,
    entries: [
      {
        accountCode: ledger.accounts.payoutLiability(),
        direction: 'DEBIT',
        asset: 'KES',
        amountMinor: a.deliverable,
        code: 'PAYOUT_LIABILITY_DEBIT',
        memo: 'recipient paid',
      },
      {
        accountCode: ledger.accounts.providerFees(),
        direction: 'DEBIT',
        asset: 'KES',
        amountMinor: a.providerFee,
        code: 'PROVIDER_FEE_DEBIT',
        memo: 'rail fee expensed',
      },
      {
        accountCode: ledger.accounts.payoutInFlight(),
        direction: 'CREDIT',
        asset: 'KES',
        amountMinor: a.deliverable + a.providerFee,
        code: 'PAYOUT_IN_FLIGHT_CREDIT',
        memo: 'in-flight cleared',
      },
    ],
  });
}

/**
 * 7. The earmarked network fee is actually spent on the sweep. This is a
 * pass-through: the customer paid it, the chain consumed it, so no platform
 * expense is recognized here — booking one would double-charge them.
 */
export function bookNetworkFee(row: PaymentRow, gasMinor: bigint): void {
  const a = amountsOf(row);
  if (gasMinor <= 0n) return;
  ledger.postJournal({
    group: `${row.id}:gas`,
    asset: a.asset,
    paymentIntentId: row.id,
    memo: `Network fee spent for ${row.reference}`,
    entries: [
      {
        accountCode: ledger.accounts.gasClearing(a.asset),
        direction: 'DEBIT',
        asset: a.asset,
        amountMinor: gasMinor,
        code: 'NETWORK_FEE_CLEAR',
        memo: 'earmark consumed by the sweep',
      },
      {
        accountCode: ledger.accounts.custody(a.asset, a.network),
        direction: 'CREDIT',
        asset: a.asset,
        amountMinor: gasMinor,
        code: 'NETWORK_FEE_CLEAR',
        memo: 'collected fee applied',
      },
    ],
  });
}

/* ------------------------------------------------------------------ *
 * Completion / failure
 * ------------------------------------------------------------------ */

export function confirmPayout(paymentId: string, providerReference: string | null, note = 'payout confirmed by provider'): void {
  const db = getDb();
  const row = requireById(paymentId);
  if (row.status === 'COMPLETED' || row.status === 'PAYOUT_CONFIRMED') return;
  const payout = latestPayout(paymentId);
  if (payout) {
    db.run(
      `UPDATE payouts SET state = 'CONFIRMED', provider_reference = COALESCE(?, provider_reference), confirmed_at = ?, updated_at = ? WHERE id = ?`,
      [providerReference, nowIso(), nowIso(), payout.id],
    );
    if (row.liquidity_reservation_id) {
      const account = liquidity.findAccount(row.rail as never, 'KES');
      if (account) liquidity.settleConsumed(account.id, BigInt(payout.amount_minor));
    }
  }
  transition(paymentId, 'PAYOUT_CONFIRMED', 'system', note);
  bookDelivery(requireById(paymentId));
  complete(paymentId);
}

/**
 * Finish: convert the held balance into a permanent debit, spend the network
 * fee, issue the receipt and notify. Only called from PAYOUT_CONFIRMED.
 */
export function complete(paymentId: string): void {
  const row = requireById(paymentId);
  if (row.status !== 'PAYOUT_CONFIRMED') {
    log.warn('complete refused: not payout-confirmed', { payment: row.reference, status: row.status });
    return;
  }
  const a = amountsOf(row);
  transition(paymentId, 'COMPLETED', 'system', 'recipient delivery confirmed');
  const completed = requireById(paymentId);
  bookNetworkFee(completed, a.networkFee);
  wallets.consumeHold({ userId: ownerOf(completed), asset: a.asset, network: a.network as never, amountMinor: a.totalDebit });

  // A receipt is a document, not a movement of money: if issuing it fails the
  // payment is still complete, but the failure must be loud and retried rather
  // than swallowed, because the user is owed the paperwork.
  let issuedReceiptId: string | null = completed.receipt_id;
  try {
    issuedReceiptId = receipts.issue(paymentId, { email: completed.user_id !== null });
    if (issuedReceiptId !== completed.receipt_id) update(paymentId, { receipt_id: issuedReceiptId });
  } catch (error) {
    log.error('receipt issuance failed, queued for retry', { payment: completed.reference, error: (error as Error).message });
    getDb().run(
      `INSERT INTO job_queue (id, type, payload, status, dedupe_key, run_at, attempts, max_attempts, created_at, updated_at)
       VALUES (?, 'receipt.issue', ?, 'READY', ?, ?, 0, 12, ?, ?)`,
      [`job_${randomUUID().replace(/-/g, '').slice(0, 20)}`, stringify({ paymentId }), `receipt.issue:${paymentId}`, nowIso(), nowIso(), nowIso()],
    );
  }
  const recipient = recipientOf(completed);
  if (completed.user_id) {
    publish(`user:${completed.user_id}`, 'balances', 'balances.updated', { reason: `payment ${completed.reference} completed` });
    notifications.push(completed.user_id, {
      title: 'Payment sent',
      body: `${(Number(a.deliverable) / 100).toLocaleString('en-KE', { style: 'currency', currency: 'KES' })} delivered to ${
        recipient.displayName ?? recipient.phone ?? 'the recipient'
      }. Your receipt is ready.`,
      severity: 'success',
      link: `/app/transactions/${paymentId}`,
      paymentIntentId: paymentId,
    });
  }
  const problems = ledger.verify({ paymentIntentId: paymentId });
  if (problems.length) log.error('ledger did not balance after completion', { payment: completed.reference, problems });
  log.info('payment completed', { payment: completed.reference, receiptId: issuedReceiptId });
}

export type RefundHandler = (
  paymentId: string,
  input: { reasonCode: string; reason: string; mode?: 'AUTO' | 'MANUAL'; actor: string },
) => Promise<{ refundId: string; state: string }>;

let refundHandler: RefundHandler | null = null;

/** Wired at boot so a failure can return money without a module import cycle. */
export function registerRefundHandler(handler: RefundHandler): void {
  refundHandler = handler;
}

export async function failPayment(
  paymentId: string,
  code: string,
  message: string,
  recovery: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  const row = requireById(paymentId);
  if (isTerminal(row.status)) {
    log.debug('failure ignored: already terminal', { payment: row.reference, status: row.status });
    return;
  }
  const payout = latestPayout(paymentId);
  if (payout && payout.state !== 'CONFIRMED') {
    db.run(`UPDATE payouts SET state = 'FAILED', failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?`, [
      code,
      message,
      nowIso(),
      payout.id,
    ]);
  }
  // Undo every posting already made for this payment, then park the state.
  const reversed = ledger.journalGroupsFor(paymentId).length
    ? ledger.compensate(`payment_failed:${code}`, { paymentIntentId: paymentId }, 'system')
    : { journalIds: [], entries: 0 };
  transition(paymentId, 'FAILED', 'system', message, { code, recovery, ...reversed, ...metadata });
  update(paymentId, { failure_code: code, failure_message: message, failure_recovery: recovery });

  const a = amountsOf(row);
  if (row.liquidity_reservation_id) liquidity.release(row.liquidity_reservation_id, `payment ${row.reference} failed`);
  if (reversed.entries > 0) {
    // The deposit credit was reversed by the compensating journal, so the cache
    // is restored by releasing the hold (which returns the amount to available).
    wallets.releaseHold({ userId: ownerOf(row), asset: a.asset, network: a.network as never, amountMinor: a.totalDebit });
  } else {
    wallets.releaseHold({ userId: ownerOf(row), asset: a.asset, network: a.network as never, amountMinor: a.totalDebit });
  }
  if (row.user_id) publish(`user:${row.user_id}`, 'balances', 'balances.updated', { reason: `payment ${row.reference} failed` });
  if (row.user_id) {
    notifications.push(row.user_id, {
      title: 'Payment failed',
      body: message,
      severity: 'critical',
      link: `/app/transactions/${paymentId}`,
      paymentIntentId: paymentId,
      channels: ['in_app', 'email'],
    });
  }

  const depositConfirmed =
    (db.maybeOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM payments WHERE payment_intent_id = ? AND confirmations >= confirmations_required`,
      [paymentId],
    )?.c ?? 0) > 0;
  if (depositConfirmed && refundHandler) {
    try {
      await refundHandler(paymentId, { reasonCode: code, reason: message, mode: 'AUTO', actor: 'system' });
    } catch (error) {
      log.error('automatic refund failed; opened a compliance case for manual reversal', {
        payment: row.reference,
        error: (error as Error).message,
      });
      db.run(
        `INSERT INTO compliance_cases (id, subject_type, subject_id, severity, status, summary, created_at, updated_at)
         VALUES (?, 'payment', ?, 'critical', 'OPEN', ?, ?, ?)`,
        [
          `case_${Date.now().toString(36)}`,
          paymentId,
          `Automatic refund failed for ${row.reference} (${code}). A manual reversal by an operator is required.`,
          nowIso(),
          nowIso(),
        ],
      );
    }
  }
  log.warn('payment failed', { payment: row.reference, code });
}

/** Admin/treasury integrity checks exposed on the payment detail view. */
export function verifyLedger(paymentId: string): Array<{ kind: string; ref: string; detail: string }> {
  return ledger.verify({ paymentIntentId: paymentId });
}

export function ledgerEntriesFor(paymentId: string): ledger.EntryRow[] {
  return ledger.entriesForPayment(paymentId);
}

/** Everything the processing screen, the success screen and the admin detail share. */
export function publicSummary(row: PaymentRow) {
  const snapshot = recipientOf(row);
  const route = routeOf(row);
  const payout = latestPayout(row.id);
  return {
    object: 'payment',
    id: row.id,
    reference: row.reference,
    externalId: row.external_id,
    status: row.status,
    displayStatus: displayStatus(row.status),
    terminal: isTerminal(row.status),
    direction: row.direction,
    kind: row.kind,
    asset: row.asset,
    network: row.network,
    rail: row.rail,
    provider: row.provider,
    recipientCurrency: row.recipient_currency,
    recipientAmountMinor: row.recipient_amount_minor,
    cryptoAmountMinor: row.crypto_amount_minor,
    networkFeeMinor: row.network_fee_minor,
    serviceFeeMinor: row.service_fee_minor,
    totalDebitMinor: row.total_debit_minor,
    fxRateScaled: row.fx_rate_scaled,
    midRateScaled: row.mid_rate_scaled,
    depositAddress: row.deposit_address,
    depositMemo: row.deposit_memo,
    depositExpiresAt: row.deposit_expires_at,
    recipient: {
      name: snapshot.displayName ?? null,
      verified: snapshot.verification?.verified === true,
      handle: snapshot.phone ?? snapshot.till ?? snapshot.paybill ?? null,
    },
    routeId: route.routeId ?? null,
    payout: payout
      ? { id: payout.id, state: payout.state, reference: payout.provider_reference, submittedAt: payout.submitted_at, confirmedAt: payout.confirmed_at }
      : null,
    risk: { score: row.risk_score, level: row.risk_level, decision: row.risk_decision },
    strongConfirmationRequired: row.strong_confirmation === 1,
    failure: row.failure_code ? { code: row.failure_code, message: row.failure_message, recoveryAction: row.failure_recovery } : null,
    receiptId: row.receipt_id,
    mode: row.mode,
    dataOrigin: row.data_origin,
    livemode: row.mode === 'production',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  } as const;
}
