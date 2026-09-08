import { DomainError, RAILS, countryFor, formatPhone, normalizeMsisdn, type RailCode, type RecipientInput } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { encryptString, decryptString, maskTail } from '../lib/crypto.js';
import { id, nowIso } from '../lib/ids.js';
import { insert } from '../db/rows.js';

/**
 * Saved recipients.
 *
 * Bank account numbers are encrypted at rest (`bank_account_enc`); everything
 * else is stored in the clear because it is needed for routing, dedupe and
 * screening. Name verification ("who is 0712 345 678?") goes through the rail's
 * name-enquiry endpoint; in sandbox that is a deterministic simulator, and the
 * UI must show it as such — an unverified recipient is a *risk signal*, not a
 * green tick.
 */

export interface RecipientRecord {
  id: string;
  kind: RecipientInput['kind'];
  displayName: string;
  phone: string | null;
  till: string | null;
  paybill: string | null;
  accountReference: string | null;
  bankCode: string | null;
  bankAccount: string | null;
  walletAddress: string | null;
  network: string | null;
  country: string;
  rail: RailCode;
  note: string | null;
  favourite: boolean;
  defaultAmountMinor: bigint | null;
  verification?: { verified: boolean; name: string | null; source: string; at: string };
  lastUsedAt?: string | null;
  createdAt?: string;
}

interface Row {
  id: string;
  user_id: string | null;
  kind: string;
  display_name: string;
  phone: string | null;
  till: string | null;
  paybill: string | null;
  account_reference: string | null;
  bank_code: string | null;
  bank_account_enc: string | null;
  wallet_address: string | null;
  network: string | null;
  country: string;
  rail: string;
  note: string | null;
  favourite: number;
  default_amount_minor: string | null;
  verification_status: string;
  verified_name: string | null;
  verified_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: Row): RecipientRecord {
  return {
    id: row.id,
    kind: row.kind as RecipientRecord['kind'],
    displayName: row.display_name,
    phone: row.phone,
    till: row.till,
    paybill: row.paybill,
    accountReference: row.account_reference,
    bankCode: row.bank_code,
    bankAccount: decryptString(row.bank_account_enc),
    walletAddress: row.wallet_address,
    network: row.network,
    country: row.country,
    rail: row.rail as RailCode,
    note: row.note,
    favourite: row.favourite === 1,
    defaultAmountMinor: row.default_amount_minor ? BigInt(row.default_amount_minor) : null,
    verification: {
      verified: row.verification_status === 'VERIFIED',
      name: row.verified_name,
      source: row.verification_status === 'VERIFIED' ? (config.isSandbox ? 'sandbox_name_enquiry' : 'rail_name_enquiry') : 'unverified',
      at: row.verified_at ?? row.updated_at,
    },
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export function upsert(userId: string, input: RecipientInput, rail: RailCode): RecipientRecord {
  const db = getDb();
  const country = countryFor(input.country ?? 'KE');
  validate(input, country.code);
  const phone = input.kind === 'PHONE' || input.kind === 'PAYBILL' || input.kind === 'TILL' ? (input.phone ?? null) : (input.phone ?? null);
  const bankEnc = input.bankAccount ? encryptString(input.bankAccount) : null;

  // Dedupe on the natural key so re-typing a saved recipient does not fork a
  // second record with different metadata.
  const existing = db.maybeOne<Row>(
    `SELECT * FROM payment_recipients
     WHERE user_id = ?
       AND (
         (? = 'PHONE' AND phone = ?) OR
         (? = 'TILL' AND till = ?) OR
         (? = 'PAYBILL' AND paybill = ? AND account_reference = ?) OR
         (? = 'BANK' AND bank_account_enc IS NOT NULL AND bank_account_enc = ?)
       )
     ORDER BY updated_at DESC LIMIT 1`,
    [
      userId,
      input.kind,
      phone ?? '',
      input.kind,
      input.till ?? '',
      input.kind,
      input.paybill ?? '',
      input.accountReference ?? '',
      input.kind,
      bankEnc ?? '',
    ],
  );

  const now = nowIso();
  if (existing) {
    db.run(
      `UPDATE payment_recipients
       SET display_name = ?, note = COALESCE(?, note), favourite = ?, default_amount_minor = COALESCE(?, default_amount_minor), updated_at = ?
       WHERE id = ?`,
      [
        input.displayName,
        input.note ?? null,
        input.favourite ? 1 : existing.favourite,
        input.defaultAmountKesMajor !== undefined ? String(input.defaultAmountKesMajor * 100) : null,
        now,
        existing.id,
      ],
    );
    return toRecord(db.one<Row>('SELECT * FROM payment_recipients WHERE id = ?', [existing.id]));
  }

  const recipientId = id('rcp');
  insert('payment_recipients', {
    id: recipientId,
    user_id: userId,
    business_id: null,
    kind: input.kind,
    display_name: input.displayName,
    phone,
    till: input.till ?? null,
    paybill: input.paybill ?? null,
    account_reference: input.accountReference ?? null,
    bank_code: input.bankCode ?? null,
    bank_account_enc: bankEnc,
    wallet_address: input.walletAddress ?? null,
    network: input.network ?? null,
    country: country.code,
    rail,
    note: input.note ?? null,
    favourite: input.favourite ? 1 : 0,
    default_amount_minor: input.defaultAmountKesMajor !== undefined ? String(Math.round(input.defaultAmountKesMajor * 100)) : null,
    verification_status: 'UNVERIFIED',
    created_at: now,
    updated_at: now,
  });
  return toRecord(db.one<Row>('SELECT * FROM payment_recipients WHERE id = ?', [recipientId]));
}

function validate(input: RecipientInput, countryCode: string): void {
  const country = countryFor(countryCode);
  switch (input.kind) {
    case 'PHONE': {
      const msisdn = normalizeMsisdn(input.phone ?? '');
      if (!msisdn) throw new DomainError('VALIDATION_FAILED', 'Enter a valid Kenyan mobile number, e.g. 0712 345 678.', { field: 'phone' });
      if (!new RegExp(country.phonePattern).test(msisdn.slice(1))) {
        throw new DomainError('VALIDATION_FAILED', 'That number is not a Safaricom or Airtel mobile-money MSISDN.', { field: 'phone' });
      }
      return;
    }
    case 'TILL':
      if (!input.till || !/^\d{5,6}$/.test(input.till)) {
        throw new DomainError('VALIDATION_FAILED', 'A Till (Buy Goods) number is 5 or 6 digits.', { field: 'till' });
      }
      return;
    case 'PAYBILL':
      if (!input.paybill || !/^\d{4,6}$/.test(input.paybill)) {
        throw new DomainError('VALIDATION_FAILED', 'A PayBill number is 4–6 digits.', { field: 'paybill' });
      }
      if (!input.accountReference) {
        throw new DomainError('VALIDATION_FAILED', 'PayBill payments need an account number so the business can match the payment.', {
          field: 'accountReference',
        });
      }
      return;
    case 'BANK':
      if (!input.bankCode || !input.bankAccount) {
        throw new DomainError('VALIDATION_FAILED', 'Bank payouts need a bank code and account number.', { field: 'bank' });
      }
      if (!/^[A-Za-z0-9]{6,34}$/.test(input.bankAccount)) {
        throw new DomainError('VALIDATION_FAILED', 'That account number does not look valid for the selected bank.', { field: 'bankAccount' });
      }
      return;
    case 'WALLET':
      if (!input.walletAddress || input.walletAddress.length < 20) {
        throw new DomainError('VALIDATION_FAILED', 'Enter the full destination wallet address.', { field: 'walletAddress' });
      }
      return;
    case 'QR':
    case 'LINK':
      return;
  }
}

/**
 * Name enquiry. Production calls the rail's `mtn name enquiry` / Daraja
 * Bill-Validator equivalent. Sandbox derives a stable name from the MSISDN and
 * marks the source as simulated so nothing pretends to be a live check.
 */
export function verify(recipient: RecipientRecord): { verified: boolean; name: string | null; source: string; at: string } {
  const db = getDb();
  const at = nowIso();
  if (recipient.kind === 'PHONE' && recipient.phone) {
    if (config.isSandbox) {
      const digits = recipient.phone.replace(/\D/g, '');
      const seed = Number(digits.slice(-3)) % SANDBOX_NAMES.length;
      const name = SANDBOX_NAMES[seed]!;
      // A deliberately unverified demo number so the "confirm the name" risk
      // path can be exercised.
      const blocked = digits.endsWith('000');
      const result = {
        verified: !blocked,
        name: blocked ? null : name,
        source: 'sandbox_name_enquiry',
        at,
      };
      db.run(
        `UPDATE payment_recipients SET verification_status = ?, verified_name = ?, verified_at = ?, updated_at = ? WHERE id = ?`,
        [result.verified ? 'VERIFIED' : 'UNVERIFIED', result.name, at, at, recipient.id],
      );
      return result;
    }
    throw new DomainError(
      'PROVIDER_KEY_MISSING',
      'Recipient name verification requires the mobile-money provider\'s name-enquiry API, which is not configured.',
    );
  }
  if (recipient.kind === 'TILL' || recipient.kind === 'PAYBILL') {
    const business = db.maybeOne<{ name: string }>(
      `SELECT name FROM businesses WHERE till_number = ? OR paybill_number = ? LIMIT 1`,
      [recipient.till ?? '', recipient.paybill ?? ''],
    );
    if (business) {
      const result = { verified: true, name: business.name, source: 'aurapay_merchant_directory', at };
      db.run(`UPDATE payment_recipients SET verification_status = 'VERIFIED', verified_name = ?, verified_at = ? WHERE id = ?`, [
        result.name,
        at,
        recipient.id,
      ]);
      return result;
    }
    return { verified: false, name: null, source: 'no_directory_entry', at };
  }
  return { verified: false, name: null, source: 'not_supported_for_rail', at };
}

const SANDBOX_NAMES = ['JOHN K MWANGI', 'MARY A OTIENO', 'PETER O KAMAU', 'JANE W NJOKU', 'DAVID K MUTISO', 'GRACE A ACHIENG'];

export function list(userId: string, opts: { query?: string; favouritesOnly?: boolean } = {}): RecipientRecord[] {
  const db = getDb();
  const params: (string | number)[] = [userId];
  let sql = `SELECT * FROM payment_recipients WHERE user_id = ?`;
  if (opts.favouritesOnly) sql += ' AND favourite = 1';
  if (opts.query) {
    sql += ' AND (display_name LIKE ? OR phone LIKE ? OR till LIKE ? OR paybill LIKE ? OR account_reference LIKE ?)';
    const like = `%${opts.query}%`;
    params.push(like, like, like, like, like);
  }
  sql += ' ORDER BY favourite DESC, last_used_at DESC NULLS LAST, updated_at DESC LIMIT 60';
  return db.all<Row>(sql, params).map(toRecord);
}

export function byId(userId: string, recipientId: string): RecipientRecord | null {
  const row = getDb().maybeOne<Row>('SELECT * FROM payment_recipients WHERE id = ? AND user_id = ?', [recipientId, userId]);
  return row ? toRecord(row) : null;
}

export function remove(userId: string, recipientId: string): void {
  const db = getDb();
  const open = db.maybeOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM payment_intents WHERE recipient_id = ? AND status NOT IN ('COMPLETED','FAILED','REFUNDED')`,
    [recipientId],
  );
  if ((open?.c ?? 0) > 0) throw new DomainError('CONFLICT', 'This recipient has payments in progress. Saved details are kept until they finish.');
  db.run('DELETE FROM payment_recipients WHERE id = ? AND user_id = ?', [recipientId, userId]);
}

export function setFavourite(userId: string, recipientId: string, favourite: boolean): void {
  getDb().run('UPDATE payment_recipients SET favourite = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
    favourite ? 1 : 0,
    nowIso(),
    recipientId,
    userId,
  ]);
}

/** Human handle for receipts/lists: phone, Till, PayBill+account, masked bank a/c. */
export function displayHandle(recipient: RecipientRecord | Record<string, unknown>): string {
  const r = recipient as Partial<RecipientRecord>;
  if (r.phone) return formatPhone(r.phone);
  if (r.till) return `Till ${r.till}`;
  if (r.paybill) return `PayBill ${r.paybill}${r.accountReference ? ` · ${r.accountReference}` : ''}`;
  if (r.bankAccount) return `${r.bankCode ?? 'BANK'} ${maskTail(r.bankAccount)}`;
  if (r.bankCode) return `${r.bankCode} ${r.accountReference ?? ''}`.trim();
  if (r.walletAddress) return `${r.walletAddress.slice(0, 6)}…${r.walletAddress.slice(-6)}`;
  return 'Recipient';
}

export function railLabel(rail: RailCode): string {
  return RAILS[rail]?.recipientFacing ?? rail;
}
