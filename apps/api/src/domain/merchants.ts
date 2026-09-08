import { DomainError, RAILS, formatKes, type RailCode } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, nowIso } from '../lib/ids.js';
import * as notifications from './notifications.js';
import { publish } from './realtime.js';
import { insert } from '../db/rows.js';
import { stringify } from '../lib/json.js';

/**
 * Merchants (KYB-lite, settlement, hosted checkout).
 *
 * A business is a separate subject from a user: it has its own settlement rail,
 * its own till/paybill destination and its own money bucket in the ledger
 * (`USER:{business_id}:FIAT:KES` acts as the settlement balance). The checkout
 * session a customer pays into is a normal payment intent tagged with the
 * business, so merchants and customers see the *same* record from both sides —
 * there is no parallel merchant ledger that could disagree with the app.
 */

export interface BusinessRow {
  id: string;
  name: string;
  legal_name: string | null;
  category: string | null;
  country: string;
  currency: string;
  registration_number: string | null;
  tax_number_masked: string | null;
  kyb_status: string;
  logo_mark: string | null;
  website: string | null;
  settlement_rail: string;
  settlement_target: string | null;
  till_number: string | null;
  paybill_number: string | null;
  merchant_code: string;
  accept_crypto: number;
  status: string;
  mrr_tier: string;
  created_at: string;
  updated_at: string;
}

export interface MerchantView {
  id: string;
  name: string;
  legalName: string | null;
  category: string | null;
  country: string;
  currency: string;
  merchantCode: string;
  kybStatus: string;
  status: string;
  settlement: {
    rail: RailCode;
    railLabel: string;
    target: string | null;
    till: string | null;
    paybill: string | null;
    cycle: string;
  };
  acceptCrypto: boolean;
  website: string | null;
  logoMark: string | null;
  role: string;
}

export function businessesForUser(userId: string): MerchantView[] {
  const db = getDb();
  const rows = db.all<BusinessRow & { role: string }>(
    `SELECT b.*, m.role FROM businesses b JOIN business_members m ON m.business_id = b.id WHERE m.user_id = ? AND m.status = 'ACTIVE'`,
    [userId],
  );
  const fallback = db.all<BusinessRow & { role: string }>(
    `SELECT b.*, 'OWNER' AS role FROM businesses b WHERE b.owner_user_id = ?`,
    [userId],
  ).filter((row) => !rows.some((existing) => existing.id === row.id));
  return [...rows, ...fallback].map(toView);
}

function toView(row: BusinessRow & { role?: string }): MerchantView {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legal_name,
    category: row.category,
    country: row.country,
    currency: row.currency,
    merchantCode: row.merchant_code,
    kybStatus: row.kyb_status,
    status: row.status,
    settlement: {
      rail: row.settlement_rail as RailCode,
      railLabel: RAILS[row.settlement_rail as RailCode]?.recipientFacing ?? row.settlement_rail,
      target: row.settlement_target,
      till: row.till_number,
      paybill: row.paybill_number,
      cycle: settlementCycle(row.mrr_tier),
    },
    acceptCrypto: row.accept_crypto === 1,
    website: row.website,
    logoMark: row.logo_mark,
    role: row.role ?? 'VIEWER',
  };
}

function settlementCycle(tier: string): string {
  if (tier === 'priority') return 'Same day, twice daily (10:00 and 16:00 EAT)';
  if (tier === 'gold') return 'Next business day by 11:00 EAT';
  return 'Next business day by 16:00 EAT';
}

export function byId(businessId: string): MerchantView | null {
  const row = getDb().maybeOne<BusinessRow>('SELECT * FROM businesses WHERE id = ?', [businessId]);
  return row ? toView(row) : null;
}

export function requireAccess(userId: string, businessId: string): MerchantView {
  const view = businessesForUser(userId).find((b) => b.id === businessId);
  if (!view) throw new DomainError('FORBIDDEN', 'You are not a member of that merchant account.');
  return view;
}

export function dashboard(businessId: string) {
  const db = getDb();
  const totals = db.maybeOne<{
    c: number;
    collected: number;
    completed: number;
    pending: number;
    failed: number;
  }>(
    `SELECT COUNT(*) AS c,
            COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN CAST(recipient_amount_minor AS INTEGER) ELSE 0 END), 0) / 100.0 AS collected,
            SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status NOT IN ('COMPLETED','FAILED','REFUNDED') THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed
     FROM payment_intents WHERE business_id = ?`,
    [businessId],
  );
  const days = db.all<{ day: string; volume: number; count: number }>(
    `SELECT substr(completed_at, 1, 10) AS day,
            SUM(CAST(recipient_amount_minor AS INTEGER)) / 100.0 AS volume,
            COUNT(*) AS count
     FROM payment_intents
     WHERE business_id = ? AND status = 'COMPLETED' AND completed_at >= date('now', '-30 days')
     GROUP BY day ORDER BY day`,
    [businessId],
  );
  const assets = db.all<{ asset: string; volume: number; count: number }>(
    `SELECT asset, SUM(CAST(recipient_amount_minor AS INTEGER)) / 100.0 AS volume, COUNT(*) AS count
     FROM payment_intents WHERE business_id = ? AND status = 'COMPLETED' GROUP BY asset ORDER BY volume DESC`,
    [businessId],
  );
  const settlement = db.maybeOne<{ balance_minor: string }>(
    `SELECT b.id FROM businesses b WHERE b.id = ?`,
    [businessId],
  )
    ? db.maybeOne<{ balance_minor: string }>(
        `SELECT COALESCE(SUM(CAST(amount_minor AS INTEGER)), 0) AS balance_minor FROM ledger_entries WHERE account_code LIKE ? AND direction = 'CREDIT'`,
        [`USER:${businessId}:FIAT:%`],
      )
    : null;
  return {
    collected: totals?.collected ?? 0,
    collectedFormatted: formatKes(BigInt(Math.round((totals?.collected ?? 0) * 100))),
    payments: totals?.c ?? 0,
    completed: totals?.completed ?? 0,
    pending: totals?.pending ?? 0,
    failed: totals?.failed ?? 0,
    successRate: (totals?.c ?? 0) > 0 ? Math.round(((totals?.completed ?? 0) / (totals?.c ?? 1)) * 1000) / 10 : null,
    last30Days: days,
    byAsset: assets,
    settlementBalanceMinor: (settlement?.balance_minor ?? '0').toString(),
    note: 'Settlement figures are ledger-derived. In sandbox every row here is simulated data.',
    simulated: config.isSandbox,
  };
}

/** Hosted checkout: the merchant page prices in KES, the customer pays in crypto. */
export function createCheckoutSession(input: {
  businessId: string;
  amountKesMajor: number;
  description?: string;
  externalId?: string | null;
  customerRef?: string | null;
  successUrl?: string | null;
  cancelUrl?: string | null;
  expiresInMinutes?: number;
}): { token: string; url: string; expiresAt: string } {
  const db = getDb();
  const business = db.maybeOne<BusinessRow>('SELECT * FROM businesses WHERE id = ?', [input.businessId]);
  if (!business) throw new DomainError('NOT_FOUND', 'That merchant account does not exist.');
  if (business.status !== 'ACTIVE') {
    throw new DomainError('FORBIDDEN', 'This merchant account cannot take payments right now. Contact AuraPay support.');
  }
  if (input.amountKesMajor <= 0) throw new DomainError('VALIDATION_FAILED', 'A checkout amount must be greater than zero.');
  const token = id('chk').slice(4);
  const expiresAt = new Date(Date.now() + (input.expiresInMinutes ?? 20) * 60_000).toISOString();
  db.run(
    `INSERT INTO payment_links
     (id, token, user_id, business_id, title, description, amount_minor, currency, reference, accepted_assets, settlement_rail,
      settlement_target, allow_payer_amount, allow_repeat, uses, collected_minor, status, success_url, cancel_url, created_at, updated_at)
     VALUES (?,?,?,?,?, 'Hosted checkout', ?, 'KES',?, '["USDT","USDC"]', ?,?, 0, 0, 0,'0','ACTIVE',?,?, ?, ?)`,
    [
      id('lnk'),
      token,
      null,
      business.id,
      input.description ?? `${business.name} checkout`,
      String(Math.round(input.amountKesMajor * 100)),
      input.externalId ?? null,
      business.settlement_rail,
      business.settlement_target,
      input.successUrl ?? null,
      input.cancelUrl ?? null,
      nowIso(),
      nowIso(),
    ],
  );
  db.run('UPDATE payment_links SET expires_at = ? WHERE token = ?', [expiresAt, token]);
  return { token, url: `${config.publicUrl}/checkout/${token}`, expiresAt };
}

export function readCheckout(token: string) {
  const db = getDb();
  const row = db.maybeOne<{
    id: string;
    title: string;
    description: string | null;
    amount_minor: string;
    currency: string;
    business_id: string | null;
    expires_at: string | null;
    status: string;
    settlement_rail: string;
  }>('SELECT id, title, description, amount_minor, currency, business_id, expires_at, status, settlement_rail FROM payment_links WHERE token = ?', [
    token,
  ]);
  if (!row) throw new DomainError('NOT_FOUND', 'That checkout session is not valid or has expired.');
  const expired = row.expires_at !== null && new Date(row.expires_at).getTime() < Date.now();
  const business = row.business_id ? db.maybeOne<BusinessRow>('SELECT * FROM businesses WHERE id = ?', [row.business_id]) : null;
  return {
    linkId: row.id,
    title: row.title,
    description: row.description,
    amountMinor: row.amount_minor,
    amountFormatted: formatKes(BigInt(row.amount_minor ?? '0')),
    currency: row.currency,
    merchant: business ? { name: business.name, merchantCode: business.merchant_code, logoMark: business.logo_mark } : null,
    rail: row.settlement_rail,
    expired: expired || row.status !== 'ACTIVE',
    expiresAt: row.expires_at,
    simulated: config.isSandbox,
  };
}

/** Merchant onboarding (KYB-lite). A licensed partner review is required in production. */
export function onboard(input: {
  userId: string;
  name: string;
  legalName?: string;
  category?: string;
  registrationNumber?: string;
  taxNumber?: string;
  website?: string;
  settlementRail?: RailCode;
  till?: string;
  paybill?: string;
  settlementTarget?: string;
}): MerchantView {
  const db = getDb();
  if (!input.name.trim()) throw new DomainError('VALIDATION_FAILED', 'Enter the trading name your customers will see.');
  if (input.till && !/^\d{5}$/.test(input.till)) throw new DomainError('VALIDATION_FAILED', 'A Till (Buy Goods) number is 5 digits.');
  if (input.paybill && !/^\d{4,6}$/.test(input.paybill)) throw new DomainError('VALIDATION_FAILED', 'A PayBill number is 4–6 digits.');
  const existing = db.maybeOne<{ id: string }>('SELECT id FROM businesses WHERE till_number = ? OR (paybill_number = ? AND ? IS NOT NULL) LIMIT 1', [
    input.till ?? '',
    input.paybill ?? '',
    input.paybill ?? null,
  ]);
  if (existing) {
    throw new DomainError('CONFLICT', 'That Till or PayBill is already registered with another merchant. AuraPay will not share a settlement destination.');
  }
  const businessId = id('biz');
  const merchantCode = `MRC-${Math.floor(100000 + Math.random() * 899999)}`;
  const now = nowIso();
  db.tx(() => {
    insert('businesses', {
      id: businessId,
      name: input.name.trim(),
      legal_name: input.legalName ?? null,
      category: input.category ?? 'RETAIL',
      country: 'KE',
      currency: 'KES',
      registration_number: input.registrationNumber ?? null,
      tax_number_masked: input.taxNumber ? `••••${input.taxNumber.slice(-4)}` : null,
      kyb_status: 'SUBMITTED',
      logo_mark: input.name.trim().slice(0, 2).toUpperCase(),
      website: input.website ?? null,
      settlement_rail: input.settlementRail ?? 'MPESA_TILL',
      settlement_target: input.settlementTarget ?? input.till ?? input.paybill ?? null,
      till_number: input.till ?? null,
      paybill_number: input.paybill ?? null,
      merchant_code: merchantCode,
      accept_crypto: 1,
      status: 'ACTIVE',
      mrr_tier: 'standard',
      created_at: now,
      updated_at: now,
    });
    insert('business_members', {
      id: id('bmem'),
      business_id: businessId,
      user_id: input.userId,
      role: 'OWNER',
      status: 'ACTIVE',
      invited_by: input.userId,
      created_at: now,
    });
  });
  notifications.push(input.userId, {
    title: 'Merchant application received',
    body: 'We are reviewing your business details. You can already test payments in sandbox; live collection starts once review completes.',
    severity: 'info',
    link: '/app/merchants',
  });
  publish('admin', 'network', 'merchant.onboarded', { businessId, name: input.name });
  const view = byId(businessId);
  if (!view) throw new DomainError('INTERNAL', 'Merchant created but could not be read back.');
  return view;
}

export function setSettlement(businessId: string, patch: { rail?: RailCode; target?: string | null; till?: string | null; paybill?: string | null }): MerchantView {
  const db = getDb();
  const business = db.maybeOne<BusinessRow>('SELECT * FROM businesses WHERE id = ?', [businessId]);
  if (!business) throw new DomainError('NOT_FOUND', 'That merchant account does not exist.');
  const fields: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [nowIso()];
  if (patch.rail) {
    if (!RAILS[patch.rail]) throw new DomainError('VALIDATION_FAILED', 'Unsupported settlement rail.');
    fields.push('settlement_rail = ?');
    params.push(patch.rail);
  }
  if (patch.target !== undefined) {
    fields.push('settlement_target = ?');
    params.push(patch.target);
  }
  if (patch.till !== undefined) {
    if (patch.till && !/^\d{5}$/.test(patch.till)) throw new DomainError('VALIDATION_FAILED', 'A Till (Buy Goods) number is 5 digits.');
    fields.push('till_number = ?');
    params.push(patch.till);
  }
  if (patch.paybill !== undefined) {
    if (patch.paybill && !/^\d{4,6}$/.test(patch.paybill)) throw new DomainError('VALIDATION_FAILED', 'A PayBill number is 4–6 digits.');
    fields.push('paybill_number = ?');
    params.push(patch.paybill);
  }
  params.push(businessId);
  db.run(`UPDATE businesses SET ${fields.join(', ')} WHERE id = ?`, params);
  db.run(
    `INSERT INTO audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, metadata, created_at)
     VALUES (?,?, 'MERCHANT', 'business.settlement_updated', 'business', ?, ?, ?)`,
    [id('aud'), null, businessId, stringify(patch), nowIso()],
  );
  return byId(businessId) as MerchantView;
}

export function setKybStatus(businessId: string, status: 'NOT_STARTED' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED', actor: string, note?: string): void {
  const db = getDb();
  db.run(`UPDATE businesses SET kyb_status = ?, updated_at = ? WHERE id = ?`, [status, nowIso(), businessId]);
  db.run(
    `INSERT INTO audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, metadata, created_at)
     VALUES (?,?, 'ADMIN', 'business.kyb_status', 'business', ?, ?, ?)`,
    [id('aud'), null, businessId, stringify({ status, note: note ?? null }), nowIso()],
  );
  const owner = db.maybeOne<{ user_id: string }>('SELECT user_id FROM business_members WHERE business_id = ? AND role = \'OWNER\' LIMIT 1', [businessId]);
  if (owner) {
    notifications.push(owner.user_id, {
      title: status === 'APPROVED' ? 'Business verification approved' : `Business verification: ${status.replace(/_/g, ' ').toLowerCase()}`,
      body:
        status === 'APPROVED'
          ? 'You can now collect live payments with AuraPay.'
          : note ?? 'Our team is reviewing your business documents. We will tell you as soon as it is done.',
      severity: status === 'REJECTED' ? 'warning' : status === 'APPROVED' ? 'success' : 'info',
      link: '/app/merchants',
    });
  }
}

/** Recipients a customer can pay at this merchant (Till / PayBill / QR). */
export function publicDirectory(query: string) {
  const like = `%${query}%`;
  return getDb()
    .all<{ name: string; till_number: string | null; paybill_number: string | null; merchant_code: string; category: string | null }>(
      `SELECT name, till_number, paybill_number, merchant_code, category FROM businesses
       WHERE accept_crypto = 1 AND status = 'ACTIVE' AND (name LIKE ? OR till_number LIKE ? OR merchant_code LIKE ?)
       ORDER BY name LIMIT 12`,
      [like, like, like],
    )
    .map((row) => ({
      name: row.name,
      till: row.till_number,
      paybill: row.paybill_number,
      merchantCode: row.merchant_code,
      category: row.category,
      verified: true,
    }));
}
