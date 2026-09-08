import {
  DomainError,
  PAYABLE_ASSETS,
  RAILS,
  formatKes,
  type PayableAsset,
  type RailCode,
} from '@aurapay/shared';
import QRCode from 'qrcode';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, isoIn, nowIso, urlToken } from '../lib/ids.js';
import { publish } from './realtime.js';
import { insert } from '../db/rows.js';
import { stringify } from '../lib/json.js';

/**
 * Payment links and dynamic QR.
 *
 * A link is a *request*, never a charge: it reserves nothing, prices nothing and
 * expires. The payer opens it, gets their own quote, and funds it through the
 * normal payment pipeline — so a link can never be used to move money without the
 * payer's own confirmation, and the numbers they see are the ones they get.
 *
 * The QR payload is `aura://pay/<code>` — a plain URL that also works as a deep
 * link. Scanned by the AuraPay app, or by any camera that opens the hosted page.
 */

export interface LinkRow {
  id: string;
  token: string;
  user_id: string | null;
  business_id: string | null;
  title: string;
  description: string | null;
  amount_minor: string | null;
  currency: string;
  reference: string | null;
  accepted_assets: string;
  settlement_rail: string;
  settlement_target: string | null;
  allow_payer_amount: number;
  allow_repeat: number;
  max_uses: number | null;
  uses: number;
  collected_minor: string;
  status: string;
  success_url: string | null;
  cancel_url: string | null;
  public_note: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LinkView {
  id: string;
  token: string;
  url: string;
  title: string;
  description: string | null;
  amountMinor: string | null;
  amountFormatted: string | null;
  currency: string;
  reference: string | null;
  acceptedAssets: PayableAsset[];
  settlementRail: RailCode;
  railLabel: string;
  allowPayerAmount: boolean;
  allowRepeat: boolean;
  maxUses: number | null;
  uses: number;
  collectedMinor: string;
  collectedFormatted: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'COMPLETE';
  successUrl: string | null;
  cancelUrl: string | null;
  publicNote: string | null;
  expiresAt: string | null;
  createdAt: string;
  qrDataUrl?: string;
  payments: Array<{ id: string; reference: string; status: string; amountMinor: string; createdAt: string }>;
}

function toView(row: LinkRow, withQr = false): LinkView {
  const assets = (JSON.parse(row.accepted_assets) as string[]).filter((a): a is PayableAsset =>
    (PAYABLE_ASSETS as readonly string[]).includes(a),
  );
  const expired = row.expires_at !== null && new Date(row.expires_at).getTime() < Date.now();
  const status = row.status === 'ACTIVE' && expired ? 'EXPIRED' : row.status === 'ACTIVE' && row.max_uses !== null && row.uses >= row.max_uses ? 'COMPLETE' : row.status;
  return {
    id: row.id,
    token: row.token,
    url: `${config.publicUrl}/pay/${row.token}`,
    title: row.title,
    description: row.description,
    amountMinor: row.amount_minor,
    amountFormatted: row.amount_minor ? formatKes(BigInt(row.amount_minor)) : null,
    currency: row.currency,
    reference: row.reference,
    acceptedAssets: assets,
    settlementRail: row.settlement_rail as RailCode,
    railLabel: RAILS[row.settlement_rail as RailCode]?.recipientFacing ?? row.settlement_rail,
    allowPayerAmount: row.allow_payer_amount === 1,
    allowRepeat: row.allow_repeat === 1,
    maxUses: row.max_uses,
    uses: row.uses,
    collectedMinor: row.collected_minor,
    collectedFormatted: formatKes(BigInt(row.collected_minor)),
    status: status as LinkView['status'],
    successUrl: row.success_url,
    cancelUrl: row.cancel_url,
    publicNote: row.public_note,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    qrDataUrl: undefined,
    payments: getDb()
      .all<{ id: string; reference: string; status: string; recipient_amount_minor: string; created_at: string }>(
        `SELECT id, reference, status, recipient_amount_minor FROM payment_intents WHERE payment_link_id = ? ORDER BY created_at DESC LIMIT 25`,
        [row.id],
      )
      .map((p) => ({ id: p.id, reference: p.reference, status: p.status, amountMinor: p.recipient_amount_minor, createdAt: p.created_at })),
    ...(withQr ? { qrDataUrl: '' } : {}),
  };
}

export async function attachQr(view: LinkView): Promise<LinkView> {
  const dataUrl = await QRCode.toDataURL(`${config.publicUrl}/qr/${view.token}`, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
    color: { dark: '#04070a', light: '#ffffff' },
  });
  return { ...view, qrDataUrl: dataUrl };
}

export interface CreateLinkInput {
  userId: string;
  businessId?: string | null;
  title: string;
  description?: string | null;
  amountKesMajor?: number | null;
  reference?: string | null;
  acceptedAssets?: PayableAsset[];
  settlementRail?: RailCode;
  settlementTarget?: string | null;
  allowPayerAmount?: boolean;
  allowRepeat?: boolean;
  maxUses?: number | null;
  expiresInHours?: number | null;
  successUrl?: string | null;
  cancelUrl?: string | null;
  publicNote?: string | null;
}

export function create(input: CreateLinkInput): LinkView {
  const db = getDb();
  if (!input.title.trim()) throw new DomainError('VALIDATION_FAILED', 'Give the link a title so you recognise it later.');
  if (input.amountKesMajor !== undefined && input.amountKesMajor !== null && input.amountKesMajor <= 0) {
    throw new DomainError('VALIDATION_FAILED', 'A fixed amount must be greater than zero.');
  }
  const assets = (input.acceptedAssets?.length ? input.acceptedAssets : [...PAYABLE_ASSETS]).filter((a) =>
    (PAYABLE_ASSETS as readonly string[]).includes(a),
  );
  if (!assets.length) throw new DomainError('VALIDATION_FAILED', 'Pick at least one asset the payer can send.');
  const rail = (input.settlementRail ?? (input.businessId ? 'MPESA_TILL' : 'MPESA')) as RailCode;
  const token = urlToken(14);
  const linkId = id('lnk');
  const now = nowIso();
  insert('payment_links', {
    id: linkId,
    token,
    user_id: input.userId,
    business_id: input.businessId ?? null,
    title: input.title.trim(),
    description: input.description ?? null,
    amount_minor: input.amountKesMajor ? String(Math.round(input.amountKesMajor * 100)) : null,
    currency: 'KES',
    reference: input.reference ?? null,
    accepted_assets: stringify(assets),
    settlement_rail: rail,
    settlement_target: input.settlementTarget ?? null,
    allow_payer_amount: input.amountKesMajor && !input.allowPayerAmount ? 0 : 1,
    allow_repeat: input.allowRepeat ? 1 : 0,
    max_uses: input.maxUses ?? null,
    uses: 0,
    collected_minor: '0',
    status: 'ACTIVE',
    success_url: input.successUrl ?? null,
    cancel_url: input.cancelUrl ?? null,
    public_note: input.publicNote ?? null,
    expires_at: input.expiresInHours ? isoIn(input.expiresInHours * 3600) : null,
    created_at: now,
    updated_at: now,
  });
  return byId(linkId, input.userId);
}

export function byId(linkId: string, userId: string | null): LinkView {
  const row = getDb().maybeOne<LinkRow>('SELECT * FROM payment_links WHERE id = ?', [linkId]);
  if (!row) throw new DomainError('NOT_FOUND', 'That payment link no longer exists.');
  if (userId && row.user_id !== userId && row.business_id !== userId) throw new DomainError('FORBIDDEN', 'That link belongs to a different account.');
  return toView(row);
}

export function listFor(userId: string, businessId: string | null): LinkView[] {
  return getDb()
    .all<LinkRow>(
      `SELECT * FROM payment_links WHERE user_id = ? OR (? IS NOT NULL AND business_id = ?) ORDER BY created_at DESC LIMIT 100`,
      [userId, businessId, businessId],
    )
    .map((row) => toView(row));
}

/** Public lookup used by the hosted page; increments the scan counter. */
export function byToken(token: string): LinkView {
  const db = getDb();
  const row = db.maybeOne<LinkRow>('SELECT * FROM payment_links WHERE token = ?', [token]);
  if (!row) throw new DomainError('NOT_FOUND', 'That payment link is not valid any more. Ask the sender for a new one.');
  if (row.status !== 'ACTIVE') return toView(row);
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return toView(row);
  if (row.max_uses !== null && row.uses >= row.max_uses) return toView(row);
  db.run('UPDATE payment_links SET updated_at = ? WHERE id = ?', [nowIso(), row.id]);
  publish(`user:${row.user_id}`, 'merchant', 'link.viewed', { linkId: row.id, at: nowIso() });
  return toView(row);
}

export function update(linkId: string, userId: string, patch: Partial<Pick<CreateLinkInput, 'title' | 'description' | 'maxUses' | 'expiresInHours' | 'publicNote' | 'successUrl' | 'cancelUrl'>>): LinkView {
  const db = getDb();
  const row = db.maybeOne<LinkRow>('SELECT * FROM payment_links WHERE id = ? AND user_id = ?', [linkId, userId]);
  if (!row) throw new DomainError('NOT_FOUND', 'That payment link no longer exists.');
  const fields: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [nowIso()];
  const add = (column: string, value: string | number | null): void => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.title !== undefined) add('title', patch.title.trim());
  if (patch.description !== undefined) add('description', patch.description);
  if (patch.maxUses !== undefined) add('max_uses', patch.maxUses);
  if (patch.publicNote !== undefined) add('public_note', patch.publicNote);
  if (patch.successUrl !== undefined) add('success_url', patch.successUrl);
  if (patch.cancelUrl !== undefined) add('cancel_url', patch.cancelUrl);
  if (patch.expiresInHours !== undefined) add('expires_at', patch.expiresInHours ? isoIn(patch.expiresInHours * 3600) : null);
  params.push(linkId);
  db.run(`UPDATE payment_links SET ${fields.join(', ')} WHERE id = ?`, params);
  return byId(linkId, userId);
}

export function revoke(linkId: string, userId: string): void {
  const db = getDb();
  const open = db.maybeOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM payment_intents WHERE payment_link_id = ? AND status NOT IN ('COMPLETED','FAILED','REFUNDED')`,
    [linkId],
  );
  if ((open?.c ?? 0) > 0) {
    throw new DomainError(
      'CONFLICT',
      'Payments on this link are still in progress. They will finish normally; revoke the link afterwards to stop new ones.',
    );
  }
  db.run(`UPDATE payment_links SET status = 'REVOKED', updated_at = ? WHERE id = ? AND user_id = ?`, [nowIso(), linkId, userId]);
}

/** Called when a payment created from a link is booked, so counters stay honest. */
export function recordPayment(linkId: string, amountMinor: bigint): void {
  const db = getDb();
  const row = db.maybeOne<LinkRow>('SELECT * FROM payment_links WHERE id = ?', [linkId]);
  if (!row) return;
  const uses = row.uses + 1;
  db.run(
    `UPDATE payment_links SET uses = ?, collected_minor = CAST(CAST(collected_minor AS INTEGER) + CAST(? AS INTEGER) AS TEXT), updated_at = ? WHERE id = ?`,
    [uses, amountMinor.toString(), nowIso(), linkId],
  );
  if (row.max_uses !== null && uses >= row.max_uses) {
    db.run(`UPDATE payment_links SET status = 'COMPLETE', updated_at = ? WHERE id = ?`, [nowIso(), linkId]);
  }
  publish(`user:${row.user_id}`, 'merchant', 'link.payment', { linkId, uses, collectedMinor: (BigInt(row.collected_minor) + amountMinor).toString() });
}

/* ------------------------------------------------------------------ *
 * QR codes
 * ------------------------------------------------------------------ */

export interface QrInput {
  userId: string;
  businessId?: string | null;
  kind: 'MERCHANT_DYNAMIC' | 'MERCHANT_STATIC' | 'AMOUNT' | 'REQUEST' | 'LINK';
  label?: string | null;
  amountKesMajor?: number | null;
  currency?: string;
  acceptedAssets?: PayableAsset[];
  settlementRail?: RailCode;
  paymentLinkId?: string | null;
  expiresInMinutes?: number | null;
}

/**
 * Multi-method QR. One code carries the *destination*, not the rail: the payer's
 * app chooses the rail it wants (M-Pesa, Till, PayBill, bank) and the amount, so
 * a merchant prints one code instead of five.
 */
export async function createQr(input: QrInput): Promise<{ code: string; payload: string; dataUrl: string; methods: string[]; expiresAt: string | null }> {
  const db = getDb();
  const code = urlToken(10);
  const assets = (input.acceptedAssets?.length ? input.acceptedAssets : [...PAYABLE_ASSETS]).filter((a) => (PAYABLE_ASSETS as readonly string[]).includes(a));
  const rail = (input.settlementRail ?? 'MPESA') as RailCode;
  const business = input.businessId ? db.maybeOne<{ name: string; till_number: string | null }>('SELECT name, till_number FROM businesses WHERE id = ?', [input.businessId]) : null;
  const payload = stringify({
    v: 1,
    code,
    kind: input.kind,
    to: business?.name ?? input.label ?? 'AuraPay user',
    till: business?.till_number ?? null,
    cur: input.currency ?? 'KES',
    amt: input.amountKesMajor ?? null,
    assets,
    rails: qrMethods(rail, Boolean(business)),
    link: input.paymentLinkId ?? null,
    iss: config.publicUrl,
    simulated: config.isSandbox,
  });
  const expiresAt = input.expiresInMinutes ? isoIn(input.expiresInMinutes * 60) : null;
  db.run(
    `INSERT INTO qr_codes
     (id, code, kind, user_id, business_id, payment_link_id, label, amount_minor, currency, payload, accepted_assets, settlement_rail,
      status, scans, pays, expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',0,0,?,?,?)`,
    [
      id('qr'),
      code,
      input.kind,
      input.userId,
      input.businessId ?? null,
      input.paymentLinkId ?? null,
      input.label ?? business?.name ?? null,
      input.amountKesMajor ? String(Math.round(input.amountKesMajor * 100)) : null,
      input.currency ?? 'KES',
      payload,
      stringify(assets),
      rail,
      expiresAt,
      nowIso(),
      nowIso(),
    ],
  );
  const dataUrl = await QRCode.toDataURL(`aura://pay/${code}`, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
    color: { dark: '#04070a', light: '#ffffff' },
  });
  return { code, payload: `aura://pay/${code}`, dataUrl, methods: qrMethods(rail, Boolean(business)), expiresAt };
}

function qrMethods(rail: RailCode, isMerchant: boolean): string[] {
  const base = isMerchant ? ['TILL', 'PAYBILL', 'BANK'] : ['PHONE', 'BANK'];
  if (rail === 'MPESA') return ['MPESA', ...base];
  if (rail === 'AIRTEL_MONEY') return ['AIRTEL', ...base];
  return [rail, ...base];
}

export function resolveQr(code: string): { found: boolean; payload?: unknown; expiresAt?: string | null; kind?: string } {
  const db = getDb();
  const row = db.maybeOne<{ id: string; payload: string; kind: string; expires_at: string | null; status: string }>(
    'SELECT id, payload, kind, expires_at, status FROM qr_codes WHERE code = ?',
    [code],
  );
  if (!row || row.status !== 'ACTIVE') return { found: false };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return { found: false };
  db.run('UPDATE qr_codes SET scans = scans + 1, last_scanned_at = ?, updated_at = ? WHERE code = ?', [nowIso(), nowIso(), code]);
  return { found: true, payload: JSON.parse(row.payload), expiresAt: row.expires_at, kind: row.kind };
}

export function recordQrPayment(code: string): void {
  getDb().run('UPDATE qr_codes SET pays = pays + 1, updated_at = ? WHERE code = ?', [nowIso(), code]);
}

export function listQr(userId: string) {
  return getDb()
    .all<{
      id: string;
      code: string;
      kind: string;
      label: string | null;
      amount_minor: string | null;
      currency: string;
      settlement_rail: string;
      status: string;
      scans: number;
      pays: number;
      created_at: string;
      expires_at: string | null;
    }>(`SELECT * FROM qr_codes WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [userId])
    .map((row) => ({
      id: row.id,
      code: row.code,
      kind: row.kind,
      label: row.label,
      amountMinor: row.amount_minor,
      currency: row.currency,
      rail: row.settlement_rail,
      status: row.status,
      scans: row.scans,
      pays: row.pays,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      payloadUrl: `aura://pay/${row.code}`,
    }));
}

export function expireStale(): number {
  const db = getDb();
  const before = db.maybeOne<{ c: number }>('SELECT COUNT(*) AS c FROM payment_links WHERE status = \'ACTIVE\' AND expires_at IS NOT NULL AND expires_at <= ?', [nowIso()])?.c ?? 0;
  db.run(`UPDATE payment_links SET status = 'EXPIRED', updated_at = ? WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ?`, [
    nowIso(),
    nowIso(),
  ]);
  db.run(`UPDATE qr_codes SET status = 'EXPIRED', updated_at = ? WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ?`, [
    nowIso(),
    nowIso(),
  ]);
  return before;
}
