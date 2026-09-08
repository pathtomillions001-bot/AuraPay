import {
  FEE_SCHEDULES,
  ASSETS,
  NETWORKS,
  PAYABLE_ASSETS,
  formatKes,
  parseAmount,
  type NetworkCode,
  type PayableAsset,
  type RailCode,
} from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { insert, withSeedBypass } from '../db/rows.js';
import { config } from '../config.js';
import { hashPassword } from '../lib/crypto.js';
import { id, isoIn, nowIso } from '../lib/ids.js';
import { createLogger } from '../logger.js';
import * as wallets from '../domain/wallets.js';
import * as ledger from '../domain/ledger.js';
import * as liquidity from '../domain/liquidity.js';
import * as recipients from '../domain/recipients.js';
import * as quotes from '../domain/quotes.js';
import * as payments from '../domain/payments.js';
import * as paymentRepo from '../domain/paymentRepo.js';
import * as links from '../domain/links.js';
import * as keys from '../domain/keys.js';
import * as webhooks from '../domain/webhooks.js';
import * as sandbox from '../domain/sandbox.js';
import { blockchain } from '../domain/blockchain.js';
import * as merchants from '../domain/merchants.js';
import { refreshRates } from '../domain/fx.js';
import { stringify } from '../lib/json.js';
import * as queue from '../workers/queue.js';

const log = createLogger('seed');

/**
 * Sandbox seed.
 *
 * Everything created here is tagged `data_origin='sandbox'`, and the demo
 * identities are obviously demo (emails on @aurapay.dev, a fictional merchant).
 * Balances are not painted onto a table: each opening balance is an *opening
 * journal* in the ledger, and the wallet cache is derived from it, so the seeded
 * state passes exactly the same `ledger.verify()` check a production balance
 * must pass. That is the difference between a demo and a lie.
 */

export const DEMO_PASSWORD = 'aurapay-sandbox';

export interface SeedSummary {
  created: boolean;
  users: number;
  businesses: number;
  payments: number;
  floatAccounts: number;
  note: string;
}

export function alreadySeeded(): boolean {
  const db = getDb();
  return (db.maybeOne<{ c: number }>(`SELECT COUNT(*) AS c FROM users WHERE email = ?`, ['kelvin@aurapay.dev'])?.c ?? 0) > 0;
}

export async function seed(opts: { runDemoPayments?: boolean } = {}): Promise<SeedSummary> {
  const db = getDb();
  if (alreadySeeded()) {
    return { created: false, users: 0, businesses: 0, payments: 0, floatAccounts: 0, note: 'Database already contains the demo identities; nothing was changed.' };
  }
  if (!config.isSandbox) {
    throw new Error('Refusing to seed demo data into a production-mode API. Run with MODE=sandbox.');
  }

  bootstrapCatalogue();
  const float = fundFloat();
  const users = createUsers();
  const businesses = createBusinesses(users);
  createWallets(users, businesses);
  createRecipients(users);
  createMerchantAssets(users, businesses);
  await refreshRates();
  const demoPayments = (opts.runDemoPayments ?? true) ? await runDemoPayments(users) : 0;
  sandbox.storeDemoFeed();

  await drainUntilSettled();
  const problems = ledger.verify();
  if (problems.length) {
    log.error('seeded ledger does not balance', { problems });
    throw new Error(`Seed integrity check failed: ${problems.map((p) => `${p.kind}:${p.ref}`).join(', ')}`);
  }
  log.info('seed complete', { users: users.count, businesses: businesses.length, payments: demoPayments });
  return {
    created: true,
    users: users.count,
    businesses: businesses.length,
    payments: demoPayments,
    floatAccounts: float,
    note: `Sandbox data only. Sign in with any demo address and the password "${DEMO_PASSWORD}". Simulated: blockchain, FX feed, payout rails, KYC/screening.`,
  };
}

/* ------------------------------------------------------------------ */

function bootstrapCatalogue(): void {
  const db = getDb();
  const now = nowIso();
  for (const asset of Object.values(ASSETS)) {
    insert('assets', {
      code: asset.code,
      name: asset.name,
      kind: asset.kind,
      scale: asset.displayDecimals,
      enabled: 1,
      sandbox_payable: asset.sandboxPayable ? 1 : 0,
      production_enabled: asset.productionEnabled ? 1 : 0,
      usd_price_minor: asset.kind === 'stablecoin' ? 100 : 0,
      change24h_bps: 0,
      updated_at: now,
    });
  }
  for (const network of Object.values(NETWORKS)) {
    insert('networks', {
      code: network.code,
      name: network.name,
      confirmations_required: network.confirmationsRequired,
      block_time_seconds: network.blockTimeSeconds,
      fee_estimate_usd_cents: network.sandboxFeeUsdCents,
      dynamic_fee: network.dynamicFee ? 1 : 0,
      adapter: `sandbox:${network.code}`,
      status: 'OPERATIONAL',
      enabled: 1,
      last_checked_at: now,
      updated_at: now,
    });
  }
  for (const [asset, schedule] of Object.entries(FEE_SCHEDULES)) {
    insert('fees', {
      id: id('fee'),
      asset,
      rail: '*',
      platform_fee_bps: schedule.platformFeeBps,
      platform_fee_min_kes: schedule.platformFeeMinKes,
      spread_bps: schedule.spreadBps,
      rail_surcharge_minor: schedule.railSurchargeMinor,
      active: 1,
      effective_from: now,
      updated_by: 'seed',
      note: 'Published sandbox schedule (mirrors the shipped default).',
    });
  }
  for (const [key, value, description] of [
    ['platform.mode', 'sandbox', 'Runtime mode label shown across the product.'],
    ['platform.allowQueueOnInsufficient', String(config.liquidity.allowQueueOnInsufficient), 'Queue payouts when float is short instead of failing.'],
    ['platform.kycRequiredTier', '1', 'Tier required before live collection.'],
    ['compliance.simulatedProviders', 'true', 'KYC/AML screening uses local demo rules, not a licensed provider.'],
  ] as const) {
    insert('settings', { key, value, kind: 'string', description, updated_by: 'seed', updated_at: now });
  }
  // A demo watchlist so screening hits are reproducible without pretending to be
  // a sanctions authority. The note says so out loud.
  for (const [pattern, listId, note] of [
    ['0700000000', 'DEMO_WATCHLIST', 'Demo MSISDN used to exercise the risk-block path.'],
    ['99999', 'DEMO_WATCHLIST', 'Demo Till number that triggers a screening hit.'],
  ] as const) {
    db.run(
      `INSERT OR IGNORE INTO watchlist_entries (id, pattern, list_id, note, added_by, created_at) VALUES (?,?,?,?,?,?)`,
      [id('wl'), pattern, listId, note, 'seed', now],
    );
  }
}

function fundFloat(): number {
  const now = nowIso();
  const accounts: Array<{ rail: RailCode; provider: string; floatKes: number }> = [
    { rail: 'MPESA', provider: 'aurapay-sandbox-simulator', floatKes: 60_000_000 },
    { rail: 'AIRTEL_MONEY', provider: 'aurapay-sandbox-simulator', floatKes: 12_000_000 },
    { rail: 'PESALINK', provider: 'aurapay-sandbox-simulator', floatKes: 9_000_000 },
    { rail: 'BANK_TRANSFER', provider: 'aurapay-sandbox-simulator', floatKes: 4_000_000 },
  ];
  for (const account of accounts) {
    liquidity.ensureAccountFor(account.rail, 'KES', account.provider, BigInt(account.floatKes) * 100n);
    const existing = liquidity.findAccount(account.rail, 'KES');
    if (!existing) continue;
    const amountMinor = BigInt(account.floatKes) * 100n;
    getDb().tx(() => {
        ledger.postJournal({
          group: `seed:float:${account.rail}`,
          asset: 'KES',
          memo: `Opening float for ${account.rail} (sandbox)`,
          isAdjustment: true,
          occurredAt: now,
          entries: [
            {
              accountCode: ledger.accounts.liquidity(account.rail, 'KES'),
              direction: 'DEBIT',
              asset: 'KES',
              amountMinor,
              code: 'OPENING_FLOAT_DEBIT',
              memo: 'simulated settlement float',
            },
            {
              accountCode: ledger.accounts.adjustment(`opening_float_${account.rail}`),
              direction: 'CREDIT',
              asset: 'KES',
              amountMinor,
              code: 'OPENING_FLOAT_CREDIT',
              memo: 'equity funding the float',
            },
          ],
        });
        getDb().run(
          `UPDATE liquidity_accounts SET available_minor = CAST((CAST(available_minor AS INTEGER) + CAST(? AS INTEGER)) AS TEXT), updated_at = ? WHERE id = ?`,
          [amountMinor.toString(), now, existing.id],
        );
      });
  }
  return accounts.length;
}

interface SeededUsers {
  count: number;
  customer: string;
  merchantOwner: string;
  admin: string;
  reviewer: string;
}

function createUser(input: {
  id: string;
  email: string;
  name: string;
  phone?: string;
  roles: string[];
  tier: number;
  kycStatus?: string;
}): string {
  const now = nowIso();
  insert('users', {
    id: input.id,
    email: input.email,
    email_verified_at: now,
    password_hash: hashPassword(DEMO_PASSWORD),
    password_algo: 'scrypt',
    full_name: input.name,
    phone: input.phone ?? null,
    country: 'KE',
    locale: 'en-KE',
    roles: stringify(input.roles),
    status: 'ACTIVE',
    kyc_status: input.kycStatus ?? 'APPROVED',
    kyc_tier: input.tier,
    two_factor_enabled: 0,
    default_settlement_rail: 'MPESA',
    marketing_consent: 0,
    created_at: now,
    updated_at: now,
    last_login_at: null,
  });
  insert('kyc_profiles', {
    id: id('kyc'),
    user_id: input.id,
    provider: config.compliance.kycProvider === 'none' ? 'internal_rules' : config.compliance.kycProvider,
    provider_ref: `SIM-${input.id.slice(-6).toUpperCase()}`,
    status: input.kycStatus === 'APPROVED' ? 'APPROVED' : 'PENDING',
    tier: input.tier,
    document_type: input.tier > 0 ? 'NATIONAL_ID' : null,
    document_number_masked: input.tier > 0 ? '•••• 4821' : null,
    country: 'KE',
    reviewed_by: 'seed',
    reviewed_at: now,
    data_origin: 'sandbox',
    notes: 'Simulated verification used to unlock demo limits. No identity document was checked.',
    created_at: now,
    updated_at: now,
  });
  return input.id;
}

function createUsers(): SeededUsers {
  const customer = createUser({
    id: id('usr'),
    email: 'kelvin@aurapay.dev',
    name: 'Kelvin Otieno',
    phone: '+254712345678',
    roles: ['CUSTOMER'],
    tier: 2,
  });
  const merchantOwner = createUser({
    id: id('usr'),
    email: 'amina@aurapay.dev',
    name: 'Amina Yusuf',
    phone: '+254733555111',
    roles: ['CUSTOMER', 'MERCHANT'],
    tier: 3,
  });
  const admin = createUser({
    id: id('usr'),
    email: 'admin@aurapay.dev',
    name: 'AuraPay Operations',
    roles: ['ADMIN', 'SUPPORT'],
    tier: 3,
  });
  const reviewer = createUser({
    id: id('usr'),
    email: 'compliance@aurapay.dev',
    name: 'Wanjiru Kamau',
    roles: ['COMPLIANCE', 'REVIEWER'],
    tier: 3,
  });
  return { customer, merchantOwner, admin, reviewer, count: 4 };
}

function createBusinesses(users: SeededUsers): Array<{ id: string; name: string }> {
  const created: Array<{ id: string; name: string }> = [];
  const primary = merchants.onboard({
    userId: users.merchantOwner,
    name: 'MAMA WANJIKU SHOP',
    legalName: 'Mama Wanjiku General Trading Ltd',
    category: 'GROCERIES',
    registrationNumber: 'PVT-C-9912045',
    taxNumber: 'PK0099112233',
    website: 'https://mama-wanjiku.example',
    settlementRail: 'MPESA_TILL',
    till: '12345',
  });
  created.push({ id: primary.id, name: primary.name });
  const now = nowIso();
  for (const directory of [
    { name: 'SAFARI HARDWARE LTD', till: '33011', category: 'HARDWARE' },
    { name: 'ZINDUKI ELECTRONICS', till: '47720', category: 'ELECTRONICS' },
    { name: 'NIAJI RIDE SCHOOL', paybill: '400211', category: 'SERVICES' },
  ]) {
    const businessId = id('biz');
    insert('businesses', {
      id: businessId,
      name: directory.name,
      legal_name: directory.name,
      category: directory.category,
      country: 'KE',
      currency: 'KES',
      registration_number: 'PVT-C-0000000',
      tax_number_masked: null,
      kyb_status: 'APPROVED',
      logo_mark: directory.name.slice(0, 2),
      website: null,
      settlement_rail: directory.till ? 'MPESA_TILL' : 'MPESA_PAYBILL',
      settlement_target: directory.till ?? directory.paybill ?? null,
      till_number: directory.till ?? null,
      paybill_number: directory.paybill ?? null,
      merchant_code: `MRC-${Math.floor(100000 + Math.random() * 899999)}`,
      accept_crypto: 1,
      status: 'ACTIVE',
      mrr_tier: 'standard',
      created_at: now,
      updated_at: now,
    });
    insert('business_members', {
      id: id('bmem'),
      business_id: businessId,
      user_id: users.merchantOwner,
      role: 'ADMIN',
      status: 'ACTIVE',
      invited_by: users.merchantOwner,
      created_at: now,
    });
    created.push({ id: businessId, name: directory.name });
  }
  merchants.setKybStatus(primary.id, 'APPROVED', 'seed', 'Demo merchant approved so the sandbox checkout works end to end.');
  return created;
}

function createWallets(users: SeededUsers, businesses: Array<{ id: string; name: string }>): void {
  // Opening balances are booked as journals: DR treasury custody, CR customer
  // liability. The cache is derived from that, so it cannot disagree.
  const holdings: Array<{ userId: string; asset: PayableAsset; network: keyof typeof NETWORKS; amount: string }> = [
    { userId: users.customer, asset: 'USDT', network: 'TRON', amount: '800' },
    { userId: users.customer, asset: 'USDC', network: 'ETHEREUM', amount: '300' },
    { userId: users.customer, asset: 'USDC', network: 'SOLANA', amount: '240' },
    { userId: users.customer, asset: 'BTC', network: 'BITCOIN', amount: '0.0018' },
    { userId: users.customer, asset: 'ETH', network: 'ETHEREUM', amount: '0.045' },
    { userId: users.merchantOwner, asset: 'USDT', network: 'TRON', amount: '250' },
  ];
  for (const holding of holdings) {
    wallets.openBalance({
      userId: holding.userId,
      asset: holding.asset,
      network: holding.network as NetworkCode,
      amountMinor: parseAmount(holding.amount, holding.asset),
      memo: 'Sandbox opening balance — simulated funds, not a real deposit',
    });
  }
  // A settlement balance for the merchant, in KES, derived from delivered sales.
  const merchantWallet = getDb().maybeOne<{ id: string }>('SELECT id FROM businesses WHERE name = ? ORDER BY created_at LIMIT 1', [businesses[0]?.name ?? '']);
  if (merchantWallet) {
    getDb().tx(() => {
      const amountMinor = parseAmount('184500', 'USDT');
      insert('wallets', {
        id: id('wal'),
        user_id: null,
        business_id: merchantWallet.id,
        kind: 'SETTLEMENT',
        label: 'MAMA WANJIKU SHOP · KES settlement balance',
        asset: 'KES',
        network: 'FIAT',
        available_minor: amountMinor.toString(),
        reserved_minor: '0',
        custody_mode: 'partner',
        data_origin: 'sandbox',
        status: 'ACTIVE',
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      ledger.postJournal({
        group: 'seed:settlement:mama-wanjiku',
        asset: 'KES',
        memo: 'Opening settlement balance for the demo merchant (sandbox)',
        isAdjustment: true,
        entries: [
          {
            accountCode: ledger.accounts.user(merchantWallet.id, 'KES', 'FIAT'),
            direction: 'CREDIT',
            asset: 'KES',
            amountMinor,
            code: 'OPENING_SETTLEMENT_CREDIT',
            memo: 'payable to the merchant',
          },
          {
            accountCode: ledger.accounts.liquidity('MPESA', 'KES'),
            direction: 'DEBIT',
            asset: 'KES',
            amountMinor,
            code: 'OPENING_SETTLEMENT_DEBIT',
            memo: 'held in the M-Pesa float',
          },
        ],
      });
    });
  }
}

function createRecipients(users: SeededUsers): void {
  const saved: Array<{ kind: 'PHONE' | 'TILL' | 'PAYBILL'; input: Parameters<typeof recipients.upsert>[1]; rail: RailCode }> = [
    {
      kind: 'PHONE',
      input: { kind: 'PHONE', displayName: 'Baraka Mwangi', phone: '0712 345 678', favourite: true, defaultAmountKesMajor: 1500, country: 'KE' },
      rail: 'MPESA',
    },
    {
      kind: 'TILL',
      input: { kind: 'TILL', displayName: 'SAFARI HARDWARE LTD', till: '33011', favourite: true, country: 'KE' },
      rail: 'MPESA_TILL',
    },
    {
      kind: 'PAYBILL',
      input: { kind: 'PAYBILL', displayName: 'NIAJI RIDE SCHOOL', paybill: '400211', accountReference: 'NR-2291', note: 'School fees, term 1', favourite: false, country: 'KE' },
      rail: 'MPESA_PAYBILL',
    },
  ];
  for (const entry of saved) {
    const record = recipients.upsert(users.customer, { ...entry.input, country: 'KE' } as Parameters<typeof recipients.upsert>[1], entry.rail);
    recipients.verify(record);
  }
}

function createMerchantAssets(users: SeededUsers, businesses: Array<{ id: string; name: string }>): void {
  const businessId = businesses[0]?.id;
  if (!businessId) return;
  links.create({
    userId: users.merchantOwner,
    businessId,
    title: 'MAMA WANJIKU SHOP — order payment',
    description: 'Pay for your basket. You send crypto, the shop receives KES on M-Pesa.',
    amountKesMajor: 2450,
    acceptedAssets: [...PAYABLE_ASSETS],
    settlementRail: 'MPESA_TILL',
    settlementTarget: '12345',
    allowPayerAmount: false,
    allowRepeat: true,
    publicNote: 'Demo link. Sandbox payments only — no money moves.',
  });
  links.create({
    userId: users.merchantOwner,
    businessId,
    title: 'Weekly supply invoice',
    description: 'Flexible amount: the payer chooses how much to send against this invoice.',
    acceptedAssets: ['USDT', 'USDC'],
    settlementRail: 'MPESA_TILL',
    settlementTarget: '12345',
    allowPayerAmount: true,
    maxUses: 5,
    expiresInHours: 24 * 14,
  });
  keys.create({
    userId: users.merchantOwner,
    businessId,
    name: 'Sandbox integration key',
    environment: 'test',
    scopes: ['write:payments', 'read:transactions', 'read:balances', 'write:refunds', 'read:webhooks', 'write:webhooks', 'write:links', 'read:links', 'write:quotes', 'read:quotes'],
  });
  webhooks.createEndpoint({
    userId: users.merchantOwner,
    businessId,
    url: 'http://localhost:4000/__devhook',
    description: 'Local sink started by `npm run dev` in the merchant app (sandbox only).',
    events: ['payment.completed', 'payment.failed', 'payment.refunded', 'payout.completed', 'payout.failed', 'quote.expired'],
    environment: 'test',
    secret: 'whsec_sandbox_demo_secret_do_not_use_in_production',
  });
}

/**
 * Past payments, produced by driving the real pipeline (not by inserting rows).
 * Slow by design: it costs a few seconds and it means the demo history cannot
 * disagree with the state machine, the ledger or the receipt.
 */
async function runDemoPayments(users: SeededUsers): Promise<number> {
  const db = getDb();
  const recipes: Array<{
    asset: PayableAsset;
    network: keyof typeof NETWORKS;
    amountKesMajor: number;
    kind: 'PHONE' | 'TILL' | 'PAYBILL';
    daysAgo: number;
    fail?: boolean;
    /** Pay a one-off demo recipient instead of a saved one (used by the rejection). */
    phone?: string;
  }> = [
    { asset: 'USDT', network: 'TRON', amountKesMajor: 1500, kind: 'PHONE', daysAgo: 1 },
    { asset: 'USDT', network: 'TRON', amountKesMajor: 2450, kind: 'TILL', daysAgo: 2 },
    { asset: 'USDC', network: 'ETHEREUM', amountKesMajor: 8200, kind: 'PAYBILL', daysAgo: 3 },
    { asset: 'USDT', network: 'TRON', amountKesMajor: 750, kind: 'TILL', daysAgo: 5 },
    { asset: 'BTC', network: 'BITCOIN', amountKesMajor: 12400, kind: 'PHONE', daysAgo: 8 },
    { asset: 'ETH', network: 'ETHEREUM', amountKesMajor: 4300, kind: 'PAYBILL', daysAgo: 11 },
    // Rejected by the simulated rail itself (the demo number ending 0000 is what
    // the sandbox provider refuses), so the failure, the compensating entries and
    // the recovery message all come from the real path rather than a forced write.
    { asset: 'USDT', network: 'TRON', amountKesMajor: 900, kind: 'PHONE', daysAgo: 14, fail: true, phone: '0700000000' },
    { asset: 'USDC', network: 'SOLANA', amountKesMajor: 2100, kind: 'PHONE', daysAgo: 17 },
  ];
  let completed = 0;
  for (const recipe of recipes) {
    // Prefer a *verified* saved recipient, newest first: the rejection demo below
    // deliberately creates an unverified one, and recipes must not inherit it by
    // accident just because it sorts last.
    let recipient = db.maybeOne<{ id: string; kind: string; display_name: string; phone: string | null }>(
      `SELECT id, kind, display_name, phone FROM payment_recipients
       WHERE user_id = ? AND kind = ?
       ORDER BY (verification_status = 'VERIFIED') DESC, created_at DESC LIMIT 1`,
      [users.customer, recipe.kind],
    );
    if (recipe.phone) {
      const saved = recipients.upsert(
        users.customer,
        { kind: 'PHONE', displayName: 'REJECTED DEMO NUMBER', phone: recipe.phone, favourite: false, country: 'KE' },
        'MPESA',
      );
      // Number ends 0000, which the sandbox name-resolution treats as unresolvable:
      // this row demonstrates the unverifiable-name warning *and* a rail rejection.
      recipient = { id: saved.id, kind: 'PHONE', display_name: saved.displayName, phone: saved.phone ?? null };
    }
    if (!recipient) continue;
    try {
      const quote = quotes.create({
        userId: users.customer,
        asset: recipe.asset,
        network: recipe.network as NetworkCode,
        kind: recipe.kind,
        recipientAmountKesMajor: recipe.amountKesMajor,
        recipientId: recipient.id,
        verifiedRecipient: !recipe.fail,
      });
      const created = await payments.create({
        userId: users.customer,
        quoteId: quote.quoteId,
        recipientId: recipient.id,
        strongConfirmation: true,
        note: 'Seeded demo payment',
      });
      const paymentId = created.payment.id;
      await sandboxAction(paymentId);
      const state = paymentRepo.byId(paymentId)?.status;
      if (state === 'COMPLETED' || state === 'FAILED') completed += 1;
      backdate(paymentId, recipe.daysAgo);
    } catch (error) {
      log.warn('demo payment skipped', { asset: recipe.asset, amount: recipe.amountKesMajor, error: (error as Error).message });
    }
  }
  return completed;
}

/**
 * Drive a demo payment the way production does — through the job queue, not by
 * calling the engine directly. The seeded history is only believable (and only
 * honest) if the payments in it really went through every state, receipts and
 * all, rather than being parked mid-flight by a seeding shortcut.
 */
async function sandboxAction(paymentId: string, budgetMs = 25_000): Promise<void> {
  await sandbox.simulateDeposit({ paymentId });
  // A time budget, not a fixed number of spins: the sandbox latencies are wall-clock
  // timers, so on a loaded machine a 60-iteration loop burns out before the simulated
  // confirmations are due and the history is left half-written.
  const deadline = Date.now() + budgetMs;
  for (;;) {
    await queue.sweep();
    await queue.runDue(40);
    const status = paymentRepo.byId(paymentId)?.status;
    if (status && ['COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED'].includes(status)) return;
    if (Date.now() > deadline) {
      log.warn('demo payment did not reach a final state within the seeding window', { paymentId, status });
      return;
    }
    await sleep(60);
  }
}

/**
 * Settle anything the per-payment windows left in flight before the seeded ledger is
 * judged. `ledger.verify()` compares cached wallet balances against liabilities, and a
 * payment mid-settlement legitimately has both sides outstanding — verifying then reports
 * a mismatch that disappears a second later. Verifying a calm database is the point.
 */
async function drainUntilSettled(budgetMs = 30_000): Promise<number> {
  const db = getDb();
  const openSql = `SELECT COUNT(*) AS c FROM payment_intents
     WHERE fee_snapshot LIKE '%Seeded demo payment%'
       AND status NOT IN ('COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED', 'EXPIRED')`;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const open = db.maybeOne<{ c: number }>(openSql)?.c ?? 0;
    if (open === 0 || Date.now() > deadline) return open;
    await queue.sweep();
    await queue.runDue(40);
    await sleep(150);
  }
}

function backdate(paymentId: string, daysAgo: number): void {
  if (daysAgo <= 0) return;
  const db = getDb();
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const row = paymentRepo.byId(paymentId);
  if (!row) return;
  const shift = Date.now() - new Date(row.created_at).getTime();
  void at;
  const completedAt = row.completed_at ? new Date(new Date(row.completed_at).getTime() - shift).toISOString() : null;
  withSeedBypass('demo corpus timestamps', () => db.tx(() => {
    db.run(`UPDATE payment_intents SET created_at = ?, updated_at = ?, completed_at = ?, expires_at = ? WHERE id = ?`, [
      new Date(new Date(row.created_at).getTime() - shift).toISOString(),
      new Date(new Date(row.updated_at).getTime() - shift).toISOString(),
      completedAt,
      isoIn(-60 * 60 * 24),
      paymentId,
    ]);
    db.run(
      `UPDATE payment_events SET created_at = datetime(created_at, ?) WHERE payment_intent_id = ?`,
      [`-${Math.round(shift / 1000)} seconds`, paymentId],
    );
    db.run(`UPDATE transactions SET created_at = ?, completed_at = ?, updated_at = ? WHERE payment_intent_id = ?`, [
      new Date(new Date(row.created_at).getTime() - shift).toISOString(),
      completedAt,
      new Date(new Date(row.updated_at).getTime() - shift).toISOString(),
      paymentId,
    ]);
    db.run(`UPDATE payouts SET created_at = ?, submitted_at = datetime(submitted_at, ?), confirmed_at = datetime(confirmed_at, ?) WHERE payment_intent_id = ?`, [
      new Date(new Date(row.created_at).getTime() - shift).toISOString(),
      `-${Math.round(shift / 1000)} seconds`,
      `-${Math.round(shift / 1000)} seconds`,
      paymentId,
    ]);
    // Booked-at times move with the payment, or the audit trail looks like the
    // money was booked before it was received.
    db.run(`UPDATE ledger_entries SET occurred_at = datetime(occurred_at, ?), created_at = datetime(created_at, ?) WHERE payment_intent_id = ?`, [
      `-${Math.round(shift / 1000)} seconds`,
      `-${Math.round(shift / 1000)} seconds`,
      paymentId,
    ]);
    db.run(`UPDATE ledger_journals SET occurred_at = datetime(occurred_at, ?), created_at = datetime(created_at, ?) WHERE payment_intent_id = ?`, [
      `-${Math.round(shift / 1000)} seconds`,
      `-${Math.round(shift / 1000)} seconds`,
      paymentId,
    ]);
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Print-ready summary for the CLI (`npm run seed`). */
export function describe(): string {
  const db = getDb();
  const balances = wallets.listWallets('');
  void balances;
  const kelvin = db.maybeOne<{ id: string; email: string; full_name: string }>(`SELECT id, email, full_name FROM users WHERE email = 'kelvin@aurapay.dev'`);
  const lines = [
    'AuraPay sandbox data ready.',
    '',
    `  demo account      ${kelvin?.email ?? 'kelvin@aurapay.dev'} / ${DEMO_PASSWORD}`,
    `  merchant account  amina@aurapay.dev / ${DEMO_PASSWORD}`,
    `  admin account     admin@aurapay.dev / ${DEMO_PASSWORD}`,
    '',
    '  Everything in this database is simulated: no real payment rail, chain or',
    '  identity check was contacted. Simulated rows are tagged data_origin=sandbox.',
    '',
  ];
  if (kelvin) {
    for (const wallet of wallets.listWallets(kelvin.id)) {
      lines.push(
        `  ${wallet.asset.padEnd(5)} ${wallet.network.padEnd(10)} available ${formatKesTo(wallet.available_minor, wallet.asset as PayableAsset)}`,
      );
    }
    const total = wallets.totalUsdFor(kelvin.id);
    lines.push('', `  total portfolio value (simulated): $${(Number(total) / 100).toFixed(2)}`);
  }
  lines.push('', `  float accounts: ${liquidity.listAccounts().length}`, `  ledger check: ${ledger.verify().length === 0 ? 'balanced' : 'PROBLEMS FOUND'}`, '');
  return lines.join('\n');
}

function formatKesTo(minor: string, asset: PayableAsset): string {
  const decimals = asset === 'BTC' ? 8 : asset === 'ETH' ? 18 : 6;
  const value = Number(BigInt(minor)) / 10 ** decimals;
  return `${value.toFixed(6).replace(/\.?0+$/, '')} ${asset}`;
}
