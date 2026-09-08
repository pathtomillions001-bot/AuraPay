import { formatCrypto, formatDateTime, formatKes, formatRate, shortId, type AssetCode } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { LEGAL_DISCLAIMER } from '../config.js';
import { sha256 } from '../lib/crypto.js';
import { id, isoIn, nowIso } from '../lib/ids.js';
import { feesOf, recipientOf, requireById, update, latestPayout, events } from './paymentRepo.js';
import { emailFor } from './identity.js';
import { stringify } from '../lib/json.js';

/**
 * Receipts.
 *
 * A receipt is a *snapshot*, rendered once from the payment's final data and
 * stored with its SHA-256 so it can be proven unchanged later. The PDF a user
 * downloads is printed from this payload in the browser (print stylesheet), so
 * the document and the API response can never disagree, and no PDF generator
 * stands between a customer and their proof of payment.
 */

export interface ReceiptPayload {
  document: 'aurapay-receipt';
  version: 1;
  receiptId: string;
  reference: string;
  shortReference: string;
  issuedAt: string;
  mode: 'sandbox' | 'production';
  dataOrigin: string;
  status: 'COMPLETED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'FAILED';
  payer: { label: string; email: string | null };
  recipient: {
    name: string | null;
    verified: boolean;
    handle: string;
    railLabel: string;
    bankAccount: string | null;
  };
  amounts: {
    recipientAmountMinor: string;
    recipientCurrency: string;
    recipientAmountFormatted: string;
    cryptoAmountMinor: string;
    cryptoAsset: AssetCode;
    cryptoFormatted: string;
    networkFeeMinor: string;
    platformFeeKesMinor: string;
    railFeeMinor: string;
    railFeeFormatted: string;
    totalDebitMinor: string;
    totalDebitFormatted: string;
    network: string;
  };
  rates: {
    midRateFormatted: string;
    appliedRateFormatted: string;
    spreadBps: number;
    spreadNote: string;
  };
  rail: {
    routeId: string | null;
    provider: string;
    providerDisplayName: string;
    localReference: string | null;
    submittedAt: string | null;
    confirmedAt: string | null;
  };
  blockchain: {
    txHash: string | null;
    confirmations: number;
    confirmationsRequired: number;
    blockHeight: string | null;
    detectedAt: string | null;
    finalizedAt: string | null;
    explorer: string | null;
  };
  timeline: Array<{ state: string; at: string }>;
  refund: {
    id: string;
    status: string;
    amountMinor: string;
    requestedAt: string;
    completedAt: string | null;
    note: string | null;
  } | null;
  legal: string;
  contentSha256: string;
}

export function buildPayload(paymentId: string, forcedReceiptId?: string): ReceiptPayload {
  const db = getDb();
  const row = requireById(paymentId);
  const recipient = recipientOf(row);
  const payout = latestPayout(paymentId);
  const deposit = db.maybeOne<{
    tx_hash: string | null;
    confirmations: number;
    confirmations_required: number;
    block_height: string | null;
    detected_at: string | null;
    finalized_at: string | null;
  }>('SELECT tx_hash, confirmations, confirmations_required, block_height, detected_at, finalized_at FROM payments WHERE payment_intent_id = ? ORDER BY created_at DESC LIMIT 1', [paymentId]);
  const fees = feesOf(row);
  const route = JSON.parse(row.route_snapshot) as { routeId?: string; provider?: string; providerDisplayName?: string };
  const refund = db.maybeOne<{ id: string; state: string; amount_minor: string; created_at: string; completed_at: string | null; note: string | null }>(
    `SELECT id, state, amount_minor, created_at, completed_at, note FROM refunds WHERE payment_intent_id = ? ORDER BY created_at DESC LIMIT 1`,
    [paymentId],
  );
  const asset = row.asset as AssetCode;
  const payer = row.user_id
    ? db.maybeOne<{ full_name: string; email: string }>('SELECT full_name, email FROM users WHERE id = ?', [row.user_id])
    : null;
  const timeline = events(paymentId)
    .map((e) => ({ state: e.to_state, at: e.created_at }))
    .filter((entry, index, all) => all.findIndex((x) => x.state === entry.state) === index);

  const payload: Omit<ReceiptPayload, 'contentSha256'> = {
    document: 'aurapay-receipt',
    version: 1,
    // The id is decided *before* the payload is hashed, so the document a user
    // shares and the row it belongs to always agree.
    receiptId: forcedReceiptId ?? row.receipt_id ?? `pending-${row.id}`,
    reference: row.reference,
    shortReference: shortId(row.reference),
    issuedAt: row.completed_at ?? nowIso(),
    mode: row.mode,
    dataOrigin: row.data_origin,
    status: (row.status === 'COMPLETED' ? 'COMPLETED' : row.status === 'FAILED' ? 'FAILED' : row.status) as ReceiptPayload['status'],
    payer: { label: payer?.full_name ?? 'AuraPay customer', email: payer?.email ?? (row.user_id ? emailFor(row.user_id) : null) },
    recipient: {
      name: recipient.displayName ?? null,
      verified: recipient.verification?.verified === true,
      handle: recipient.phone ?? recipient.till ?? recipient.paybill ?? recipient.bankCode ?? '—',
      railLabel: railLabelFor(row.rail),
      bankAccount: null,
    },
    amounts: {
      recipientAmountMinor: row.recipient_amount_minor,
      recipientCurrency: row.recipient_currency,
      recipientAmountFormatted: formatKes(BigInt(row.recipient_amount_minor)),
      cryptoAmountMinor: row.crypto_amount_minor,
      cryptoAsset: asset,
      cryptoFormatted: formatCrypto(BigInt(row.crypto_amount_minor), asset),
      networkFeeMinor: row.network_fee_minor,
      platformFeeKesMinor: fees.platformFeeKesMinor ?? '0',
      railFeeMinor: row.route_snapshot ? routeFeeMinor(row.route_snapshot) : '0',
      railFeeFormatted: formatKes(BigInt(row.route_snapshot ? routeFeeMinor(row.route_snapshot) : '0')),
      totalDebitMinor: row.total_debit_minor,
      totalDebitFormatted: formatCrypto(BigInt(row.total_debit_minor), asset),
      network: row.network,
    },
    rates: {
      midRateFormatted: formatRate(row.mid_rate_scaled, asset),
      appliedRateFormatted: formatRate(row.fx_rate_scaled, asset),
      spreadBps: Number(fees.spreadBps ?? 0),
      spreadNote:
        Number(fees.spreadBps ?? 0) > 0
          ? `Your rate includes a disclosed ${Number(fees.spreadBps ?? 0) / 100}% conversion spread. There is no hidden markup: recipient amount ÷ crypto debited is the rate you got.`
          : 'You received the mid-market rate. No spread was applied to this payment.',
    },
    rail: {
      routeId: route.routeId ?? null,
      provider: route.provider ?? row.provider,
      providerDisplayName: route.providerDisplayName ?? row.provider,
      localReference: payout?.provider_reference ?? null,
      submittedAt: payout?.submitted_at ?? null,
      confirmedAt: payout?.confirmed_at ?? null,
    },
    blockchain: {
      txHash: deposit?.tx_hash ?? null,
      confirmations: deposit?.confirmations ?? 0,
      confirmationsRequired: deposit?.confirmations_required ?? 0,
      blockHeight: deposit?.block_height ?? null,
      detectedAt: deposit?.detected_at ?? null,
      finalizedAt: deposit?.finalized_at ?? null,
      explorer: deposit?.tx_hash ? explorerFor(row.network, deposit.tx_hash) : null,
    },
    timeline,
    refund: refund
      ? {
          id: refund.id,
          status: refund.state,
          amountMinor: refund.amount_minor,
          requestedAt: refund.created_at,
          completedAt: refund.completed_at,
          note: refund.note,
        }
      : null,
    legal: LEGAL_DISCLAIMER,
  };

  const hash = sha256(stringify(stable(payload)));
  return { ...payload, contentSha256: hash };
}

/**
 * The rail fee in KES *minor* units. This used to return major units (divided by
 * 100) into a field named `railFeeMinor`, which then rounded to Ksh 0 in the
 * rendered receipt — money fields stay in integer minor units all the way to the
 * document.
 */
function routeFeeMinor(snapshot: string): string {
  try {
    const route = JSON.parse(snapshot) as { feeMinor?: string | number };
    const raw = route.feeMinor ?? '0';
    return typeof raw === 'string' ? raw : String(Math.round(raw));
  } catch {
    return '0';
  }
}

/** Tolerant minor-unit parse: a value that reached us as a decimal is rounded,
 * never silently truncated by BigInt() throwing on the way. */
function asMinor(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.round(value));
  return /^\d+$/.test(value) ? BigInt(value) : BigInt(Math.round(Number(value) || 0));
}

/** Key order in JSON.stringify is insertion order; make the payload explicit. */
function stable(input: Omit<ReceiptPayload, 'contentSha256'>): unknown {
  return {
    receiptId: input.receiptId,
    reference: input.reference,
    status: input.status,
    amounts: input.amounts,
    rates: { midRateFormatted: input.rates.midRateFormatted, appliedRateFormatted: input.rates.appliedRateFormatted, spreadBps: input.rates.spreadBps },
    rail: input.rail,
    blockchain: input.blockchain,
    issuedAt: input.issuedAt,
    mode: input.mode,
  };
}

function railLabelFor(rail: string): string {
  const labels: Record<string, string> = {
    MPESA: 'M-Pesa (STK push)',
    MPESA_TILL: 'M-Pesa Buy Goods (Till)',
    MPESA_PAYBILL: 'M-Pesa PayBill',
    AIRTEL_MONEY: 'Airtel Money',
    PESA_LINK: 'PesaLink',
    BANK_TRANSFER: 'Bank transfer',
    CRYPTO_WALLET: 'Crypto wallet',
  };
  return labels[rail] ?? rail;
}

function explorerFor(network: string, hash: string): string | null {
  const map: Record<string, string> = {
    TRON: `https://tronscan.org/#/transaction/${hash}`,
    ETHEREUM: `https://etherscan.io/tx/${hash}`,
    BNB_CHAIN: `https://bscscan.com/tx/${hash}`,
    SOLANA: `https://solscan.io/tx/${hash}`,
    BITCOIN: `https://mempool.space/tx/${hash}`,
  };
  return map[network] ?? null;
}

export function issue(paymentId: string, delivery: { email: boolean }): string | null {
  const db = getDb();
  const row = requireById(paymentId);
  const receiptId = row.receipt_id ?? id('rct');
  const payload = buildPayload(paymentId, receiptId);
  const token = id('shr');
  const content = stringify(payload);
  db.tx(() => {
    if (row.receipt_id) {
      db.run(
        `UPDATE receipts SET payload = ?, content_sha256 = ?, status = 'REISSUED', updated_at = ? WHERE id = ?`,
        [content, payload.contentSha256, nowIso(), row.receipt_id],
      );
    } else {
      db.run(
        `INSERT INTO receipts
         (id, payment_intent_id, reference, payload, content_sha256, mode, data_origin, status, share_token, share_expires_at, delivery, issued_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, ?, ?)`,
        [
          receiptId,
          paymentId,
          row.reference,
          content,
          payload.contentSha256,
          row.mode,
          row.data_origin,
          'ISSUED',
          token,
          isoIn(60 * 60 * 24 * 30),
          stringify({
            inApp: true,
            email: delivery.email ? (db.maybeOne<{ email: string }>('SELECT email FROM users WHERE id = ?', [row.user_id ?? ''])?.email ?? null) : null,
          }),
          nowIso(),
          nowIso(),
        ],
      );
      update(paymentId, { receipt_id: receiptId });
    }
    db.run(`UPDATE transactions SET receipt_id = ? WHERE payment_intent_id = ?`, [receiptId, paymentId]);
  });
  return receiptId;
}

export function get(receiptId: string): { payload: ReceiptPayload; createdAt: string } | null {
  const row = getDb().maybeOne<{ payload: string; issued_at: string }>('SELECT payload, issued_at FROM receipts WHERE id = ?', [receiptId]);
  if (!row) return null;
  return { payload: JSON.parse(row.payload) as ReceiptPayload, createdAt: row.issued_at };
}

export function byPayment(paymentId: string): ReceiptPayload | null {
  const row = getDb().maybeOne<{ receipt_id: string }>('SELECT receipt_id FROM payment_intents WHERE id = ?', [paymentId]);
  return row?.receipt_id ? (get(row.receipt_id)?.payload ?? null) : null;
}

export function byShareToken(token: string): ReceiptPayload | null {
  const db = getDb();
  const row = db.maybeOne<{ id: string; payload: string; share_expires_at: string | null }>(
    'SELECT id, payload, share_expires_at FROM receipts WHERE share_token = ?',
    [token],
  );
  if (!row) return null;
  if (row.share_expires_at && new Date(row.share_expires_at).getTime() < Date.now()) return null;
  db.run('UPDATE receipts SET shared_at = COALESCE(shared_at, ?), share_accessed_at = ? WHERE id = ?', [nowIso(), nowIso(), row.id]);
  return JSON.parse(row.payload) as ReceiptPayload;
}

export function createShareLink(receiptId: string, expiresInSeconds = 60 * 60 * 24 * 7): { url: string; token: string; expiresAt: string } {
  const db = getDb();
  const existing = db.maybeOne<{ share_token: string; share_expires_at: string | null }>('SELECT share_token, share_expires_at FROM receipts WHERE id = ?', [
    receiptId,
  ]);
  if (existing?.share_token && existing.share_expires_at && new Date(existing.share_expires_at).getTime() > Date.now()) {
    return { token: existing.share_token, url: `/share/receipt/${existing.share_token}`, expiresAt: existing.share_expires_at };
  }
  const token = id('shr');
  const expiresAt = isoIn(expiresInSeconds);
  db.run('UPDATE receipts SET share_token = ?, share_expires_at = ?, created_at = created_at WHERE id = ?', [token, expiresAt, receiptId]);
  return { token, url: `/share/receipt/${token}`, expiresAt };
}

export function revokeShare(receiptId: string): void {
  getDb().run('UPDATE receipts SET share_token = NULL, share_expires_at = NULL WHERE id = ?', [receiptId]);
}

export function markDelivered(receiptId: string, channel: 'email' | 'whatsapp' | 'sms'): void {
  const db = getDb();
  const row = db.maybeOne<{ delivery: string | null }>('SELECT delivery FROM receipts WHERE id = ?', [receiptId]);
  const delivery = (row?.delivery ? JSON.parse(row.delivery) : {}) as Record<string, unknown>;
  delivery[channel] = { deliveredAt: nowIso(), simulated: true };
  db.run('UPDATE receipts SET delivery = ? WHERE id = ?', [stringify(delivery), receiptId]);
}

export function verifyIntegrity(receiptId: string): { valid: boolean; stored: string; recomputed: string } {
  const row = getDb().maybeOne<{ payload: string; content_sha256: string }>('SELECT payload, content_sha256 FROM receipts WHERE id = ?', [receiptId]);
  if (!row) return { valid: false, stored: '', recomputed: '' };
  const payload = JSON.parse(row.payload) as ReceiptPayload;
  const recomputed = sha256(stringify(stable({ ...payload, contentSha256: undefined } as unknown as Omit<ReceiptPayload, 'contentSha256'>)));
  return { valid: recomputed === row.content_sha256, stored: row.content_sha256, recomputed };
}

/**
 * Plain-text rendering used by the "Download" button (and by tests). The web
 * app renders the same payload as a printable receipt for PDF output.
 */
/** Accepts a payload or a receipt id, so callers cannot accidentally render `[object Object]`. */
export function asText(input: ReceiptPayload | string): string {
  const payload: ReceiptPayload =
    typeof input === 'string' ? get(input)?.payload ?? byPayment(input) ?? ({ missing: input } as unknown as ReceiptPayload) : input;
  const lines = [
    'AURAPAY — PAYMENT RECEIPT',
    '──────────────────────────',
    `Reference:        ${payload.reference} (${payload.shortReference})`,
    `Status:           ${payload.status}`,
    `Issued:           ${formatDateTime(payload.issuedAt)}`,
    `Environment:      ${(payload.mode ?? 'live').toUpperCase()}${payload.dataOrigin === 'sandbox' ? ' — simulated data' : ''}`,
    '',
    `From:             ${payload.payer.label}${payload.payer.email ? ` <${payload.payer.email}>` : ''}`,
    `To:               ${payload.recipient.name ?? 'Recipient'}${payload.recipient.verified ? ' (verified)' : ' (name not verified)'}`,
    `Destination:      ${payload.recipient.handle} · ${payload.recipient.railLabel}`,
    '',
    `Recipient gets:   ${payload.amounts.recipientAmountFormatted}`,
    `Paid with:        ${payload.amounts.totalDebitFormatted}`,
    `  amount:         ${payload.amounts.cryptoFormatted}`,
    `  network fee:    ${formatCrypto(asMinor(payload.amounts.networkFeeMinor), payload.amounts.cryptoAsset)} (miner/validator fee, not AuraPay revenue)`,
    `  platform fee:   ${formatKes(asMinor(payload.amounts.platformFeeKesMinor))}`,
    `  rail fee:       ${payload.amounts.railFeeFormatted} (charged by the payout partner)`,
    '',
    `Mid-market rate:  ${payload.rates.midRateFormatted}`,
    `Your rate:        ${payload.rates.appliedRateFormatted}`,
    `Spread:           ${(payload.rates.spreadBps / 100).toFixed(2)}%`,
    '',
    `On-chain tx:      ${payload.blockchain.txHash ?? '—'}`,
    `Confirmations:    ${payload.blockchain.confirmations}/${payload.blockchain.confirmationsRequired}`,
    `Rail reference:   ${payload.rail.localReference ?? '—'} (${payload.rail.providerDisplayName})`,
    '',
    'Timeline:',
    ...(payload.timeline ?? []).map((t: { at: string; state: string }) => `  ${formatDateTime(t.at)}  ${t.state}`),
    '',
    `Integrity:        sha256 ${payload.contentSha256}`,
    '',
    payload.legal,
  ];
  return lines.join('\n');
}
