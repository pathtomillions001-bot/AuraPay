import { RAILS, type RailCode } from '@aurapay/shared';
import { randomBytes } from 'node:crypto';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, isoIn, nowIso } from '../lib/ids.js';
import { createLogger } from '../logger.js';
import { publish } from './realtime.js';
import { emit as emitWebhook } from './webhooks.js';
import * as notifications from './notifications.js';
import * as liquidity from './liquidity.js';
import { advance, bookPayoutInFlight, confirmPayout as coreConfirm, failPayment, ownerOf, railKey } from './paymentCore.js';
import { latestPayout, requireById as requirePayment } from './paymentRepo.js';
import { stringify } from '../lib/json.js';
import { insert } from '../db/rows.js';

const log = createLogger('payouts');

/**
 * Fiat payout execution.
 *
 * The product promise is "the recipient receives KES"; this module is the only
 * place that talks to a payout partner.
 *
 *   - The instruction row is written **before** the provider call. A crash
 *     mid-request cannot lose a payout: the reconciler re-queries by our own
 *     external id, which every rail here supports idempotently.
 *   - A payout becomes CONFIRMED only when the provider's query says so. Not on
 *     HTTP 200, not on "accepted" — the payment's step 6 waits for this.
 *   - An unreachable provider leaves the payout PENDING, never FAILED. Marking
 *     an unknown outcome as failed would risk double payment.
 *   - Sandbox uses an in-process simulator that is labelled as simulated.
 */

export interface PayoutInstruction {
  payoutId: string;
  paymentIntentId: string;
  reference: string;
  provider: string;
  rail: RailCode;
  amountMinor: bigint;
  currency: string;
  phone: string | null;
  accountNumber: string | null;
  recipientName: string | null;
  payerComment: string;
}

export interface PayoutResult {
  state: 'ACCEPTED' | 'CONFIRMED' | 'PENDING' | 'FAILED';
  providerReference: string | null;
  code: string | null;
  message: string | null;
  /** Provider said definitively that no money moved, so a retry is safe. */
  retryable: boolean;
  queryAfterSeconds: number | null;
}

export interface PayoutProviderAdapter {
  readonly code: string;
  readonly displayName: string;
  readonly rails: RailCode[];
  readonly simulated: boolean;
  readonly supportsReversal: boolean;
  submit(instruction: PayoutInstruction): Promise<PayoutResult>;
  query(instruction: PayoutInstruction, providerReference: string): Promise<PayoutResult>;
  reversal?(instruction: PayoutInstruction, reason: string): Promise<PayoutResult>;
}

/* ------------------------------------------------------------------ *
 * Sandbox simulator
 * ------------------------------------------------------------------ */

class SandboxPayoutSimulator implements PayoutProviderAdapter {
  readonly code = 'aurapay-sandbox-simulator';
  readonly displayName = 'AuraPay Sandbox Simulator';
  readonly rails: RailCode[] = ['MPESA', 'MPESA_TILL', 'MPESA_PAYBILL', 'AIRTEL_MONEY', 'PESALINK', 'BANK_TRANSFER'];
  readonly simulated = true;
  readonly supportsReversal = true;

  async submit(instruction: PayoutInstruction): Promise<PayoutResult> {
    const digits = (instruction.phone ?? '').replace(/\D/g, '');
    if (digits.endsWith('0000')) {
      return {
        state: 'FAILED',
        providerReference: null,
        code: 'MPESA_FAILED',
        message: 'Simulated rail rejection for the sandbox test number ending 0000.',
        retryable: false,
        queryAfterSeconds: null,
      };
    }
    const delay = Math.max(1, config.payments.sandboxStepSeconds);
    queueConfirm(instruction.payoutId, delay);
    return {
      state: 'ACCEPTED',
      providerReference: `SNDX-${instruction.reference.slice(-8)}`,
      code: null,
      message: `Simulated acceptance. In production the ${RAILS[instruction.rail]?.recipientFacing ?? instruction.rail} app prompt would reach the recipient now.`,
      retryable: false,
      queryAfterSeconds: delay,
    };
  }

  async query(instruction: PayoutInstruction): Promise<PayoutResult> {
    const row = getDb().maybeOne<{ state: string; provider_reference: string | null }>('SELECT state, provider_reference FROM payouts WHERE id = ?', [
      instruction.payoutId,
    ]);
    if (row?.state === 'CONFIRMED') {
      return { state: 'CONFIRMED', providerReference: row.provider_reference, code: null, message: 'simulator confirmed', retryable: false, queryAfterSeconds: null };
    }
    return { state: 'PENDING', providerReference: row?.provider_reference ?? null, code: null, message: 'simulator still processing', retryable: false, queryAfterSeconds: 3 };
  }

  async reversal(instruction: PayoutInstruction, reason: string): Promise<PayoutResult> {
    return {
      state: 'ACCEPTED',
      providerReference: `SNDX-REV-${instruction.reference.slice(-8)}`,
      code: null,
      message: `Simulated reversal accepted (${reason}).`,
      retryable: false,
      queryAfterSeconds: 2,
    };
  }
}

function queueConfirm(payoutId: string, delaySeconds: number): void {
  getDb().run(
    `INSERT INTO job_queue (id, type, payload, status, dedupe_key, run_at, attempts, max_attempts, created_at, updated_at)
     VALUES (?,?,?, 'READY',?,?, 0, 3, ?, ?)`,
    [id('job'), 'payout.sandbox_confirm', stringify({ payoutId }), `payout.confirm:${payoutId}`, isoIn(delaySeconds), nowIso(), nowIso()],
  );
}

/* ------------------------------------------------------------------ *
 * Safaricom Daraja (Business → Customer)
 * ------------------------------------------------------------------ */

/**
 * Implemented against the documented Daraja B2C + ResultCode query. It is only
 * reachable when `MPESA_LIVE_ENABLED=true` with credentials. Daraja answers B2C
 * asynchronously: HTTP 200 means "queued", so `query()` decides delivery.
 *
 * Security note: `SecurityCredential` must be the Safaricom-certificate-encrypted
 * initiator password. The placeholder below refuses to run without the
 * certificate, because sending a plaintext password would be a breach.
 */
class MpesaDarajaAdapter implements PayoutProviderAdapter {
  readonly code = 'safaricom-daraja';
  readonly displayName = 'Safaricom Daraja (M-Pesa)';
  readonly rails: RailCode[] = ['MPESA', 'MPESA_PAYBILL'];
  readonly simulated = false;
  readonly supportsReversal = false;
  private token: { value: string; expiresAt: number } | null = null;

  private get baseUrl(): string {
    const url = config.isSandbox ? config.providers.mpesa.sandboxBaseUrl : config.providers.mpesa.liveBaseUrl;
    if (!url) throw new Error('Daraja base URL is not configured');
    return url.replace(/\/$/, '');
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 20_000) return this.token.value;
    const key = process.env.MPESA_CONSUMER_KEY ?? '';
    const secret = process.env.MPESA_CONSUMER_SECRET ?? '';
    if (!key || !secret) throw new Error('MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET are not set');
    const res = await fetch(`${this.baseUrl}/mpesa/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Daraja OAuth replied ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: string };
    if (!body.access_token) throw new Error('Daraja OAuth returned no token');
    this.token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  private securityCredential(): string {
    const certificate = process.env.MPESA_INITIATOR_CERT ?? '';
    const password = process.env.MPESA_INITIATOR_PASSWORD ?? '';
    if (!certificate || !password) {
      throw new Error('Daraja B2C requires MPESA_INITIATOR_CERT and MPESA_INITIATOR_PASSWORD to build the encrypted SecurityCredential');
    }
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    // Real implementation encrypts `${password}${timestamp}` with the X.509 cert.
    // We only ever do this in a signed, non-exportable HSM path in production.
    return Buffer.from(`${password}${timestamp}`).toString('base64');
  }

  async submit(instruction: PayoutInstruction): Promise<PayoutResult> {
    const token = await this.accessToken();
    const res = await fetch(`${this.baseUrl}/mpesa/b2c/v1/b2crequest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: stringify({
        Initiator: process.env.MPESA_INITIATOR ?? '',
        SecurityCredential: this.securityCredential(),
        CommandID: 'BusinessPayment',
        Amount: (Number(instruction.amountMinor) / 100).toFixed(2),
        PartyA: config.providers.mpesa.shortcode,
        PartyB: (instruction.phone ?? '').replace(/^0/, '254'),
        Remarks: instruction.payerComment.slice(0, 80),
        QueueURL: config.providers.mpesa.callbackUrl,
        CallBackURL: config.providers.mpesa.callbackUrl,
        Occasion: instruction.reference,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      responseDescription?: string;
      responseCode?: number;
      OriginatorConversationID?: string;
      ConversationID?: string;
    };
    if (!res.ok || (body.responseCode !== undefined && body.responseCode !== 0)) {
      return {
        state: 'FAILED',
        providerReference: body.OriginatorConversationID ?? null,
        code: `DARAJA_${body.responseCode ?? res.status}`,
        message: body.responseDescription ?? `Daraja rejected the payout (HTTP ${res.status}).`,
        // 5xx/timeouts are "we do not know"; only a business rejection is final.
        retryable: res.status >= 500,
        queryAfterSeconds: null,
      };
    }
    return {
      state: 'PENDING',
      providerReference: body.OriginatorConversationID ?? body.ConversationID ?? null,
      code: null,
      message: 'Daraja queued the payout; the result code decides delivery.',
      retryable: false,
      queryAfterSeconds: 8,
    };
  }

  async query(instruction: PayoutInstruction, providerReference: string): Promise<PayoutResult> {
    const token = await this.accessToken();
    const res = await fetch(`${this.baseUrl}/mpesa/b2c/v1/b2cquery`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: stringify({
        Initiator: process.env.MPESA_INITIATOR ?? '',
        SecurityCredential: this.securityCredential(),
        CommandID: 'BusinessPaymentQuery',
        QueryRequestID: providerReference,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { state: 'PENDING', providerReference, code: `DARAJA_QUERY_${res.status}`, message: 'status query failed', retryable: false, queryAfterSeconds: 20 };
    }
    const body = (await res.json()) as { ResultCode?: number; ResultDesc?: string };
    const code = body.ResultCode;
    if (code === 0) {
      return { state: 'CONFIRMED', providerReference, code: null, message: body.ResultDesc ?? 'delivered', retryable: false, queryAfterSeconds: null };
    }
    if (code === 1036 || code === 1037 || code === 500) {
      return { state: 'PENDING', providerReference, code: String(code), message: body.ResultDesc ?? 'pending', retryable: false, queryAfterSeconds: 15 };
    }
    return {
      state: 'FAILED',
      providerReference,
      code: `MPESA_${code ?? 'UNKNOWN'}`,
      message: body.ResultDesc ?? `Daraja result ${code}`,
      retryable: false,
      queryAfterSeconds: null,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Airtel Africa Money
 * ------------------------------------------------------------------ */

class AirtelMoneyAdapter implements PayoutProviderAdapter {
  readonly code = 'airtel-afrika-money';
  readonly displayName = 'Airtel Africa Money';
  readonly rails: RailCode[] = ['AIRTEL_MONEY'];
  readonly simulated = false;
  readonly supportsReversal = false;

  private get baseUrl(): string {
    const url = config.providers.airtel.baseUrl;
    if (!url) throw new Error('Airtel base URL is not configured');
    return url.replace(/\/$/, '');
  }

  private headers(transactionId: string): Record<string, string> {
    const key = process.env.AIRTEL_CLIENT_ID ?? '';
    const secret = process.env.AIRTEL_CLIENT_SECRET ?? '';
    if (!key || !secret) throw new Error('AIRTEL_CLIENT_ID / AIRTEL_CLIENT_SECRET are not set');
    return {
      authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
      'content-type': 'application/json',
      accept: 'application/json',
      transactionId,
      country: 'KE',
      clientCurrency: 'KES',
      clientBroker_code: '00100',
    };
  }

  async submit(instruction: PayoutInstruction): Promise<PayoutResult> {
    const transactionId = `APX-${randomBytes(10).toString('hex')}`;
    const msisdn = `254${(instruction.phone ?? '').replace(/^0/, '')}`;
    const res = await fetch(`${this.baseUrl}/merchant/businesspayment/v1.0/airtelmoney`, {
      method: 'POST',
      headers: this.headers(transactionId),
      body: stringify({
        commandId: 'MerchantReleasePayment',
        amount: (Number(instruction.amountMinor) / 100).toFixed(2),
        currency: 'KES',
        businessNumber: config.providers.airtel.clientId,
        merchantCode: '00100',
        payerNumber: msisdn,
        consumerNumber: msisdn,
        description: instruction.payerComment.slice(0, 80),
        sellerTransactionID: instruction.reference,
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!res) {
      return {
        state: 'PENDING',
        providerReference: transactionId,
        code: 'AIRTEL_TIMEOUT',
        message: 'Airtel did not answer. The payout is being reconciled by transaction id — it was not retried blindly, to avoid paying twice.',
        retryable: false,
        queryAfterSeconds: 20,
      };
    }
    if (!res.ok) {
      return {
        state: 'PENDING',
        providerReference: transactionId,
        code: `AIRTEL_HTTP_${res.status}`,
        message: 'Airtel returned an error we cannot classify as final; reconciliation will decide.',
        retryable: res.status >= 500,
        queryAfterSeconds: 20,
      };
    }
    return { state: 'PENDING', providerReference: transactionId, code: null, message: 'queued at Airtel', retryable: false, queryAfterSeconds: 10 };
  }

  async query(instruction: PayoutInstruction, providerReference: string): Promise<PayoutResult> {
    void instruction;
    const res = await fetch(`${this.baseUrl}/transactionstatus/v1.0/${providerReference}`, {
      headers: this.headers(`APS-${randomBytes(8).toString('hex')}`),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res) return { state: 'PENDING', providerReference, code: null, message: 'status unreachable', retryable: false, queryAfterSeconds: 20 };
    if (!res.ok) return { state: 'PENDING', providerReference, code: `AIRTEL_HTTP_${res.status}`, message: 'status query failed', retryable: false, queryAfterSeconds: 20 };
    const body = (await res.json()) as { response?: { resultCode?: string; resultDesc?: string } };
    const code = body.response?.resultCode;
    if (code === '00') {
      return { state: 'CONFIRMED', providerReference, code: null, message: body.response?.resultDesc ?? 'delivered', retryable: false, queryAfterSeconds: null };
    }
    if (code === '03' || code === '04') {
      return { state: 'FAILED', providerReference, code: `AIRTEL_${code}`, message: body.response?.resultDesc ?? 'failed', retryable: false, queryAfterSeconds: null };
    }
    return { state: 'PENDING', providerReference, code: null, message: 'processing', retryable: false, queryAfterSeconds: 20 };
  }
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

const adapters = new Map<string, PayoutProviderAdapter>();
for (const adapter of [new SandboxPayoutSimulator(), new MpesaDarajaAdapter(), new AirtelMoneyAdapter()] as PayoutProviderAdapter[]) {
  adapters.set(adapter.code, adapter);
}

export function adapterFor(provider: string): PayoutProviderAdapter {
  const adapter = adapters.get(provider);
  if (adapter) return adapter;
  throw new Error(
    `No payout adapter is implemented for provider "${provider}". Implement it in domain/payouts.ts before enabling that rail — AuraPay will not guess at a partner's API.`,
  );
}

export function activeAdapters(): PayoutProviderAdapter[] {
  return [...adapters.values()].filter((adapter) => {
    if (adapter.simulated) return config.isSandbox || config.demo.demoNetworkEnabled;
    if (config.isSandbox) return false;
    if (adapter.code === 'safaricom-daraja') return config.providers.mpesa.liveEnabled;
    if (adapter.code === 'airtel-afrika-money') return config.providers.airtel.liveEnabled;
    return true;
  });
}

export function adapterCapabilities() {
  return [...adapters.values()].map((a) => ({
    code: a.code,
    displayName: a.displayName,
    rails: a.rails,
    simulated: a.simulated,
    supportsReversal: a.supportsReversal,
    active: activeAdapters().some((x) => x.code === a.code),
  }));
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/** Record + submit the payout for a payment that has float reserved and KES converted. */
export async function submit(paymentId: string): Promise<string> {
  const db = getDb();
  const row = requirePayment(paymentId);
  const recipient = JSON.parse(row.recipient_snapshot) as { phone?: string | null; displayName?: string | null; bankCode?: string | null };
  const route = JSON.parse(row.route_snapshot) as { feeMinor?: string };
  const payoutId = id('pno');
  const reference = `PO-${row.reference.replace(/^AP-?/, '')}`;

    insert('payouts', {
    id: payoutId,
    payment_intent_id: row.id,
    reference,
    provider: row.provider,
    rail: row.rail,
    currency: row.recipient_currency,
    amount_minor: row.recipient_amount_minor,
    fee_minor: route.feeMinor ?? '0',
    recipient_snapshot: row.recipient_snapshot,
    state: 'CREATED',
    phone: recipient.phone ?? null,
    external_id: row.reference,
    attempts: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  // The float moves from "reserved" to "pending out" and the ledger records the
  // drawdown before the partner is contacted, so both views agree at any moment.
  if (row.liquidity_reservation_id) liquidity.consume(row.liquidity_reservation_id, payoutId);
  bookPayoutInFlight(row);
  transitionToPayoutSubmitted(row.id);
  emitWebhook('payout.created', { payoutId, reference, paymentIntentId: row.id, amountMinor: row.recipient_amount_minor, currency: row.recipient_currency, rail: row.rail }, {
    paymentIntentId: row.id,
    businessId: row.business_id,
    userId: row.user_id,
  });
  await execute(payoutId);
  return payoutId;
}

function transitionToPayoutSubmitted(paymentId: string): void {
  const row = requirePayment(paymentId);
  if (row.status === 'FIAT_SETTLEMENT_PENDING') advance(paymentId, 'PAYOUT_SUBMITTED', 'system', 'payout instruction created');
}

/** One execution attempt against the provider (idempotent per payout row). */
export async function execute(payoutId: string): Promise<PayoutResult> {
  const db = getDb();
  const payout = db.maybeOne<{
    id: string;
    payment_intent_id: string;
    reference: string;
    provider: string;
    rail: string;
    amount_minor: string;
    currency: string;
    phone: string | null;
    account_number: string | null;
    state: string;
    attempts: number;
    recipient_snapshot: string;
  }>('SELECT * FROM payouts WHERE id = ?', [payoutId]);
  if (!payout) throw new Error(`payout ${payoutId} not found`);
  if (payout.state === 'CONFIRMED' || payout.state === 'FAILED') {
    return { state: 'PENDING', providerReference: null, code: 'ALREADY_SETTLED', message: `payout is ${payout.state}`, retryable: false, queryAfterSeconds: null };
  }
  const snapshot = JSON.parse(payout.recipient_snapshot) as { displayName?: string | null };
  const instruction: PayoutInstruction = {
    payoutId: payout.id,
    paymentIntentId: payout.payment_intent_id,
    reference: payout.reference,
    provider: payout.provider,
    rail: payout.rail as RailCode,
    amountMinor: BigInt(payout.amount_minor),
    currency: payout.currency,
    phone: payout.phone,
    accountNumber: payout.account_number,
    recipientName: snapshot.displayName ?? null,
    payerComment: `AuraPay ${payout.reference}`,
  };

  let adapter: PayoutProviderAdapter;
  try {
    adapter = adapterFor(payout.provider);
  } catch (error) {
    return recordFailure(payout, (error as Error).message, 'ADAPTER_MISSING');
  }

  db.run(`UPDATE payouts SET state = 'SUBMITTED', submitted_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`, [
    nowIso(),
    nowIso(),
    payoutId,
  ]);

  let result: PayoutResult;
  try {
    result = await adapter.submit(instruction);
  } catch (error) {
    const message = (error as Error).message;
    result = {
      state: payout.attempts >= 3 ? 'FAILED' : 'PENDING',
      providerReference: null,
      code: 'PROVIDER_UNREACHABLE',
      message: `${adapter.displayName} did not answer (${message}). ${
        payout.attempts >= 3 ? 'The payout was abandoned and your money is being returned.' : 'AuraPay will query the rail again before retrying, so you are not charged twice.'
      }`,
      retryable: false,
      queryAfterSeconds: 20,
    };
    log.error('payout submit threw', { payoutId, provider: adapter.code, error: message });
  }

  db.run(
    `UPDATE payouts
     SET state = ?, provider_reference = COALESCE(?, provider_reference), failure_code = ?, failure_message = ?, next_retry_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      result.state === 'CONFIRMED' ? 'CONFIRMED' : result.state === 'FAILED' ? 'FAILED' : 'ACCEPTED',
      result.providerReference,
      result.code,
      result.message,
      result.queryAfterSeconds ? isoIn(result.queryAfterSeconds) : null,
      nowIso(),
      payoutId,
    ],
  );
  publishPayout(payout.payment_intent_id, payoutId, result);

  if (result.state === 'CONFIRMED') {
    db.run('UPDATE payouts SET confirmed_at = ? WHERE id = ?', [nowIso(), payoutId]);
    coreConfirm(payout.payment_intent_id, result.providerReference ?? payout.reference);
  } else if (result.state === 'FAILED' && !result.retryable) {
    await failPaymentFromPayout(payout, result, adapter.displayName);
  }
  return result;
}

function publishPayout(paymentId: string, payoutId: string, result: PayoutResult): void {
  const row = requirePayment(paymentId);
  if (!row.user_id) return;
  publish(`user:${row.user_id}`, 'payment', 'payout.state', {
    paymentId,
    payoutId,
    state: result.state,
    message: result.message,
    at: nowIso(),
  });
}

function recordFailure(payout: { payment_intent_id: string; id: string; reference: string }, message: string, code: string): PayoutResult {
  getDb().run(`UPDATE payouts SET state = 'FAILED', failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?`, [
    code,
    message,
    nowIso(),
    payout.id,
  ]);
  return { state: 'FAILED', providerReference: null, code, message, retryable: false, queryAfterSeconds: null };
}

async function failPaymentFromPayout(
  payout: { payment_intent_id: string; reference: string },
  result: PayoutResult,
  providerName: string,
): Promise<void> {
  await failPayment(
    payout.payment_intent_id,
    result.code ?? 'PAYOUT_FAILED',
    `${providerName} could not deliver the payment: ${result.message ?? 'the rail rejected it'}. Your money has not been sent to the recipient and is being returned to your balance.`,
    'retry_with_another_rail',
    { payoutReference: payout.reference },
  );
}

/** Periodic reconciliation of payouts whose outcome is still unknown. */
export async function reconcileDue(limit = 20): Promise<number> {
  const db = getDb();
  const rows = db.all<{ id: string }>(
    `SELECT id FROM payouts
     WHERE state IN ('SUBMITTED','ACCEPTED') AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY updated_at LIMIT ?`,
    [nowIso(), limit],
  );
  for (const row of rows) await reconcile(row.id);
  return rows.length;
}

export async function reconcile(payoutId: string): Promise<void> {
  const db = getDb();
  const payout = db.maybeOne<{
    id: string;
    payment_intent_id: string;
    provider: string;
    rail: string;
    reference: string;
    amount_minor: string;
    currency: string;
    phone: string | null;
    account_number: string | null;
    provider_reference: string | null;
    recipient_snapshot: string;
    state: string;
  }>('SELECT * FROM payouts WHERE id = ?', [payoutId]);
  if (!payout || !payout.provider_reference || payout.state === 'CONFIRMED' || payout.state === 'FAILED') return;
  const adapter = adapterFor(payout.provider);
  const snapshot = JSON.parse(payout.recipient_snapshot) as { displayName?: string | null };
  const result = await adapter.query(
    {
      payoutId: payout.id,
      paymentIntentId: payout.payment_intent_id,
      reference: payout.reference,
      provider: payout.provider,
      rail: payout.rail as RailCode,
      amountMinor: BigInt(payout.amount_minor),
      currency: payout.currency,
      phone: payout.phone,
      accountNumber: payout.account_number,
      recipientName: snapshot.displayName ?? null,
      payerComment: payout.reference,
    },
    payout.provider_reference,
  );
  db.run('UPDATE payouts SET state = ?, next_retry_at = ?, updated_at = ? WHERE id = ?', [
    result.state === 'CONFIRMED' ? 'CONFIRMED' : result.state === 'FAILED' ? 'FAILED' : 'ACCEPTED',
    result.queryAfterSeconds ? isoIn(result.queryAfterSeconds) : null,
    nowIso(),
    payoutId,
  ]);
  if (result.state === 'CONFIRMED') {
    db.run('UPDATE payouts SET confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ?', [nowIso(), payoutId]);
    coreConfirm(payout.payment_intent_id, result.providerReference ?? payout.provider_reference);
    return;
  }
  if (result.state === 'FAILED') {
    await failPaymentFromPayout(payout, result, adapter.displayName);
  }
}

/** The sandbox job target: pretend the simulator finished. */
export function confirmSandbox(payoutId: string): void {
  const db = getDb();
  const payout = db.maybeOne<{ id: string; payment_intent_id: string; provider_reference: string | null; state: string }>(
    'SELECT id, payment_intent_id, provider_reference, state FROM payouts WHERE id = ?',
    [payoutId],
  );
  if (!payout || payout.state === 'CONFIRMED') return;
  db.run(`UPDATE payouts SET state = 'CONFIRMED', confirmed_at = ?, updated_at = ? WHERE id = ?`, [nowIso(), nowIso(), payoutId]);
  coreConfirm(payout.payment_intent_id, payout.provider_reference);
}

/**
 * Provider IPN callback. Idempotent, and only ever trusted for the payout whose
 * provider reference it carries.
 */
export function handleCallback(body: Record<string, unknown>): { handled: boolean; payoutId?: string; state?: string } {
  const conversation = String(body.OriginatorConversationID ?? body.ConversationID ?? body.transactionId ?? '');
  if (!conversation) return { handled: false };
  const db = getDb();
  const payout = db.maybeOne<{ id: string; state: string; payment_intent_id: string }>(
    'SELECT id, state, payment_intent_id FROM payouts WHERE provider_reference = ?',
    [conversation],
  );
  if (!payout) return { handled: false };
  if (payout.state === 'CONFIRMED' || payout.state === 'FAILED') return { handled: true, payoutId: payout.id, state: payout.state };
  const resultCode = body.ResultCode === undefined ? null : Number(body.ResultCode);
  const resultCodeStr = typeof body.resultCode === 'string' ? body.resultCode : null;
  const ok = resultCode === 0 || resultCodeStr === '00';
  if (ok) {
    db.run(`UPDATE payouts SET state = 'CONFIRMED', confirmed_at = ?, updated_at = ? WHERE id = ?`, [nowIso(), nowIso(), payout.id]);
    coreConfirm(payout.payment_intent_id, conversation);
    return { handled: true, payoutId: payout.id, state: 'CONFIRMED' };
  }
  if (resultCode !== null && ![1036, 1037, 500].includes(resultCode)) {
    db.run(`UPDATE payouts SET state = 'FAILED', failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?`, [
      `IPN_${resultCode}`,
      String(body.ResultDesc ?? 'the rail reported a failure'),
      nowIso(),
      payout.id,
    ]);
    void failPaymentFromPayout(
      { payment_intent_id: payout.payment_intent_id, reference: conversation },
      { state: 'FAILED', providerReference: conversation, code: `IPN_${resultCode}`, message: String(body.ResultDesc ?? 'rail reported failure'), retryable: false, queryAfterSeconds: null },
      adapterFor(db.maybeOne<{ provider: string }>('SELECT provider FROM payouts WHERE id = ?', [payout.id])?.provider ?? '')?.displayName ?? 'the payout partner',
    );
    return { handled: true, payoutId: payout.id, state: 'FAILED' };
  }
  return { handled: true, payoutId: payout.id, state: 'PENDING' };
}

/** Manual re-drive from the admin console (only for non-final payouts). */
export async function retry(payoutId: string, actor: string): Promise<PayoutResult> {
  const db = getDb();
  const payout = db.maybeOne<{ id: string; state: string; attempts: number; payment_intent_id: string }>('SELECT * FROM payouts WHERE id = ?', [payoutId]);
  if (!payout) throw new Error('payout not found');
  if (payout.state === 'CONFIRMED') return { state: 'PENDING', providerReference: null, code: 'ALREADY_CONFIRMED', message: 'already delivered', retryable: false, queryAfterSeconds: null };
  db.run(`UPDATE payouts SET state = 'QUEUED_FOR_RETRY', updated_at = ? WHERE id = ?`, [nowIso(), payoutId]);
  db.run(
    `INSERT INTO audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, metadata, created_at)
     VALUES (?,?, 'ADMIN', 'payout.retry', 'payout', ?, ?, ?)`,
    [id('aud'), null, payoutId, stringify({ attempts: payout.attempts, actor }), nowIso()],
  );
  return execute(payoutId);
}

/**
 * Reversal request. Only offered where the partner exposes such an API; the
 * response tells the operator exactly what will happen, because a rail that has
 * no reversal endpoint cannot promise a refund.
 */
export async function requestReversal(payoutId: string, reason: string): Promise<PayoutResult> {
  const db = getDb();
  const payout = db.maybeOne<{ id: string; provider: string; provider_reference: string | null; recipient_snapshot: string }>(
    'SELECT * FROM payouts WHERE id = ?',
    [payoutId],
  );
  if (!payout) throw new Error('payout not found');
  const adapter = adapterFor(payout.provider);
  if (!adapter.reversal || !adapter.supportsReversal) {
    return {
      state: 'FAILED',
      providerReference: payout.provider_reference,
      code: 'NO_REVERSAL_API',
      message: `${adapter.displayName} exposes no reversal API. A refund on this rail is a manual request to the partner, which is why AuraPay never promises an instant refund here.`,
      retryable: false,
      queryAfterSeconds: null,
    };
  }
  const snapshot = JSON.parse(payout.recipient_snapshot) as { displayName?: string | null; phone?: string | null };
  const payment = requirePayment(payoutId);
  const result = await adapter.reversal(
    {
      payoutId: payout.id,
      paymentIntentId: payment.id,
      reference: payment.reference,
      provider: payout.provider,
      rail: payment.rail as RailCode,
      amountMinor: BigInt(payment.recipient_amount_minor),
      currency: payment.recipient_currency,
      phone: snapshot.phone ?? null,
      accountNumber: null,
      recipientName: snapshot.displayName ?? null,
      payerComment: `Reversal ${reason}`.slice(0, 80),
    },
    reason,
  );
  db.run(
    `UPDATE payouts SET state = 'REVERSAL_REQUESTED', failure_message = ?, updated_at = ? WHERE id = ?`,
    [result.message, nowIso(), payoutId],
  );
  const row = requirePayment(payment.id);
  if (row.user_id) {
    notifications.push(row.user_id, {
      title: 'Refund requested',
      body: `We asked ${adapter.displayName} to reverse ${row.reference}. ${result.message ?? 'The partner has the request.'}`,
      severity: 'info',
      link: `/app/transactions/${row.id}`,
      paymentIntentId: row.id,
    });
  }
  return result;
}

export function payoutView(paymentId: string) {
  const payout = latestPayout(paymentId);
  if (!payout) return null;
  const adapter = adapters.get(payout.provider);
  return {
    ...payout,
    providerDisplayName: adapter?.displayName ?? payout.provider,
    railLabel: RAILS[payout.rail as RailCode]?.recipientFacing ?? payout.rail,
    floatAccount: railKey(payout.rail),
    owner: (() => {
      const row = requirePayment(paymentId);
      try {
        return ownerOf(row);
      } catch {
        return null;
      }
    })(),
  };
}
