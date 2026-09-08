import { ASSET_SCALES, DomainError, type AssetCode } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { id, nowIso } from '../lib/ids.js';
import { createLogger } from '../logger.js';
import { insert } from '../db/rows.js';
import { stringify } from '../lib/json.js';

const log = createLogger('ledger');

const KNOWN_ASSETS = new Set<string>(Object.keys(ASSET_SCALES));

/**
 * Double-entry internal ledger.
 *
 * Rules that the engine enforces (not just documents):
 *
 *  1. **Append-only.** No UPDATE/DELETE on `ledger_entries` — the schema has
 *     triggers that abort them. A wrong posting is fixed by a *compensating*
 *     posting that references the original (`reverses_entry_id`) and is flagged
 *     `is_adjustment`.
 *  2. **STANDARD journals are single-currency and must net:** Σdebits = Σcredits
 *     within one asset.
 *  3. **CONVERSION journals are the only cross-currency shape:** one credit leg
 *     in `fromAsset` (crypto leaving treasury), one or more debit legs in
 *     `toAsset` (KES arriving into float), plus an explicit realized P&L. The
 *     crypto leg must equal the KES legs at the recorded execution rate, within
 *     the tolerance passed by the caller — this is what stops "magic money".
 *  4. **Every posting references a business object** (payment, payout, refund)
 *     so any balance can be traced back to a customer-visible record.
 *
 * Account taxonomy (codes are stable; they are what reports and merchants see):
 *   USER:{id}:CRYPTO:{ASSET}       liability   customer crypto we hold
 *   USER:{id}:FIAT:{CCY}           liability   customer fiat we hold
 *   TREASURY:CRYPTO:{ASSET}:{ROLE} asset       custody (CUSTODY | FEE | SETTLEMENT)
 *   FX_CLEARING:{CCY}              asset       in-flight conversion position
 *   LIQUIDITY:{RAIL}:{CCY}         asset       KES float at a payout partner
 *   PAYOUT_IN_FLIGHT:{CCY}         asset       submitted to provider, not delivered
 *   PAYOUT_LIABILITY:{CCY}         liability   promised to recipients
 *   REVENUE:PLATFORM:{ASSET}       revenue     service fees
 *   REVENUE:FX_SPREAD:{CCY}        revenue     disclosed spread income
 *   EXPENSE:PROVIDER_FEES:{CCY}    expense     rail/provider cost
 *   EXPENSE:NETWORK_GAS:{ASSET}    expense     on-chain fees burned
 *   CLEARING:NETWORK_GAS:{ASSET}   liability   gas collected, not yet paid
 *   CLEARING:PROVIDER:{CCY}        liability   provider fees accrued, not yet paid
 *   REFUND_CLEARING:{CCY}          asset       refund in progress
 *   ADJUSTMENT:{why}               equity      manual adjustments (admin only)
 */

export type EntryDirection = 'DEBIT' | 'CREDIT';
export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export type AccountOwner = 'USER' | 'TREASURY' | 'SETTLEMENT' | 'FEE' | 'PROVIDER' | 'PLATFORM';
export type JournalType = 'STANDARD' | 'CONVERSION';

export interface Posting {
  accountCode: string;
  direction: EntryDirection;
  asset: AssetCode;
  amountMinor: bigint;
  code: string;
  memo?: string;
  /** Set when this posting compensates an earlier entry (append-only correction). */
  reversesEntryId?: string | null;
}

export interface PostInput {
  group: string;
  asset: AssetCode;
  entries: Posting[];
  paymentIntentId?: string | null;
  payoutId?: string | null;
  refundId?: string | null;
  occurredAt?: string;
  memo?: string;
  isAdjustment?: boolean;
}

export interface ConversionInput {
  group: string;
  fromAsset: AssetCode;
  toAsset: AssetCode;
  /** Crypto credited out of treasury. */
  fromAmountMinor: bigint;
  /** Fiat debited into float (sum of `toEntries` amounts is checked against this). */
  toEntries: Posting[];
  /** Executed rate: 1 from-asset unit = rate × to-asset unit, scaled by 10^12. */
  rateScaled: bigint;
  /** Absolute tolerance for the rate identity, in `toAsset` minor units. */
  toleranceMinor: bigint;
  paymentIntentId?: string | null;
  memo?: string;
  /** Where the crypto physically goes (custody by default). */
  creditAccount?: string;
  /** Which commitment account the crypto is released from. */
  debitAccount?: string;
}

const ACCOUNT_PATTERNS: Array<{ match: RegExp; type: AccountType; normalSide: EntryDirection }> = [
  { match: /^USER:[^:]+:(CRYPTO|FIAT):[A-Z0-9]{3,5}$/, type: 'LIABILITY', normalSide: 'CREDIT' },
  { match: /^TREASURY:CRYPTO:[A-Z0-9]{3,5}(:[A-Z_0-9]+){1,2}$/, type: 'ASSET', normalSide: 'DEBIT' },
  { match: /^FX_CLEARING:[A-Z]{3}$/, type: 'ASSET', normalSide: 'DEBIT' },
  { match: /^LIQUIDITY:[A-Z_]+:[A-Z]{3}$/, type: 'ASSET', normalSide: 'DEBIT' },
  { match: /^PAYOUT_IN_FLIGHT:[A-Z]{3}$/, type: 'ASSET', normalSide: 'DEBIT' },
  { match: /^PAYOUT_LIABILITY:[A-Z]{3}$/, type: 'LIABILITY', normalSide: 'CREDIT' },
  { match: /^REFUND_CLEARING:[A-Z]{3}$/, type: 'ASSET', normalSide: 'DEBIT' },
  { match: /^REVENUE:[A-Z_:0-9]+$/, type: 'REVENUE', normalSide: 'CREDIT' },
  { match: /^EXPENSE:[A-Z_:0-9]+$/, type: 'EXPENSE', normalSide: 'DEBIT' },
  { match: /^CLEARING:[A-Z_:0-9]+$/, type: 'LIABILITY', normalSide: 'CREDIT' },
  { match: /^ADJUSTMENT(:[A-Z0-9_]+)?$/, type: 'EQUITY', normalSide: 'DEBIT' },
];

const ACCOUNT_META: Array<{ prefix: string; name: string; owner: AccountOwner }> = [
  { prefix: 'USER:', name: 'Customer balance', owner: 'USER' },
  { prefix: 'TREASURY:CRYPTO', name: 'Treasury custody', owner: 'TREASURY' },
  { prefix: 'FX_CLEARING', name: 'FX clearing position', owner: 'TREASURY' },
  { prefix: 'LIQUIDITY', name: 'Payout float', owner: 'SETTLEMENT' },
  { prefix: 'PAYOUT_IN_FLIGHT', name: 'Payouts in flight', owner: 'SETTLEMENT' },
  { prefix: 'PAYOUT_LIABILITY', name: 'Owed to recipients', owner: 'SETTLEMENT' },
  { prefix: 'REFUND_CLEARING', name: 'Refund clearing', owner: 'PLATFORM' },
  { prefix: 'REVENUE', name: 'Platform revenue', owner: 'FEE' },
  { prefix: 'EXPENSE', name: 'Operating expense', owner: 'PLATFORM' },
  { prefix: 'CLEARING', name: 'Clearing', owner: 'PLATFORM' },
  { prefix: 'ADJUSTMENT', name: 'Manual adjustment', owner: 'PLATFORM' },
];

export function accountForUser(userId: string, asset: AssetCode, kind: 'CRYPTO' | 'FIAT' = 'CRYPTO'): string {
  return `USER:${userId}:${kind}:${asset}`;
}

export function treasuryAccount(asset: AssetCode, network: string, role: 'CUSTODY' | 'FEE' | 'SETTLEMENT' = 'CUSTODY'): string {
  return `TREASURY:CRYPTO:${asset}:${network}:${role}`;
}

export function liquidityAccountCode(rail: string, currency: string): string {
  return `LIQUIDITY:${rail}:${currency}`;
}

/** Well-known account codes, so every module books against the same chart. */
export const accounts = {
  user: (userId: string, asset: AssetCode, kind: 'CRYPTO' | 'FIAT' = 'CRYPTO') => accountForUser(userId, asset, kind),
  custody: (asset: AssetCode, network: string) => treasuryAccount(asset, network, 'CUSTODY'),
  feeWallet: (asset: AssetCode, network: string) => treasuryAccount(asset, network, 'FEE'),
  clearing: (asset: AssetCode, network: string) => treasuryAccount(asset, network, 'SETTLEMENT'),
  fxClearing: (currency = 'KES') => `FX_CLEARING:${currency}`,
  liquidity: (rail: string, currency = 'KES') => liquidityAccountCode(rail, currency),
  payoutInFlight: (currency = 'KES') => `PAYOUT_IN_FLIGHT:${currency}`,
  payoutLiability: (currency = 'KES') => `PAYOUT_LIABILITY:${currency}`,
  refundClearing: (currency = 'KES') => `REFUND_CLEARING:${currency}`,
  platformRevenue: (asset: string) => `REVENUE:PLATFORM:${asset}`,
  fxSpreadRevenue: (currency = 'KES') => `REVENUE:FX_SPREAD:${currency}`,
  fxSlippage: (currency = 'KES') => `EXPENSE:FX_SLIPPAGE:${currency}`,
  providerFees: (currency = 'KES') => `EXPENSE:PROVIDER_FEES:${currency}`,
  providerClearing: (currency = 'KES') => `CLEARING:PROVIDER:${currency}`,
  gasExpense: (asset: string) => `EXPENSE:NETWORK_GAS:${asset}`,
  /** Crypto the customer has committed but the desk has not yet liquidated. Still
   *  physically in custody; this account says *whose* claim sits on it. */
  committed: (asset: string) => `CLEARING:COMMITTED:${asset}`,
  gasClearing: (asset: string) => `CLEARING:NETWORK_GAS:${asset}`,
  adjustment: (why: string) => `ADJUSTMENT:${why.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`,
};

/** Creates the account row on first use (just-in-time chart of accounts). */
export function ensureAccount(code: string): void {
  const db = getDb();
  if (db.maybeOne<{ code: string }>('SELECT code FROM ledger_accounts WHERE code = ?', [code])) return;
  const pattern = ACCOUNT_PATTERNS.find((p) => p.match.test(code));
  if (!pattern) throw new Error(`unrecognized ledger account shape: ${code}`);
  const meta = ACCOUNT_META.find((m) => code.startsWith(m.prefix));
  const parts = code.split(':');
  const tail = parts.at(-1) ?? '';
  const asset = KNOWN_ASSETS.has(tail) ? tail : null;
  db.run(
    `INSERT INTO ledger_accounts (code, name, type, owner, asset, currency, user_id, normal_side, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,'ACTIVE',?)`,
    [
      code,
      meta?.name ?? code,
      pattern.type,
      meta?.owner ?? 'PLATFORM',
      asset,
      asset,
      parts[0] === 'USER' ? parts[1]! : null,
      pattern.normalSide,
      nowIso(),
    ],
  );
}

/** Single-currency journal. Σdebits must equal Σcredits or the write is refused. */
export function postJournal(input: PostInput): { journalId: string } {
  const db = getDb();
  if (input.entries.length < 2) throw new Error('a journal needs at least two postings');
  let debits = 0n;
  let credits = 0n;
  for (const entry of input.entries) {
    if (entry.asset !== input.asset) {
      throw new Error(`journal ${input.group} mixes ${input.asset} with ${entry.asset}; use postConversion()`);
    }
    if (entry.amountMinor <= 0n) continue;
    if (entry.direction === 'DEBIT') debits += entry.amountMinor;
    else credits += entry.amountMinor;
  }
  if (debits !== credits) {
    const detail = `${input.asset} debits=${debits} credits=${credits} delta=${debits - credits}`;
    log.error('unbalanced journal refused', { group: input.group, detail });
    throw new DomainError('INTERNAL', `Unbalanced journal refused: ${detail}`, { group: input.group });
  }
  if (debits === 0n) return { journalId: 'noop' };

  const journalId = id('jr');
  const occurredAt = input.occurredAt ?? nowIso();
  db.tx(() => {
    insert('ledger_journals', {
      id: journalId,
      journal_group: input.group,
      type: 'STANDARD',
      asset: input.asset,
      payment_intent_id: input.paymentIntentId ?? null,
      payout_id: input.payoutId ?? null,
      refund_id: input.refundId ?? null,
      memo: input.memo ?? null,
      occurred_at: occurredAt,
      created_at: nowIso(),
    });
    let seq = 0;
    for (const entry of input.entries) {
      if (entry.amountMinor <= 0n) continue;
      ensureAccount(entry.accountCode);
      seq += 1;
      db.run(
        `INSERT INTO ledger_entries
         (id, journal_id, seq, account_code, direction, asset, amount_minor, payment_intent_id, payout_id, refund_id, code, memo, occurred_at, created_at, is_adjustment, reverses_entry_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          `${journalId}_${seq}`,
          journalId,
          seq,
          entry.accountCode,
          entry.direction,
          entry.asset,
          entry.amountMinor.toString(),
          input.paymentIntentId ?? null,
          input.payoutId ?? null,
          input.refundId ?? null,
          entry.code,
          entry.memo ?? null,
          occurredAt,
          nowIso(),
          input.isAdjustment ? 1 : 0,
          entry.reversesEntryId ?? null,
        ],
      );
    }
  });
  return { journalId };
}

/**
 * Conversion journal: crypto leaves treasury and local currency arrives in the
 * payout float. This is the ONLY cross-currency shape the engine accepts.
 *
 * Two identities are enforced, and they are the two that matter:
 *
 *   1. Rate identity — the gross local currency taken in must equal
 *      `fromAmountMinor × rateScaled`, within `toleranceMinor`. A quote can
 *      never "find" extra shillings.
 *   2. Per-currency balance — after the residual is booked, the `toAsset` side
 *      must net to zero, so any difference between what the crypto was worth and
 *      what the payment costs is *explicitly* recognized as margin income
 *      (`REVENUE:FX_SPREAD`) or slippage (`EXPENSE:FX_SLIPPAGE`), never hidden
 *      inside a rate.
 *
 * `toEntries` therefore carries both the float debit (gross proceeds) and the
 * credit that settles the FX clearing position.
 */
export function postConversion(input: ConversionInput): { journalId: string; pnlMinor: bigint } {
  const db = getDb();
  if (input.rateScaled <= 0n) throw new Error('conversion requires a positive execution rate');
  const grossTo = input.toEntries.reduce((acc, e) => (e.direction === 'DEBIT' ? acc + e.amountMinor : acc), 0n);
  const offsetsTo = input.toEntries.reduce((acc, e) => (e.direction === 'CREDIT' ? acc + e.amountMinor : acc), 0n);
  if (grossTo <= 0n) throw new Error('conversion journal needs at least one debit in toAsset');
  for (const entry of input.toEntries) {
    if (entry.asset !== input.toAsset) {
      throw new Error(`conversion ${input.fromAsset}→${input.toAsset}: toEntries must all be ${input.toAsset} (got ${entry.asset})`);
    }
  }
  const expectedTo = expectedToMinor(input.fromAmountMinor, input.fromAsset, input.rateScaled, input.toAsset);
  const drift = grossTo - expectedTo;
  if (drift < 0n ? -drift > input.toleranceMinor : drift > input.toleranceMinor) {
    const detail = `conversion ${input.fromAsset}→${input.toAsset}: gross ${input.toAsset} booked ${grossTo}, ${input.fromAmountMinor} ${input.fromAsset} at the recorded rate is ${expectedTo}, drift ${drift} exceeds tolerance ${input.toleranceMinor}`;
    log.error('conversion refused', { group: input.group, detail });
    throw new DomainError('QUOTE_STALE_RATE', `Conversion refused: ${detail}`);
  }
  const pnl = grossTo - offsetsTo;
  // The crypto side belongs to this journal: the committed balance is released and
  // custody physically hands the asset to the exchange. A conversion journal that
  // only carried the local-currency legs could not be tied back to (amount × rate).
  const entries: Posting[] = [
    {
      accountCode: input.debitAccount ?? accounts.committed(input.fromAsset),
      direction: 'DEBIT',
      asset: input.fromAsset,
      amountMinor: input.fromAmountMinor,
      code: 'COMMITTED_CRYPTO_DEBIT',
      memo: `${input.fromAmountMinor.toString()} ${input.fromAsset} released from the customer commitment`,
    },
    {
      accountCode: input.creditAccount ?? accounts.custody(input.fromAsset, 'CONVERSION'),
      direction: 'CREDIT',
      asset: input.fromAsset,
      amountMinor: input.fromAmountMinor,
      code: 'TREASURY_CRYPTO_CREDIT',
      memo: `${input.fromAsset} handed to the liquidity desk for ${input.toAsset}`,
    },
    ...input.toEntries,
  ];
  if (pnl > 0n) {
    entries.push({
      accountCode: `REVENUE:FX_SPREAD:${input.toAsset}`,
      direction: 'CREDIT',
      asset: input.toAsset,
      amountMinor: pnl,
      code: 'FX_SPREAD_REVENUE',
      memo: 'disclosed spread earned on this conversion',
    });
  } else if (pnl < 0n) {
    entries.push({
      accountCode: `EXPENSE:FX_SLIPPAGE:${input.toAsset}`,
      direction: 'DEBIT',
      asset: input.toAsset,
      amountMinor: -pnl,
      code: 'FX_SLIPPAGE_DEBIT',
      memo: 'conversion executed below the quoted rate',
    });
  }

  const journalId = id('jrv');
  const occurredAt = nowIso();
  db.tx(() => {
    db.run(
      `INSERT INTO ledger_journals
       (id, journal_group, type, asset, from_asset, to_asset, rate_scaled, gross_to_minor, tolerance_minor, pnl_minor, pnl_asset, payment_intent_id, memo, occurred_at, created_at)
       VALUES (?,?,'CONVERSION',NULL,?,?,?,?,?, ?,?,?,?,?, ?)`,
      [
        journalId,
        input.group,
        input.fromAsset,
        input.toAsset,
        input.rateScaled.toString(),
        grossTo.toString(),
        input.toleranceMinor.toString(),
        pnl.toString(),
        input.toAsset,
        input.paymentIntentId ?? null,
        input.memo ?? null,
        occurredAt,
        nowIso(),
      ],
    );
    let seq = 0;
    for (const entry of entries) {
      if (entry.amountMinor <= 0n) continue;
      ensureAccount(entry.accountCode);
      seq += 1;
      db.run(
        `INSERT INTO ledger_entries
         (id, journal_id, seq, account_code, direction, asset, amount_minor, payment_intent_id, payout_id, refund_id, code, memo, occurred_at, created_at, is_adjustment, reverses_entry_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, ?,0,NULL)`,
        [
          `${journalId}_${seq}`,
          journalId,
          seq,
          entry.accountCode,
          entry.direction,
          entry.asset,
          entry.amountMinor.toString(),
          input.paymentIntentId ?? null,
          null,
          null,
          entry.code,
          entry.memo ?? null,
          occurredAt,
          nowIso(),
        ],
      );
    }
    if (pnl !== 0n) {
      db.run(
        `INSERT INTO audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, metadata, created_at)
         VALUES (?, NULL, 'SYSTEM', 'CONVERSION_PNL', 'ledger_journal', ?, ?, ?)`,
        [id('aud'), journalId, stringify({ pnl: pnl.toString(), rate: input.rateScaled.toString(), from: input.fromAsset, to: input.toAsset }), nowIso()],
      );
    }
  });
  return { journalId, pnlMinor: pnl };
}

export function expectedToMinor(fromMinor: bigint, fromAsset: AssetCode, rateScaled: bigint, toAsset: AssetCode): bigint {
  const RATE_SCALE = 10n ** 12n;
  const fromUnit = 10n ** BigInt(ASSET_SCALES[fromAsset]);
  const toUnit = 10n ** BigInt(ASSET_SCALES[toAsset]);
  return (fromMinor * rateScaled * toUnit) / (fromUnit * RATE_SCALE);
}

export interface EntryRow {
  id: string;
  journal_id: string;
  journal_group: string | null;
  account_code: string;
  direction: EntryDirection;
  asset: string;
  amount_minor: string;
  code: string;
  memo: string | null;
  occurred_at: string;
  is_adjustment: number;
  reverses_entry_id: string | null;
}

export function entriesForPayment(paymentIntentId: string): EntryRow[] {
  return getDb().all<EntryRow>(
    `SELECT e.*, j.journal_group FROM ledger_entries e
     LEFT JOIN ledger_journals j ON j.id = e.journal_id
     WHERE e.payment_intent_id = ? ORDER BY e.occurred_at, e.journal_id, e.seq`,
    [paymentIntentId],
  );
}

export function sumSigned(accountCode: string, asset: AssetCode): bigint {
  const db = getDb();
  const account = db.maybeOne<{ normal_side: EntryDirection }>('SELECT normal_side FROM ledger_accounts WHERE code = ?', [accountCode]);
  if (!account) return 0n;
  const rows = db.all<{ direction: EntryDirection; amounts: string | null }>(
    `SELECT direction, GROUP_CONCAT(amount_minor) AS amounts
     FROM ledger_entries WHERE account_code = ? AND asset = ? GROUP BY direction`,
    [accountCode, asset],
  );
  const sumOf = (direction: EntryDirection): bigint =>
    (rows.find((r) => r.direction === direction)?.amounts ?? '')
      .split(',')
      .filter(Boolean)
      .reduce<bigint>((acc, v) => acc + BigInt(v), 0n);
  const debit = sumOf('DEBIT');
  const credit = sumOf('CREDIT');
  return account.normal_side === 'DEBIT' ? debit - credit : credit - debit;
}

/** Balance of every account matching a prefix, grouped by (account, asset). */
export function balancesByPattern(pattern: string): Array<{ code: string; name: string; type: AccountType; asset: string; balanceMinor: bigint }> {
  const db = getDb();
  const accounts = db.all<{ code: string; name: string; type: AccountType; normal_side: EntryDirection }>(
    `SELECT code, name, type, normal_side FROM ledger_accounts WHERE code LIKE ? AND status = 'ACTIVE'`,
    [pattern],
  );
  return accounts
    .map((account) => {
      const assets = db.all<{ asset: string }>(
        `SELECT DISTINCT asset FROM ledger_entries WHERE account_code = ?`,
        [account.code],
      );
      return assets.map((a) => ({
        code: account.code,
        name: account.name,
        type: account.type,
        asset: a.asset,
        balanceMinor: sumSigned(account.code, a.asset as AssetCode),
      }));
    })
    .flat();
}

/**
 * Book integrity report used by the treasury dashboard, the CI suite and
 * `npm run verify:ledger`. An empty array means the books are sound.
 */
export function verify(opts: { paymentIntentId?: string; limit?: number } = {}): Array<{ kind: string; ref: string; detail: string }> {
  const db = getDb();
  const problems: Array<{ kind: string; ref: string; detail: string }> = [];
  const filter = opts.paymentIntentId ? 'AND (e.payment_intent_id = ? OR j.payment_intent_id = ?)' : '';
  const limit = opts.limit ?? 5000;
  const params = opts.paymentIntentId ? [opts.paymentIntentId, opts.paymentIntentId, limit] : [limit];

  const rows = db.all<{
    journal_id: string;
    type: string;
    asset: string | null;
    direction: EntryDirection;
    custody: number;
    amounts: string | null;
  }>(
    `SELECT e.journal_id, j.type, e.asset, e.direction,
            CASE WHEN e.account_code LIKE 'TREASURY:CRYPTO:%' THEN 1 ELSE 0 END AS custody,
            GROUP_CONCAT(e.amount_minor) AS amounts
     FROM ledger_entries e JOIN ledger_journals j ON j.id = e.journal_id
     WHERE 1=1 ${opts.paymentIntentId ? 'AND (e.payment_intent_id = ? OR j.payment_intent_id = ?)' : ''}
     GROUP BY e.journal_id, j.type, e.asset, e.direction, custody
     LIMIT ?`,
    params,
  );
  const sumOf = (csv: string | null): bigint =>
    (csv ?? '').split(',').filter(Boolean).reduce<bigint>((acc, v) => acc + BigInt(v), 0n);
  interface Bucket {
    d: bigint;
    c: bigint;
    /** custody debits/credits, which is what actually moved in the vault */
    cd: bigint;
    cc: bigint;
  }
  const perJournal = new Map<string, { type: string; byAsset: Map<string, Bucket> }>();
  for (const row of rows) {
    const entry = perJournal.get(row.journal_id) ?? { type: row.type, byAsset: new Map<string, Bucket>() };
    const assetBucket = entry.byAsset.get(row.asset ?? '') ?? { d: 0n, c: 0n, cd: 0n, cc: 0n };
    const amount = sumOf(row.amounts);
    if (row.direction === 'DEBIT') assetBucket.d += amount;
    else assetBucket.c += amount;
    if (row.custody === 1) {
      if (row.direction === 'DEBIT') assetBucket.cd += amount;
      else assetBucket.cc += amount;
    }
    entry.byAsset.set(row.asset ?? '', assetBucket);
    perJournal.set(row.journal_id, entry);
  }
  for (const [journalId, journal] of perJournal) {
    if (journal.type === 'CONVERSION') {
      const meta = db.maybeOne<{
        rate_scaled: string;
        pnl_minor: string;
        gross_to_minor: string;
        tolerance_minor: string | null;
        from_asset: string;
        to_asset: string;
      }>(
        'SELECT rate_scaled, pnl_minor, gross_to_minor, tolerance_minor, from_asset, to_asset FROM ledger_journals WHERE id = ?',
        [journalId],
      );
      if (!meta) {
        problems.push({ kind: 'MISSING_CONVERSION_META', ref: journalId, detail: 'conversion journal has no rate/pnl metadata' });
        continue;
      }
      const crypto = journal.byAsset.get(meta.from_asset);
      const local = journal.byAsset.get(meta.to_asset);
      if (!crypto || !local) {
        problems.push({ kind: 'INCOMPLETE_CONVERSION', ref: journalId, detail: 'conversion journal is missing a leg' });
        continue;
      }
      // What custody gave up — the commitment leg must not be counted as a second sale.
      const cryptoOut = crypto.cc - crypto.cd;
      if (crypto.d !== crypto.c) {
        problems.push({ kind: 'UNBALANCED_CONVERSION', ref: journalId, detail: `${meta.from_asset} debits=${crypto.d} credits=${crypto.c}` });
      }
      const expected = expectedToMinor(cryptoOut, meta.from_asset as AssetCode, BigInt(meta.rate_scaled), meta.to_asset as AssetCode);
      const grossTo = BigInt(meta.gross_to_minor);
      // The quote allowed a bounded drift (rounding + the disclosed spread). That
      // allowance is stored on the journal, so "how much drift was accepted" is
      // auditable per payment rather than a global fudge factor.
      const tolerance = BigInt(meta.tolerance_minor ?? '0');
      const drift = grossTo - expected;
      if (drift < 0n ? -drift > tolerance : drift > tolerance) {
        problems.push({
          kind: 'CONVERSION_RATE_MISMATCH',
          ref: journalId,
          detail: `gross ${meta.to_asset}=${grossTo} but ${cryptoOut} ${meta.from_asset} at the recorded rate is ${expected}; drift ${drift} exceeds the ${tolerance} the quote allowed`,
        });
      }
      // After the P&L residual, the local-currency side must net to zero.
      if (local.d !== local.c) {
        problems.push({ kind: 'UNBALANCED_CONVERSION', ref: journalId, detail: `${meta.to_asset} debits=${local.d} credits=${local.c}` });
      }
      // The realized margin must equal gross minus the clearing credit, and it
      // must be booked in exactly one of the two shapes (income or slippage).
      const pnlBooked = BigInt(meta.pnl_minor);
      const legs = db.all<{ code: string | null; direction: EntryDirection; amounts: string | null }>(
        `SELECT code, direction, GROUP_CONCAT(amount_minor) AS amounts
         FROM ledger_entries WHERE journal_id = ? GROUP BY code, direction`,
        [journalId],
      );
      const legSum = (code: string, direction: EntryDirection): bigint =>
        legs
          .filter((l) => l.code === code && l.direction === direction)
          .reduce((acc, l) => acc + sumOf(l.amounts), 0n);
      const spreadIncome = legSum('FX_SPREAD_REVENUE', 'CREDIT');
      const slippage = legSum('FX_SLIPPAGE_DEBIT', 'DEBIT');
      const clearingCredit = local.c - spreadIncome;
      const expectedPnl = grossTo - clearingCredit;
      if (expectedPnl !== pnlBooked || spreadIncome + slippage !== (expectedPnl > 0n ? expectedPnl : 0n) + (expectedPnl < 0n ? -expectedPnl : 0n)) {
        problems.push({
          kind: 'CONVERSION_PNL_MISMATCH',
          ref: journalId,
          detail: `pnl=${pnlBooked} but gross=${grossTo} clearing=${clearingCredit} implies ${expectedPnl} (spread income ${spreadIncome}, slippage ${slippage})`,
        });
      }
      continue;
    }
    for (const [asset, bucket] of journal.byAsset) {
      if (bucket.d !== bucket.c) {
        problems.push({
          kind: 'UNBALANCED_JOURNAL',
          ref: journalId,
          detail: `${asset} debits=${bucket.d} credits=${bucket.c} delta=${bucket.d - bucket.c}`,
        });
      }
    }
  }

  // Custodial wallet cache must match the customer liability in the ledger.
  const wallets = db.all<{ id: string; user_id: string | null; asset: string; available_minor: string; reserved_minor: string }>(
    `SELECT id, user_id, asset, available_minor, reserved_minor FROM wallets WHERE kind = 'CUSTODIAL' AND user_id IS NOT NULL`,
  );
  const walletsByUserAsset = new Map<string, { ids: string[]; cached: bigint; asset: string; userId: string }>();
  for (const wallet of wallets) {
    const key = `${wallet.user_id}:${wallet.asset}`;
    const bucket = walletsByUserAsset.get(key) ?? { ids: [], cached: 0n, asset: wallet.asset, userId: wallet.user_id! };
    bucket.ids.push(wallet.id);
    bucket.cached += BigInt(wallet.available_minor) + BigInt(wallet.reserved_minor);
    walletsByUserAsset.set(key, bucket);
  }
  for (const bucket of walletsByUserAsset.values()) {
    const code = accountForUser(bucket.userId, bucket.asset as AssetCode);
    const liability = sumSigned(code, bucket.asset as AssetCode);
    // One liability account per user + asset: the same shilling-equivalent balance
    // can sit in several networks, so the cache is compared in aggregate.
    const cached = bucket.cached;
    if (liability !== cached) {
      problems.push({
        kind: 'WALLET_LEDGER_MISMATCH',
        ref: bucket.ids.join(','),
        detail: `${bucket.asset} wallet=${cached} liability=${liability} for ${bucket.userId}`,
      });
    }
  }
  return problems;
}

/**
 * Mirrors every posting of a payment (or one journal) as a new set of
 * compensating entries. History is untouched; the reversal is itself auditable
 * and linked back to what it reverses.
 */
export function compensate(
  reason: string,
  filter: { paymentIntentId?: string; journalId?: string },
  actor: string,
): { journalIds: string[]; entries: number } {
  const db = getDb();
  if (!filter.paymentIntentId && !filter.journalId) throw new Error('compensate needs a payment id or journal id');
  const rows = db.all<EntryRow>(
    filter.journalId
      ? 'SELECT e.*, j.journal_group FROM ledger_entries e LEFT JOIN ledger_journals j ON j.id = e.journal_id WHERE e.journal_id = ? ORDER BY e.seq'
      : 'SELECT e.*, j.journal_group FROM ledger_entries e LEFT JOIN ledger_journals j ON j.id = e.journal_id WHERE e.payment_intent_id = ? ORDER BY e.journal_id, e.seq',
    [filter.journalId ?? filter.paymentIntentId!],
  );
  if (rows.length === 0) return { journalIds: [], entries: 0 };
  const byJournal = new Map<string, EntryRow[]>();
  for (const row of rows) {
    const list = byJournal.get(row.journal_id) ?? [];
    list.push(row);
    byJournal.set(row.journal_id, list);
  }
  const group = id('adj');
  const journalIds: string[] = [];
  let entries = 0;
  db.tx(() => {
    for (const [sourceJournal, sourceEntries] of byJournal) {
      const sourceMeta = db.maybeOne<{ type: string; journal_group: string }>('SELECT type, journal_group FROM ledger_journals WHERE id = ?', [
        sourceJournal,
      ]);
      if (sourceMeta?.type === 'CONVERSION') {
        // Reverse a conversion by mirroring it with assets swapped.
        const meta = db.one<{ from_asset: string; to_asset: string; rate_scaled: string; pnl_minor: string; payment_intent_id: string | null }>(
          'SELECT from_asset, to_asset, rate_scaled, pnl_minor, payment_intent_id FROM ledger_journals WHERE id = ?',
          [sourceJournal],
        );
        const crypto = sourceEntries.filter((e) => e.asset === meta.from_asset);
        const fiat = sourceEntries.filter((e) => e.asset === meta.to_asset);
        const cryptoOut = fiat.length
          ? crypto.reduce((acc, e) => acc + (e.direction === 'CREDIT' ? BigInt(e.amount_minor) : -BigInt(e.amount_minor)), 0n)
          : 0n;
        postJournal({
          group: `${group}:${sourceJournal}`,
          asset: meta.to_asset as AssetCode,
          paymentIntentId: filter.paymentIntentId ?? meta.payment_intent_id,
          isAdjustment: true,
          memo: `ADJUSTMENT: ${reason}`,
          entries: fiat.map((e) => ({
            accountCode: e.account_code,
            direction: e.direction === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const),
            asset: meta.to_asset as AssetCode,
            amountMinor: BigInt(e.amount_minor),
            code: `${e.code}_REVERSED`,
            memo: `reverses ${e.id}`,
            reversesEntryId: e.id,
          })),
        });
        if (cryptoOut > 0n) {
          postJournal({
            group: `${group}:${sourceJournal}:crypto`,
            asset: meta.from_asset as AssetCode,
            paymentIntentId: filter.paymentIntentId ?? meta.payment_intent_id,
            isAdjustment: true,
            memo: `ADJUSTMENT: ${reason}`,
            entries: [
              {
                accountCode: crypto[0]?.account_code ?? treasuryAccount(meta.from_asset as AssetCode, 'HOT', 'SETTLEMENT'),
                direction: 'DEBIT',
                asset: meta.from_asset as AssetCode,
                amountMinor: cryptoOut,
                code: 'TREASURY_CRYPTO_DEBIT_REVERSED',
                memo: `crypto returned by partner: reverses ${sourceJournal}`,
              },
              {
                accountCode: `REFUND_CLEARING:${meta.from_asset}`,
                direction: 'CREDIT',
                asset: meta.from_asset as AssetCode,
                amountMinor: cryptoOut,
                code: 'REFUND_CREDIT',
                memo: `awaiting credit to payer`,
              },
            ],
          });
        }
        journalIds.push(`${group}:${sourceJournal}`);
        entries += sourceEntries.length;
        continue;
      }
      const buckets = new Map<string, Posting[]>();
      for (const e of sourceEntries) {
        const list = buckets.get(e.asset) ?? [];
        list.push({
          accountCode: e.account_code,
          direction: e.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
          asset: e.asset as AssetCode,
          amountMinor: BigInt(e.amount_minor),
          code: `${e.code}_REVERSED`,
          memo: `ADJUSTMENT: ${reason} (reverses ${e.id})`,
          reversesEntryId: e.id,
        });
        buckets.set(e.asset, list);
      }
      for (const [asset, postings] of buckets) {
        const posted = postJournal({
          group: `${group}:${sourceJournal}:${asset}`,
          asset: asset as AssetCode,
          paymentIntentId: filter.paymentIntentId,
          isAdjustment: true,
          memo: `ADJUSTMENT: ${reason}`,
          entries: postings,
        });
        journalIds.push(posted.journalId);
        entries += postings.length;
      }
    }
    db.run(
      `INSERT INTO audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, metadata, created_at)
       VALUES (?,?, 'ADMIN', 'ledger.compensate', 'ledger_journal', ?, ?, ?)`,
      [
        id('aud'),
        actor.startsWith('usr_') ? actor : null,
        filter.journalId ?? filter.paymentIntentId ?? 'unknown',
        stringify({ reason, entries, group, actor }),
        nowIso(),
      ],
    );
  });
  return { journalIds, entries };
}

export function journalGroupsFor(paymentIntentId: string): Array<{ group: string; type: string; occurredAt: string; memo: string | null }> {
  return getDb()
    .all<{ journal_group: string; type: string; occurred_at: string; memo: string | null }>(
      `SELECT journal_group, type, occurred_at, memo FROM ledger_journals WHERE payment_intent_id = ? ORDER BY occurred_at`,
      [paymentIntentId],
    )
    .map((r) => ({ group: r.journal_group ?? '', type: r.type, occurredAt: r.occurred_at, memo: r.memo }));
}

/** Platform P&L for a period, straight off the ledger. */
export function incomeStatement(fromIso: string, toIso: string): Array<{ account: string; asset: string; amountMinor: bigint }> {
  const db = getDb();
  const rows = db.all<{ account_code: string; asset: string; direction: EntryDirection; amounts: string | null }>(
    `SELECT account_code, asset, direction, GROUP_CONCAT(amount_minor) AS amounts
     FROM ledger_entries
     WHERE occurred_at >= ? AND occurred_at <= ? AND (account_code LIKE 'REVENUE%' OR account_code LIKE 'EXPENSE%')
     GROUP BY account_code, asset, direction`,
    [fromIso, toIso],
  );
  const sum = (csv: string | null): bigint => (csv ?? '').split(',').filter(Boolean).reduce<bigint>((acc, v) => acc + BigInt(v), 0n);
  const out = new Map<string, { debits: bigint; credits: bigint }>();
  for (const row of rows) {
    const key = `${row.account_code}|${row.asset}`;
    const bucket = out.get(key) ?? { debits: 0n, credits: 0n };
    if (row.direction === 'DEBIT') bucket.debits += sum(row.amounts);
    else bucket.credits += sum(row.amounts);
    out.set(key, bucket);
  }
  return [...out.entries()].map(([key, bucket]) => {
    const [account, asset] = key.split('|');
    // REVENUE is credit-normal, EXPENSE is debit-normal: both report a positive
    // magnitude of what was earned or spent in the period.
    const amountMinor = account!.startsWith('REVENUE') ? bucket.credits - bucket.debits : bucket.debits - bucket.credits;
    return { account: account!, asset: asset!, amountMinor };
  });
}
