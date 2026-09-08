import {
  DomainError,
  RAILS,
  formatKes,
  isPayableAsset,
  stateProgress,
  displayStatus,
  isLive,
  isTerminal,
  type AssetCode,
  type NetworkCode,
  type PayableAsset,
  type PaymentState,
  type RailCode,
  type RecipientKind,
} from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, nowIso, reference as makeReference, isoIn } from '../lib/ids.js';
import { createLogger } from '../logger.js';
import * as idempotency from '../lib/idempotency.js';
import * as quotes from './quotes.js';
import * as compliance from './compliance.js';
import * as liquidity from './liquidity.js';
import * as wallets from './wallets.js';
import * as recipients from './recipients.js';
import * as paymentsCore from './paymentCore.js';
import * as payouts from './payouts.js';
import * as notifications from './notifications.js';
import { blockchain } from './blockchain.js';
import { publish } from './realtime.js';
import { emit as emitWebhook } from './webhooks.js';
import * as paymentRepo from './paymentRepo.js';
import { feesOf, recipientOf, routeOf, updateDeposit } from './paymentRepo.js';
import * as receipts from './receipts.js';
import { insert } from '../db/rows.js';
import { stringify } from '../lib/json.js';

const log = createLogger('payments');

/**
 * Payment orchestration.
 *
 * This module owns *sequencing* only: quote → hold → intent → deposit → risk →
 * conversion → liquidity → payout → receipt. It contains no blockchain logic
 * (that is `blockchain.ts` behind `BlockchainProvider`), no partner logic
 * (`payouts.ts`), no accounting (`ledger.ts`) and no rate math (`fx.ts`/
 * `quotes.ts`). Nothing here hard-codes Kenya either: the rail, currency and
 * provider all come from the routing plan attached to the quote.
 *
 * Two rules are structural:
 *   1. A state is only advanced by evidence — a confirmation count from the
 *      chain provider, a result code from the payout partner, a decision from the
 *      risk engine. There is no timer that "assumes" progress.
 *   2. Every money movement is a ledger journal booked in the same transaction
 *      as the cache change that mirrors it, so the two can never diverge.
 */

/** Which payout-float account each rail draws on (one float per corridor). */
export function floatRail(rail: RailCode): RailCode {
  if (rail === 'MPESA_TILL' || rail === 'MPESA_PAYBILL') return 'MPESA';
  return rail;
}

export interface CreatePaymentInput {
  userId: string;
  quoteId: string;
  recipientId?: string | null;
  /** Inline recipient, used by hosted checkout / payment links. */
  recipient?: {
    kind: RecipientKind;
    displayName?: string | null;
    phone?: string | null;
    till?: string | null;
    paybill?: string | null;
    accountReference?: string | null;
    bankCode?: string | null;
    bankAccount?: string | null;
  };
  externalId?: string | null;
  idempotencyKey?: string | null;
  paymentLinkId?: string | null;
  businessId?: string | null;
  strongConfirmation?: boolean;
  note?: string | null;
  /** Set by the QR/link flow so the merchant's own order id survives. */
  metadata?: Record<string, unknown>;
}

export async function create(input: CreatePaymentInput): Promise<{ payment: ReturnType<typeof paymentsCore.publicSummary>; quote: ReturnType<typeof quotes.toView> | null }> {
  return idempotency
    .run(
      { scope: 'payment.create', key: input.idempotencyKey ?? null, userId: input.userId, body: { quoteId: input.quoteId, externalId: input.externalId ?? null } },
      () => createInner(input),
    )
    .then((result) => result.body);
}

async function createInner(input: CreatePaymentInput): Promise<{ payment: ReturnType<typeof paymentsCore.publicSummary>; quote: ReturnType<typeof quotes.toView> | null }> {
  const db = getDb();
  const user = db.maybeOne<{ id: string; kyc_tier: number; status: string }>('SELECT id, kyc_tier, status FROM users WHERE id = ?', [input.userId]);
  if (!user) throw new DomainError('UNAUTHENTICATED', 'We could not find that account. Sign in again and try.');
  if (user.status === 'SUSPENDED' || user.status === 'BLOCKED') {
    throw new DomainError(
      'FORBIDDEN',
      'Your account is paused for review, so payments are disabled. Support can tell you why and how to fix it.',
    );
  }

  // Consume the quote: this both locks the numbers and proves freshness.
  const quote = quotes.consume(input.quoteId, input.userId);
  const asset = quote.asset as PayableAsset;
  if (!isPayableAsset(asset)) {
    throw new DomainError('VALIDATION_FAILED', 'That asset cannot be used to pay out local currency.');
  }
  const rail = quote.rail;
  const railDef = RAILS[rail];

  const recipient = resolveRecipient(input, quote);
  const amountMinor = quote.totalDebitMinor;

  // --- preconditions that must hold before a deposit address exists --------
  compliance.assertCanMoveMoney(input.userId, quote.recipientAmountMinor);
  if (compliance.requiresStepUp(input.userId, quote.recipientAmountMinor) && !input.strongConfirmation) {
    quotes.release(quote.quoteId, 'step-up required');
    throw new DomainError(
      'RECIPIENT_UNVERIFIED',
      `For payments of ${formatKes(quote.recipientAmountMinor)} or more, confirm the recipient's name to continue.`,
      { strongConfirmationRequired: true, recipientName: recipient.displayName ?? null, verified: recipient.verification?.verified === true },
    );
  }
  compliance.assertStepUp(input.strongConfirmation === true, quote.recipientAmountMinor);

  const hold = wallets.hold({ userId: input.userId, asset, network: quote.network, amountMinor });
  if (!hold.ok) {
    quotes.release(quote.quoteId, 'insufficient funds');
    throw new DomainError(
      'INSUFFICIENT_FUNDS',
      `You need ${formatBalance(amountMinor, asset)} and have ${formatBalance(hold.availableMinor ?? 0n, asset)} available on ${networkLabel(quote.network)}.`,
      { requiredMinor: amountMinor.toString(), availableMinor: (hold.availableMinor ?? 0n).toString(), asset, network: quote.network },
    );
  }

  const paymentId = id('pay');
  const ref = makeReference('AP');
  const now = nowIso();
  const depositWindow = config.payments.depositWindowSeconds;

  db.tx(() => {
    paymentRepo.insertRow('payment_intents', {
      id: paymentId,
      reference: ref,
      external_id: input.externalId ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      user_id: input.userId,
      business_id: input.businessId ?? null,
      payment_link_id: input.paymentLinkId ?? null,
      quote_id: quote.quoteId,
      recipient_id: recipient.id ?? null,
      recipient_snapshot: stringify(recipient),
      direction: 'OUT',
      kind: input.businessId ? 'BILL' : 'SEND',
      status: 'CREATED',
      asset,
      network: quote.network,
      rail,
      provider: quote.route.provider,
      recipient_currency: quote.recipientCurrency,
      recipient_amount_minor: quote.recipientAmountMinor.toString(),
      crypto_amount_minor: quote.cryptoAmountMinor.toString(),
      network_fee_minor: quote.networkFeeMinor.toString(),
      service_fee_minor: quote.serviceFeeMinor.toString(),
      total_debit_minor: quote.totalDebitMinor.toString(),
      fx_rate_scaled: quote.fxRate.toString(),
      mid_rate_scaled: quote.midRate.toString(),
      fee_snapshot: stringify({
        feeBps: quote.feeBps,
        spreadBps: quote.spreadBps,
        platformFeeKesMinor: quote.platformFeeKesMinor.toString(),
        providerSurchargeMinor: quote.providerSurchargeMinor.toString(),
        railSurchargeMinor: quote.railSurchargeMinor.toString(),
        note: input.note ?? null,
      }),
      route_snapshot: stringify(quote.route),
      deposit_expires_at: isoIn(depositWindow),
      risk_score: quote.riskHint.level === 'LOW' ? 0 : 40,
      risk_level: quote.riskHint.level,
      risk_decision: 'PENDING',
      strong_confirmation: input.strongConfirmation ? 1 : 0,
      mode: config.mode,
      data_origin: config.isSandbox ? 'sandbox' : 'live',
      amount_kes_real: Number(quote.recipientAmountMinor) / 100,
      amount_usd_real: Number(quote.totalDebitMinor) / 1_000_000,
      created_at: now,
      updated_at: now,
      expires_at: isoIn(depositWindow),
    });
    paymentRepo.insertEvent({ paymentId, from: null, to: 'CREATED', actor: 'customer', note: `quote ${quote.quoteId}` });
    // Reserve the KES side before asking for crypto: we never accept a deposit we
    // could not settle, and the promise to the recipient exists from the start.
    const reservation = liquidity.reserve({
      paymentIntentId: paymentId,
      rail: floatRail(rail),
      currency: quote.recipientCurrency,
      amountMinor: quote.recipientAmountMinor + quote.route.feeMinor,
      providerFeeBps: quote.route.feeBps,
      providerFixedMinor: Number(quote.route.fixedFeeMinor),
      ttlSeconds: Math.max(depositWindow, 600),
    });
    if (reservation.status === 'UNAVAILABLE') {
      throw new DomainError('INSUFFICIENT_LIQUIDITY', `AuraPay cannot settle ${quote.recipientCurrency} payments on ${railDef?.recipientFacing ?? rail} right now. ${reservation.reason}`);
    }
    if (reservation.status === 'QUEUED') {
      // The float is not there yet. We still take the deposit (the crypto is
      // ours to convert) but the payout is explicitly parked on a treasury
      // top-up — never reported as a success.
      db.run('UPDATE payment_intents SET settlement_state = ?, updated_at = ? WHERE id = ?', [
        'WAITING_FLOAT',
        now,
        paymentId,
      ]);
      paymentRepo.insertEvent({
        paymentId,
        from: 'CREATED',
        to: 'CREATED',
        actor: 'system',
        note: `payout will wait for settlement float: ${reservation.reason}`,
      });
    } else if (reservation.reservationId) {
      db.run('UPDATE payment_intents SET liquidity_reservation_id = ? WHERE id = ?', [reservation.reservationId, paymentId]);
    }
  });

  const row = paymentRepo.requireById(paymentId);
  // The KES liability exists before any crypto moves.
  paymentsCore.bookPayoutLiability(row);

  // Deposit address, derived by the chain provider abstraction.
  let deposit: { address: string; memo?: string | null } | null = null;
  try {
    const provider = blockchain.get(quote.network);
    const derived = await provider.addressFor(paymentId, asset as AssetCode);
    deposit = { address: derived.address, memo: derived.memo ?? null };
    const wallet = wallets.walletFor(input.userId, asset, quote.network);
    if (wallet) {
      db.run(
        `INSERT INTO wallet_addresses (id, wallet_id, payment_intent_id, address, network, purpose, derivation_index, used_count, created_at)
         VALUES (?,?,?,?,?,?,?, 0, ?)`,
        [id('wad'), wallet.id, paymentId, derived.address, quote.network, 'DEPOSIT', derived.index, now],
      );
    }
  } catch (error) {
    log.warn('deposit address derivation failed', { payment: ref, network: quote.network, error: (error as Error).message });
  }
  if (deposit) {
    db.run('UPDATE payment_intents SET deposit_address = ?, deposit_memo = ? WHERE id = ?', [deposit.address, deposit.memo ?? null, paymentId]);
  }
  paymentsCore.transition(paymentId, 'QUOTED', 'system', 'quote consumed and funds held');
  paymentsCore.transition(paymentId, 'AWAITING_PAYMENT', 'system', deposit ? 'send the crypto to continue' : 'no deposit address available');
  paymentRepo.syncTransactionProjection(paymentRepo.requireById(paymentId));

  // Screening + risk run now, but the *decision* only bites once money is in
  // flight: an unconfirmed deposit is not yet a payment.
  void screeningPass(paymentId, quote.network, recipient, deposit?.address ?? null);

  scheduleJobs(paymentId, quote, rail);
  if (input.userId) {
    publish(`user:${input.userId}`, 'payment', 'payment.created', { paymentId, reference: ref, state: 'AWAITING_PAYMENT' });
    publish(`user:${input.userId}`, 'balances', 'balances.updated', { reason: 'funds held for a payment' });
  }
  emitWebhook('payment.created', paymentsCore.publicSummary(paymentRepo.requireById(paymentId)), {
    paymentIntentId: paymentId,
    businessId: input.businessId ?? null,
    userId: input.userId,
  });
  log.info('payment created', { payment: ref, user: input.userId, amount: quote.recipientAmountMinor.toString(), asset, rail });

  return { payment: viewFor(paymentId, input.userId), quote: quotes.toView(quote) };
}

function formatBalance(minor: bigint, asset: PayableAsset): string {
  const decimals = asset === 'BTC' ? 8 : asset === 'ETH' ? 18 : 6;
  const value = Number(minor) / 10 ** decimals;
  return `${value.toFixed(decimals === 8 || decimals === 18 ? 6 : 2).replace(/\.?0+$/, '')} ${asset}`;
}

function networkLabel(network: NetworkCode): string {
  return network.replace(/_/g, ' ');
}

function resolveRecipient(
  input: CreatePaymentInput,
  quote: quotes.Quote,
): recipients.RecipientRecord & { verification?: { verified: boolean; name: string | null; source: string; at: string } } {
  const db = getDb();
  if (input.recipientId) {
    const stored = recipients.byId(input.userId, input.recipientId);
    if (!stored) throw new DomainError('NOT_FOUND', 'That saved recipient no longer exists. Add it again to continue.');
    const verification = recipients.verify(stored);
    return { ...stored, verification };
  }
  const inline = input.recipient;
  if (!inline) throw new DomainError('VALIDATION_FAILED', 'Choose a recipient for this payment.');
  const kind = inline.kind;
  const rail = quote.rail;
  const phone = inline.phone ?? null;
  let business: { name: string } | null = null;
  if (inline.till) business = db.maybeOne<{ name: string }>('SELECT name FROM businesses WHERE till_number = ? LIMIT 1', [inline.till]) ?? null;
  if (!business && inline.paybill) business = db.maybeOne<{ name: string }>('SELECT name FROM businesses WHERE paybill_number = ? LIMIT 1', [inline.paybill]) ?? null;
  const record: recipients.RecipientRecord = {
    id: null as unknown as string,
    kind,
    displayName: inline.displayName ?? business?.name ?? 'Recipient',
    phone,
    till: inline.till ?? null,
    paybill: inline.paybill ?? null,
    accountReference: inline.accountReference ?? null,
    bankCode: inline.bankCode ?? null,
    bankAccount: inline.bankAccount ?? null,
    walletAddress: null,
    network: null,
    country: 'KE',
    rail,
    note: null,
    favourite: false,
    defaultAmountMinor: null,
  };
  return { ...record, verification: { verified: Boolean(business), name: business?.name ?? null, source: business ? 'aurapay_merchant_directory' : 'not_provided', at: nowIso() } };
}

function scheduleJobs(paymentId: string, quote: quotes.Quote, rail: RailCode): void {
  const db = getDb();
  const depositDelay = Math.max(1, config.isSandbox ? 1 : 5);
  db.run(
    `INSERT INTO job_queue (id, type, payload, status, dedupe_key, run_at, attempts, max_attempts, created_at, updated_at)
     VALUES (?,?,?, 'READY',?,?, 0, 200, ?, ?)`,
    [id('job'), 'payment.watch_deposit', stringify({ paymentId }), `payment.watch:${paymentId}`, isoIn(depositDelay), nowIso(), nowIso()],
  );
  db.run(
    `INSERT INTO job_queue (id, type, payload, status, dedupe_key, run_at, attempts, max_attempts, created_at, updated_at)
     VALUES (?,?,?, 'READY',?,?, 0, 3, ?, ?)`,
    [id('job'), 'payment.expire', stringify({ paymentId }), `payment.expire:${paymentId}`, isoIn(config.payments.depositWindowSeconds), nowIso(), nowIso()],
  );
  void rail;
}

/* ------------------------------------------------------------------ *
 * Pipeline progression (driven by the worker, or by a sandbox action)
 * ------------------------------------------------------------------ */

/**
 * Advance a payment as far as the evidence allows. Returns the states reached.
 * Safe to call repeatedly: every step checks the current state first.
 */
export async function drive(paymentId: string, actor = 'worker'): Promise<PaymentState[]> {
  const reached: PaymentState[] = [];
  for (let i = 0; i < 8; i += 1) {
    const before = paymentRepo.requireById(paymentId).status;
    const advanced = await step(paymentId, actor);
    reached.push(...advanced);
    const after = paymentRepo.requireById(paymentId).status;
    if (before === after && advanced.length === 0) break;
  }
  return reached;
}

async function step(paymentId: string, actor: string): Promise<PaymentState[]> {
  const db = getDb();
  const row = paymentRepo.requireById(paymentId);
  switch (row.status) {
    case 'AWAITING_PAYMENT':
    case 'CREATED':
    case 'QUOTED': {
      const deposit = await checkDeposit(row);
      return deposit ? [deposit] : [];
    }
    case 'PAYMENT_DETECTED': {
      const deposit = paymentRepo.depositRow(paymentId);
      if (!deposit) return [];
      if (deposit.confirmations < deposit.confirmations_required) {
        paymentsCore.transition(paymentId, 'BLOCKCHAIN_CONFIRMING', actor, `${deposit.confirmations}/${deposit.confirmations_required} confirmations`);
        return ['BLOCKCHAIN_CONFIRMING'];
      }
      paymentsCore.transition(paymentId, 'BLOCKCHAIN_CONFIRMING', actor, 'finalized');
      return ['BLOCKCHAIN_CONFIRMING'];
    }
    case 'BLOCKCHAIN_CONFIRMING': {
      const deposit = paymentRepo.depositRow(paymentId);
      if (!deposit || deposit.confirmations < deposit.confirmations_required) return [];
      paymentsCore.transition(paymentId, 'RISK_REVIEW', actor, 'deposit final, screening');
      return ['RISK_REVIEW'];
    }
    case 'RISK_REVIEW': {
      const outcome = await riskDecision(row);
      if (outcome.decision === 'BLOCK') return [];
      if (outcome.decision === 'MANUAL_REVIEW') return [];
      paymentsCore.bookDeposit(row, BigInt(paymentRepo.depositRow(paymentId)?.amount_minor ?? '0'));
      paymentsCore.transition(paymentId, 'CONVERSION_PENDING', actor, 'risk cleared, converting');
      return ['CONVERSION_PENDING'];
    }
    case 'CONVERSION_PENDING': {
      const fresh = paymentRepo.requireById(paymentId);
      paymentsCore.bookCommit(fresh);
      paymentsCore.bookConversion(fresh);
      wallets.consumeHold({ userId: paymentsCore.ownerOf(fresh), asset: fresh.asset as PayableAsset, network: fresh.network as NetworkCode, amountMinor: BigInt(fresh.total_debit_minor) });
      const reservation =
        fresh.liquidity_reservation_id !== null
          ? { status: 'RESERVED' as const, reservationId: fresh.liquidity_reservation_id }
          : liquidity.reserve({
              paymentIntentId: fresh.id,
              rail: floatRail(fresh.rail as RailCode),
              currency: fresh.recipient_currency,
              amountMinor: BigInt(fresh.recipient_amount_minor),
            });
      if (reservation.status === 'UNAVAILABLE') {
        await paymentsCore.failPayment(
          paymentId,
          'INSUFFICIENT_LIQUIDATION',
          'AuraPay ran out of settlement float for this payment while it was being processed. Your crypto is being returned to your balance.',
          'retry_later',
        );
        return [];
      }
      if (reservation.status === 'QUEUED') {
        // Still no float: park the payment here with the reason visible, and let
        // the settlement job retry it after a treasury top-up.
        db.run('UPDATE payment_intents SET settlement_state = ?, updated_at = ? WHERE id = ?', ['WAITING_FLOAT', nowIso(), paymentId]);
        paymentRepo.insertEvent({
          paymentId,
          from: 'CONVERSION_PENDING',
          to: 'CONVERSION_PENDING',
          actor: actor,
          note: `payout waiting for settlement float: ${reservation.reason}`,
        });
        return [];
      }
      if ('reservationId' in reservation && reservation.reservationId) {
        db.run(`UPDATE payment_intents SET liquidity_reservation_id = ?, settlement_state = 'FUNDED', updated_at = ? WHERE id = ?`, [
          reservation.reservationId,
          nowIso(),
          paymentId,
        ]);
      }
      if (fresh.status === 'LIQUIDITY_RESERVED') {
        paymentsCore.transition(paymentId, 'LIQUIDITY_RESERVED', actor);
      }
      paymentsCore.advance(paymentId, 'LIQUIDITY_RESERVED', actor, 'KES secured for payout');
      paymentsCore.transition(paymentId, 'FIAT_SETTLEMENT_PENDING', actor, 'payout queued');
      return ['LIQUIDITY_RESERVED', 'FIAT_SETTLEMENT_PENDING'];
    }
    case 'LIQUIDITY_RESERVED': {
      paymentsCore.advance(paymentId, 'LIQUIDITY_RESERVED', actor);
      paymentsCore.transition(paymentId, 'FIAT_SETTLEMENT_PENDING', actor, 'payout queued');
      return ['FIAT_SETTLEMENT_PENDING'];
    }
    case 'FIAT_SETTLEMENT_PENDING': {
      await payouts.submit(paymentId);
      return ['PAYOUT_SUBMITTED'];
    }
    case 'PAYOUT_SUBMITTED': {
      const payout = paymentRepo.latestPayout(paymentId);
      if (payout && payout.state === 'CONFIRMED') {
        paymentsCore.confirmPayout(paymentId, payout.provider_reference, 'provider confirmed delivery');
        return ['COMPLETED'];
      }
      if (payout) await payouts.reconcile(payout.id);
      return [];
    }
    case 'PAYOUT_CONFIRMED':
      paymentsCore.complete(paymentId);
      return ['COMPLETED'];
    default:
      return [];
  }
}

/** Look for the on-chain deposit and record what the provider reports. */
async function checkDeposit(row: paymentRepo.PaymentRow): Promise<PaymentState | null> {
  const db = getDb();
  const existing = paymentRepo.depositRow(row.id);
  if (existing?.tx_hash) {
    // Already matched: keep polling confirmations until they are final.
    try {
      const provider = blockchain.get(row.network as NetworkCode);
      const status = await provider.confirmations(existing.tx_hash);
      updateDeposit(row.id, { confirmations: status.confirmations, status: status.finalized ? 'CONFIRMED' : 'CONFIRMING' });
      if (status.finalized) {
        updateDeposit(row.id, { finalized_at: nowIso(), confirmations_required: status.required });
        paymentsCore.transition(row.id, 'PAYMENT_DETECTED', 'watcher', `finalized at ${status.confirmations} confirmations`);
        return 'PAYMENT_DETECTED';
      }
      paymentsCore.advance(row.id, 'PAYMENT_DETECTED', 'watcher', `${status.confirmations}/${status.required} confirmations`);
      return 'PAYMENT_DETECTED';
    } catch (error) {
      log.warn('confirmation poll failed', { payment: row.reference, error: (error as Error).message });
      return null;
    }
  }
  if (!row.deposit_address) return null;
  let detection;
  try {
    detection = await blockchain.get(row.network as NetworkCode).detectDeposit({
      address: row.deposit_address,
      asset: row.asset as AssetCode,
      // The deposit window expects the all-in amount the user was quoted
      // (principal + platform fee + network fee): one transfer, no surprises.
      expectedMinor: BigInt(row.total_debit_minor),
      sinceIso: row.created_at,
    });
  } catch (error) {
    log.warn('deposit detection failed', { payment: row.reference, error: (error as Error).message });
    return null;
  }
  if (!detection.found || !detection.tx) return null;
  const tx = detection.tx;
  db.tx(() => {
    const required = db.maybeOne<{ confirmations_required: number }>('SELECT confirmations_required FROM networks WHERE code = ?', [row.network])
      ?.confirmations_required ?? 1;
    const paymentRowId = id('pmt');
    insert('payments', {
      id: paymentRowId,
      payment_intent_id: row.id,
      kind: 'CRYPTO_DEPOSIT',
      asset: tx.asset,
      network: row.network,
      status: tx.finalized ? 'CONFIRMED' : 'CONFIRMING',
      amount_minor: tx.amountMinor.toString(),
      expected_minor: row.total_debit_minor,
      tx_hash: tx.hash,
      from_address: tx.from,
      to_address: row.deposit_address,
      confirmations: tx.confirmations,
      confirmations_required: required,
      block_height: tx.blockHeight,
      detected_at: tx.timestamp,
      finalized_at: tx.finalized ? nowIso() : null,
      data_origin: config.isSandbox ? 'sandbox' : 'live',
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    // Claim the chain observation so no second payment can match the same transfer.
    db.run('UPDATE blockchain_transactions SET payment_id = ? WHERE network = ? AND tx_hash = ? AND payment_id IS NULL', [
      paymentRowId,
      row.network,
      tx.hash,
    ]);
    db.run(
      `INSERT OR IGNORE INTO blockchain_transactions
       (id, payment_id, network, tx_hash, from_address, to_address, asset, amount_minor, block_height, confirmations, status, first_seen_at, data_origin, raw)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id('btx'),
        paymentRowId,
        row.network,
        tx.hash,
        tx.from,
        row.deposit_address,
        tx.asset,
        tx.amountMinor.toString(),
        tx.blockHeight,
        tx.confirmations,
        tx.finalized ? 'CONFIRMED' : 'PENDING',
        tx.timestamp,
        config.isSandbox ? 'sandbox' : 'live',
        stringify(tx.raw ?? {}),
      ],
    );
  });
  paymentsCore.transition(row.id, 'PAYMENT_DETECTED', 'watcher', `matched ${tx.hash.slice(0, 10)}…`);
  return 'PAYMENT_DETECTED';
}

/** The decision that can park or stop a payment, with its audit trail. */
async function riskDecision(row: paymentRepo.PaymentRow): Promise<{ decision: string; caseId?: string }> {
  const db = getDb();
  if (row.risk_decision !== 'PENDING' && row.risk_decision !== 'MANUAL_REVIEW') {
    return { decision: row.risk_decision === 'AUTO_APPROVE' || row.risk_decision === 'STEP_UP' ? 'AUTO_APPROVE' : row.risk_decision };
  }
  const recipient = recipientOf(row);
  const outcome = await compliance.assessPaymentRisk({
    userId: row.user_id ?? '',
    paymentIntentId: row.id,
    amountMinor: BigInt(row.recipient_amount_minor),
    asset: row.asset as PayableAsset,
    network: row.network as NetworkCode,
    rail: row.rail as RailCode,
    recipientVerified: recipient.verification?.verified === true,
    recipientName: recipient.displayName ?? 'Recipient',
    recipientPhone: recipient.phone ?? null,
    depositAddress: row.deposit_address,
    priorFailures24h: paymentRepo.failedCount(row.user_id ?? '', '-1 day'),
  });
  db.run('UPDATE payment_intents SET risk_score = ?, risk_level = ?, risk_decision = ?, risk_json = ? WHERE id = ?', [
    outcome.score,
    outcome.level,
    outcome.decision,
    stringify(outcome.signals),
    row.id,
  ]);
  if (row.user_id) {
    publish(`user:${row.user_id}`, 'payment', 'payment.risk', { paymentId: row.id, level: outcome.level, decision: outcome.decision });
  }

  if (outcome.decision === 'BLOCK') {
    await paymentsCore.failPayment(
      row.id,
      'RISK_BLOCKED',
      describeBlock(outcome.signals),
      'contact_support',
      { signals: outcome.signals.map((s) => s.code) },
    );
    return { decision: 'BLOCK' };
  }
  if (outcome.decision === 'MANUAL_REVIEW') {
    const openCase = compliance.openCase({
      kind: 'MANUAL_REVIEW',
      subject: `payment:${row.reference}`,
      riskLevel: outcome.level,
      userId: row.user_id,
      paymentIntentId: row.id,
      businessId: row.business_id,
      note: outcome.signals.map((s) => s.label).join('; '),
    });
    db.run('UPDATE payment_intents SET compliance_case_id = ? WHERE id = ?', [openCase.id, row.id]);
    paymentRepo.insertEvent({
      paymentId: row.id,
      from: row.status,
      to: row.status,
      actor: 'risk',
      note: `parked for manual review (${openCase.reference})`,
    });
    if (row.user_id) {
      notifications.push(row.user_id, {
        title: 'Payment held for review',
        body: 'Our compliance team is checking this payment. Your money is safe and we will update you as soon as it clears.',
        severity: 'warning',
        link: `/app/transactions/${row.id}`,
        paymentIntentId: row.id,
      });
    }
    return { decision: 'MANUAL_REVIEW', caseId: openCase.id };
  }
  if (outcome.decision === 'STEP_UP' && row.strong_confirmation !== 1) {
    await paymentsCore.failPayment(
      row.id,
      'RISK_STEP_UP',
      'This payment needs an extra confirmation that was not completed. Nothing was sent; your balance is back.',
      'retry_with_confirmation',
    );
    return { decision: 'BLOCK' };
  }
  return { decision: 'AUTO_APPROVE' };
}

function describeBlock(signals: Array<{ label: string; blocking: boolean }>): string {
  const blockers = signals.filter((s) => s.blocking);
  const why = blockers.length ? blockers.map((s) => s.label.toLowerCase()).join('; ') : 'the combined risk signals on this payment';
  return `AuraPay stopped this payment before sending money: ${why}. Your crypto has been returned to your balance, and support can explain the decision.`;
}

async function screeningPass(
  paymentId: string,
  network: NetworkCode,
  recipient: { displayName?: string | null; phone?: string | null; bankAccount?: string | null },
  depositAddress: string | null,
): Promise<void> {
  const db = getDb();
  try {
    const screening = await compliance.screenRecipient({
      displayName: recipient.displayName ?? 'Recipient',
      phone: recipient.phone ?? null,
      identifier: recipient.bankAccount ?? null,
    });
    getDb().run(
      `INSERT INTO risk_events (id, user_id, payment_intent_id, rule, score_delta, level, action, detail, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        id('rev'),
        paymentRepo.byId(paymentId)?.user_id ?? null,
        paymentId,
        'recipient_counterparty_screening',
        screening.risk,
        screening.blocked ? 'SEVERE' : screening.risk > 0 ? 'MEDIUM' : 'LOW',
        screening.blocked ? 'BLOCK' : 'LOG',
        stringify({ provider: screening.result.provider, listId: screening.result.listId ?? null, matchedName: screening.result.matchedName ?? null }),
        nowIso(),
      ],
    );
    if (screening.blocked) {
      const row = paymentRepo.byId(paymentId);
      if (row && !isTerminal(row.status)) {
        await paymentsCore.failPayment(paymentId, 'SANCTIONS_HIT', screening.warning ?? 'The recipient details matched a watchlist entry, so the payment was stopped.', 'contact_support');
      }
    }
    if (depositAddress) {
      const wallet = await compliance.screenDepositAddress(depositAddress, network);
      const row = paymentRepo.byId(paymentId);
      db.run(
        `INSERT OR REPLACE INTO wallet_screenings (id, address, network, provider, result, risk_score, exposure, checked_at, data_origin)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          id('wsc'),
          depositAddress,
          network,
          wallet.provider,
          wallet.exposure === 'NONE' ? 'CLEAR' : 'EXPOSURE',
          wallet.riskScore,
          wallet.exposure,
          wallet.checkedAt,
          config.isSandbox ? 'sandbox' : 'live',
        ],
      );
      if (wallet.exposure === 'SEVERE' || wallet.exposure === 'HIGH') {
        if (row && !isTerminal(row.status)) {
          await paymentsCore.failPayment(
            paymentId,
            'WALLET_SCREENING_HIT',
            `The deposit address used for this payment was flagged (${wallet.exposure.toLowerCase()} exposure${wallet.tags.length ? `: ${wallet.tags.slice(0, 2).join(', ')}` : ''}), so the payment was stopped and the funds are being returned.`,
            'contact_support',
          );
        }
      }
    }
  } catch (error) {
    log.warn('screening failed', { paymentId, error: (error as Error).message, stack: (error as Error).stack?.split('\n').slice(0, 6).join(' | ') });
  }
}

/** Release the hold and fail an intent whose deposit window closed. */
export async function expire(paymentId: string, reason = 'deposit window closed'): Promise<void> {
  const db = getDb();
  const row = paymentRepo.requireById(paymentId);
  if (isTerminal(row.status)) return;
  if (row.status !== 'AWAITING_PAYMENT' && row.status !== 'CREATED' && row.status !== 'QUOTED' && row.status !== 'LIQUIDITY_RESERVED') {
    log.debug('expire skipped', { payment: row.reference, status: row.status });
    return;
  }
  if (row.quote_id) quotes.release(row.quote_id, reason);
  await paymentsCore.failPayment(
    paymentId,
    'DEPOSIT_TIMEOUT',
    `We did not receive the ${row.asset} for this payment, so it was closed after the quote window ended. Nothing was sent to the recipient.`,
    'retry_payment',
    { reason },
  );
  db.run(`UPDATE job_queue SET status = 'DEAD', updated_at = ? WHERE type = 'payment.watch_deposit' AND payload LIKE ? AND status IN ('READY','ACTIVE')`, [
    nowIso(),
    `%${paymentId}%`,
  ]);
}

export async function cancel(paymentId: string, userId: string): Promise<void> {
  const row = paymentRepo.requireById(paymentId);
  if (row.user_id !== userId) throw new DomainError('FORBIDDEN', 'You can only cancel your own payments.');
  if (row.status !== 'AWAITING_PAYMENT' && row.status !== 'QUOTED' && row.status !== 'CREATED') {
    throw new DomainError(
      'CONFLICT',
      `This payment is already ${displayStatus(row.status).toLowerCase().replace(/_/g, ' ')}, so it can no longer be cancelled. ${
        isLive(row.status) ? 'We will update you when it finishes.' : ''
      }`,
    );
  }
  await expire(paymentId, 'cancelled by payer');
}

/** Compliance/admin release of a parked payment. */
export async function resumeFromReview(paymentId: string, actor: string): Promise<void> {
  const db = getDb();
  db.run(`UPDATE payment_intents SET risk_decision = 'AUTO_APPROVE' WHERE id = ?`, [paymentId]);
  paymentRepo.insertEvent({ paymentId, from: 'RISK_REVIEW', to: 'RISK_REVIEW', actor, note: 'review cleared, resuming' });
  await drive(paymentId, actor);
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

export function viewFor(paymentId: string, userId: string | null | undefined): ReturnType<typeof paymentsCore.publicSummary> {
  const row = paymentRepo.requireById(paymentId);
  if (userId && row.user_id !== userId) throw new DomainError('FORBIDDEN', 'That payment belongs to a different account.');
  return paymentsCore.publicSummary(row);
}

/** The one object the processing screen, the success screen and the admin detail all render. */
export function view(
  paymentId: string,
  opts: { userId?: string | null; businessId?: string | null; admin?: boolean } = {},
) {
  const db = getDb();
  const row = paymentRepo.requireById(paymentId);
  if (opts.userId && row.user_id !== opts.userId) throw new DomainError('FORBIDDEN', 'That payment belongs to a different account.');
  if (opts.businessId && row.business_id !== opts.businessId) throw new DomainError('FORBIDDEN', 'That payment belongs to a different merchant.');
  const summary = paymentsCore.publicSummary(row);
  const deposit = paymentRepo.depositRow(paymentId);
  const payout = paymentRepo.latestPayout(paymentId);
  const recipient = recipientOf(row);
  const route = routeOf(row);
  const fees = feesOf(row);
  const networkDef = RAILS[row.rail as RailCode];
  return {
    ...summary,
    progress: stateProgress(row.status),
    steps: paymentsCore.buildSteps(paymentId),
    settlement: {
      state: row.settlement_state ?? 'FUNDED',
      waitingForFloat: (row.settlement_state ?? 'FUNDED') === 'WAITING_FLOAT',
      reservationId: row.liquidity_reservation_id,
    },
    recipient: {
      ...recipient,
      handle: recipients.displayHandle(recipient),
      railLabel: networkDef?.recipientFacing ?? row.rail,
    },
    amounts: {
      recipientAmountMinor: row.recipient_amount_minor,
      recipientCurrency: row.recipient_currency,
      cryptoAmountMinor: row.crypto_amount_minor,
      networkFeeMinor: row.network_fee_minor,
      serviceFeeMinor: row.service_fee_minor,
      totalDebitMinor: row.total_debit_minor,
      railFeeMinor: route.feeMinor ?? '0',
      platformFeeKesMinor: fees.platformFeeKesMinor ?? '0',
    },
    rates: {
      appliedRateScaled: row.fx_rate_scaled,
      midRateScaled: row.mid_rate_scaled,
      spreadBps: Number(fees.spreadBps ?? 0),
      feeBps: Number(fees.feeBps ?? 0),
    },
    deposit: deposit
      ? {
          address: row.deposit_address,
          memo: row.deposit_memo,
          expiresAt: row.deposit_expires_at,
          txHash: deposit.tx_hash,
          confirmations: deposit.confirmations,
          confirmationsRequired: deposit.confirmations_required,
          blockHeight: deposit.block_height,
          detectedAt: deposit.detected_at,
          finalizedAt: deposit.finalized_at,
          amountMinor: deposit.amount_minor,
          dataOrigin: deposit.data_origin,
        }
      : { address: row.deposit_address, memo: row.deposit_memo, expiresAt: row.deposit_expires_at },
    payout: payout
      ? {
          id: payout.id,
          state: payout.state,
          rail: payout.rail,
          railLabel: RAILS[payout.rail as RailCode]?.recipientFacing ?? payout.rail,
          provider: payout.provider,
          providerReference: payout.provider_reference,
          phone: payout.phone,
          amountMinor: payout.amount_minor,
          submittedAt: payout.submitted_at,
          confirmedAt: payout.confirmed_at,
          failureCode: payout.failure_code,
          failureMessage: payout.failure_message,
          attempts: payout.attempts,
        }
      : null,
    route: {
      routeId: route.routeId ?? null,
      provider: row.provider,
      providerDisplayName: route.providerDisplayName ?? row.provider,
      considered: route.considered ?? [],
      fallbacks: route.fallbacks ?? [],
      notes: route.notes ?? [],
      refundable: route.refundable ?? networkDef?.refundable ?? false,
      instant: route.instant ?? networkDef?.instant ?? false,
    },
    risk: {
      score: row.risk_score,
      level: row.risk_level,
      decision: row.risk_decision,
      signals: safeParse<Array<{ code: string; label: string; weight: number }>>(row.risk_json, []),
      caseId: row.compliance_case_id,
      caseReference: row.compliance_case_id
        ? db.maybeOne<{ reference: string; status: string }>('SELECT reference, status FROM compliance_cases WHERE id = ?', [row.compliance_case_id])
        : null,
    },
    timeline: paymentRepo.events(paymentId).map((e) => ({
      from: e.from_state,
      to: e.to_state,
      actor: e.actor,
      note: e.note,
      at: e.created_at,
    })),
    ledger: opts.admin
      ? {
          entries: ledgerEntries(paymentId),
          problems: paymentsCore.verifyLedger(paymentId),
        }
      : undefined,
    refund: db
      .all<{ id: string; reference: string; state: string; amount_minor: string; crypto_amount_minor: string; asset: string; destination: string; method: string; created_at: string; completed_at: string | null; note: string | null }>(
        `SELECT id, reference, state, amount_minor, crypto_amount_minor, asset, destination, method, created_at, completed_at, note
         FROM refunds WHERE payment_intent_id = ? ORDER BY created_at`,
        [paymentId],
      )
      .map((r) => ({
        id: r.id,
        reference: r.reference,
        status: r.state,
        amountMinor: r.amount_minor,
        cryptoAmountMinor: r.crypto_amount_minor,
        asset: r.asset,
        destination: r.destination,
        method: r.method,
        requestedAt: r.created_at,
        completedAt: r.completed_at,
        note: r.note,
      })),
    receipt: row.receipt_id ? receipts.get(row.receipt_id)?.payload ?? null : null,
    sandbox: config.isSandbox,
    legalNote: config.isSandbox
      ? 'Sandbox payment: the blockchain activity, provider responses and timings shown here are simulated by AuraPay. No real money moved.'
      : null,
  };
}

function ledgerEntries(paymentId: string) {
  return paymentsCore
    .ledgerEntriesFor(paymentId)
    .map((e) => ({
      id: e.id,
      journal: e.journal_group ?? e.journal_id,
      account: e.account_code,
      direction: e.direction,
      asset: e.asset,
      amountMinor: e.amount_minor,
      code: e.code,
      memo: e.memo,
      at: e.occurred_at,
      adjustment: e.is_adjustment === 1,
    }));
}

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export interface ListFilters {
  userId?: string | null;
  businessId?: string | null;
  status?: PaymentState | null;
  asset?: AssetCode | null;
  rail?: RailCode | null;
  direction?: 'IN' | 'OUT' | null;
  search?: string | null;
  from?: string | null;
  to?: string | null;
  minAmountMinor?: bigint | null;
  limit?: number;
  cursor?: string | null;
  includeSimulated?: boolean;
}

export function list(filters: ListFilters): {
  items: Array<ReturnType<typeof paymentsCore.publicSummary>>;
  nextCursor: string | null;
  total: number;
} {
  const db = getDb();
  const clauses: string[] = ['1=1'];
  const params: (string | number)[] = [];
  if (filters.userId) {
    clauses.push('user_id = ?');
    params.push(filters.userId);
  }
  if (filters.businessId) {
    clauses.push('business_id = ?');
    params.push(filters.businessId);
  }
  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  if (filters.asset) {
    clauses.push('asset = ?');
    params.push(filters.asset);
  }
  if (filters.rail) {
    clauses.push('rail = ?');
    params.push(filters.rail);
  }
  if (filters.direction) {
    clauses.push('direction = ?');
    params.push(filters.direction);
  }
  if (filters.from) {
    clauses.push('created_at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push('created_at <= ?');
    params.push(filters.to);
  }
  if (filters.minAmountMinor && filters.minAmountMinor > 0n) {
    clauses.push('CAST(recipient_amount_minor AS INTEGER) >= ?');
    params.push(filters.minAmountMinor.toString());
  }
  if (filters.search) {
    clauses.push('(reference LIKE ? OR deposit_address LIKE ? OR recipient_snapshot LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }
  if (!filters.includeSimulated) {
    // Sandbox rows are tagged, so a real ledger view never mixes them in.
    clauses.push(config.isSandbox ? '1=1' : "data_origin <> 'sandbox'");
  }
  if (filters.cursor) {
    clauses.push('created_at < ?');
    params.push(filters.cursor);
  }
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
  const rows = db.all<paymentRepo.PaymentRow>(
    `SELECT * FROM payment_intents WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    [...params, limit + 1],
  );
  const page = rows.slice(0, limit);
  const total =
    db.maybeOne<{ c: number }>(`SELECT COUNT(*) AS c FROM payment_intents WHERE ${clauses.join(' AND ')}`, params.slice(0, -1))?.c ?? page.length;
  return {
    items: page.map((row) => paymentsCore.publicSummary(row)),
    nextCursor: rows.length > limit ? (page.at(-1)?.created_at ?? null) : null,
    total,
  };
}

/** Balances + recent activity for the home dashboard, in one round trip. */
export function dashboard(userId: string) {
  return {
    wallets: wallets.balancesFor(userId),
    recent: list({ userId, limit: 6 }).items,
    open: paymentRepo.openCount(userId),
    notifications: notifications.unreadCount(userId),
  };
}
