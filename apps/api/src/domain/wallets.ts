import {
  DomainError,
  NETWORKS,
  PAYABLE_ASSETS,
  formatAmount,
  mulDiv,
  unitOf,
  type AssetCode,
  type NetworkCode,
  type PayableAsset,
  RATE_SCALE,
} from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, nowIso } from '../lib/ids.js';
import { tryRate } from './fx.js';
import { accountForUser, postJournal, sumSigned, treasuryAccount } from './ledger.js';
import { pseudoAddress } from './blockchain.js';
import { publish } from './realtime.js';
import { createLogger } from '../logger.js';
import { insert } from '../db/rows.js';

const log = createLogger('wallets');

/**
 * Wallet layer — the *cache* of customer balances.
 *
 * The ledger is the source of truth; `wallets.available_minor` /
 * `reserved_minor` are projections maintained by the same transactions that
 * post the journals, and `ledger.verify()` proves they agree on every run.
 *
 * Two custody models behind one interface:
 *   - CUSTODIAL: the customer holds a claim (USER:{id}:CRYPTO:{ASSET} liability)
 *     and the custody partner's wallet holds the keys.
 *   - EXTERNAL: no balance is recorded; the payer signs from their own wallet
 *     and AuraPay only watches a deposit address for that one payment.
 *
 * Private keys never exist in this process, and no plaintext key material is
 * ever accepted by an API.
 */

export interface WalletRow {
  id: string;
  user_id: string | null;
  business_id: string | null;
  kind: 'CUSTODIAL' | 'EXTERNAL' | 'TREASURY' | 'FEE' | 'SETTLEMENT';
  label: string | null;
  asset: string;
  network: string;
  available_minor: string;
  reserved_minor: string;
  address: string | null;
  custody_mode: string;
  data_origin: string;
  status: string;
  updated_at: string;
}

function addressKind(network: NetworkCode): 'evm' | 'tron' | 'solana' | 'bitcoin' {
  return NETWORKS[network]?.addressKind ?? 'evm';
}

export function listWallets(userId: string): WalletRow[] {
  return getDb().all<WalletRow>(
    `SELECT * FROM wallets WHERE user_id = ? AND kind = 'CUSTODIAL' ORDER BY asset, network`,
    [userId],
  );
}

export function walletFor(userId: string, asset: AssetCode, network: NetworkCode): WalletRow | null {
  return (
    getDb().maybeOne<WalletRow>(
      `SELECT * FROM wallets WHERE user_id = ? AND asset = ? AND network = ? AND kind = 'CUSTODIAL' AND status = 'ACTIVE'
       ORDER BY id LIMIT 1`,
      [userId, asset, network],
    ) ?? null
  );
}

export function ensureWallet(userId: string, asset: PayableAsset, network: NetworkCode, label?: string): WalletRow {
  const db = getDb();
  const existing = walletFor(userId, asset, network);
  if (existing) return existing;
  const walletId = id('wal');
  const now = nowIso();
  const address = pseudoAddress(addressKind(network), `${network}:${asset}:${userId}`);
  insert('wallets', {
    id: walletId,
    user_id: userId,
    business_id: null,
    kind: 'CUSTODIAL',
    label: label ?? `${asset} · ${NETWORKS[network]?.shortName ?? network}`,
    asset,
    network,
    available_minor: '0',
    reserved_minor: '0',
    address,
    address_index: null,
    custody_mode: config.isProduction ? 'partner' : 'sandbox_simulated',
    data_origin: config.isSandbox ? 'sandbox' : 'live',
    status: 'ACTIVE',
    created_at: now,
    updated_at: now,
  });
  return db.one<WalletRow>('SELECT * FROM wallets WHERE id = ?', [walletId]);
}

export interface BalanceChangeResult {
  ok: boolean;
  reason?: string;
  availableMinor?: bigint;
}

/**
 * Moves a quote total from `available` to `reserved`. Called inside the same
 * database transaction as the ledger journal, so a balance can never move
 * without its double-entry record (and vice versa).
 */
export function hold(input: {
  userId: string;
  asset: AssetCode;
  network: NetworkCode;
  amountMinor: bigint;
}): BalanceChangeResult {
  const db = getDb();
  if (input.amountMinor <= 0n) return { ok: false, reason: 'amount must be positive', availableMinor: 0n };
  const wallet = walletFor(input.userId, input.asset, input.network);
  if (!wallet) {
    return { ok: false, reason: `no ${input.asset} wallet on ${input.network} for this account`, availableMinor: 0n };
  }
  const available = BigInt(wallet.available_minor);
  if (available < input.amountMinor) {
    return {
      ok: false,
      reason: `needs ${formatAmount(input.amountMinor, input.asset)} ${input.asset}, ${formatAmount(available, input.asset)} ${input.asset} available`,
      availableMinor: available,
    };
  }
  db.run(
    `UPDATE wallets
     SET available_minor = CAST((CAST(available_minor AS INTEGER) - CAST(? AS INTEGER)) AS TEXT),
         reserved_minor  = CAST((CAST(reserved_minor AS INTEGER) + CAST(? AS INTEGER)) AS TEXT),
         updated_at = ?
     WHERE id = ?`,
    [input.amountMinor.toString(), input.amountMinor.toString(), nowIso(), wallet.id],
  );
  return { ok: true, availableMinor: available };
}

export function releaseHold(input: { userId: string; asset: AssetCode; network: NetworkCode; amountMinor: bigint }): void {
  const db = getDb();
  if (input.amountMinor <= 0n) return;
  const wallet = walletFor(input.userId, input.asset, input.network);
  if (!wallet) return;
  db.run(
    `UPDATE wallets
     SET reserved_minor = CAST(MAX(0, CAST(reserved_minor AS INTEGER) - CAST(? AS INTEGER)) AS TEXT),
         available_minor = CAST(CAST(available_minor AS INTEGER) + CAST(? AS INTEGER) AS TEXT),
         updated_at = ?
     WHERE id = ?`,
    [input.amountMinor.toString(), input.amountMinor.toString(), nowIso(), wallet.id],
  );
  publish(`user:${input.userId}`, 'balances', 'balances.changed', { asset: input.asset, network: input.network });
}

/** Reserved → gone (payment succeeded). */
export function consumeHold(input: { userId: string; asset: AssetCode; network: NetworkCode; amountMinor: bigint }): void {
  const db = getDb();
  if (input.amountMinor <= 0n) return;
  const wallet = walletFor(input.userId, input.asset, input.network);
  if (!wallet) return;
  db.run(
    `UPDATE wallets
     SET reserved_minor = CAST(MAX(0, CAST(reserved_minor AS INTEGER) - CAST(? AS INTEGER)) AS TEXT), updated_at = ?
     WHERE id = ?`,
    [input.amountMinor.toString(), nowIso(), wallet.id],
  );
  publish(`user:${input.userId}`, 'balances', 'balances.changed', { asset: input.asset, network: input.network });
}

/** Money arriving in a customer wallet (deposit detection, refund, sandbox top-up). */
export function credit(input: {
  userId: string;
  asset: AssetCode;
  network: NetworkCode;
  amountMinor: bigint;
}): WalletRow {
  const db = getDb();
  if (input.amountMinor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Credit amount must be positive.');
  const wallet =
    walletFor(input.userId, input.asset, input.network) ??
    (PAYABLE_ASSETS.includes(input.asset as PayableAsset)
      ? ensureWallet(input.userId, input.asset as PayableAsset, input.network)
      : null);
  if (!wallet) throw new DomainError('NOT_FOUND', `No ${input.asset} wallet on ${input.network} for this account.`);
  db.run(
    `UPDATE wallets
     SET available_minor = CAST(CAST(available_minor AS INTEGER) + CAST(? AS INTEGER) AS TEXT), updated_at = ?
     WHERE id = ?`,
    [input.amountMinor.toString(), nowIso(), wallet.id],
  );
  publish(`user:${input.userId}`, 'balances', 'balances.changed', { asset: input.asset, network: input.network });
  return db.one<WalletRow>('SELECT * FROM wallets WHERE id = ?', [wallet.id]);
}

/**
 * The mirror of `credit`: take an amount back out of a wallet's available balance.
 *
 * This exists because a reversal has two sides. When a payment fails after its deposit
 * was booked, the compensating journal already removed the credit from the customer's
 * liability in the books — but the cache is what the UI, the balance endpoint and the
 * next payment all read. Without this call the customer keeps money the ledger says they
 * never had, and `verify:ledger` reports a wallet above its liability forever.
 *
 * Clamped at zero on purpose: a negative cached balance would be displayed as a real
 * balance everywhere it is read, so the clamp plus this warning is the lesser evil, and
 * reconcile() is the tool that tells us when it happened.
 */
export function debit(input: {
  userId: string;
  asset: AssetCode;
  network: NetworkCode;
  amountMinor: bigint;
  reason?: string;
}): WalletRow {
  const db = getDb();
  if (input.amountMinor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Debit amount must be positive.');
  const wallet = walletFor(input.userId, input.asset, input.network);
  if (!wallet) throw new DomainError('NOT_FOUND', `No ${input.asset} wallet on ${input.network} for this account.`);
  const available = BigInt(wallet.available_minor);
  if (available < input.amountMinor) {
    log.warn('debit clamped to the cached balance', {
      userId: input.userId,
      asset: input.asset,
      network: input.network,
      requested: input.amountMinor.toString(),
      cached: available.toString(),
      reason: input.reason ?? '',
    });
  }
  db.run(
    `UPDATE wallets
     SET available_minor = CAST(MAX(0, CAST(available_minor AS INTEGER) - CAST(? AS INTEGER)) AS TEXT), updated_at = ?
     WHERE id = ?`,
    [input.amountMinor.toString(), nowIso(), wallet.id],
  );
  publish(`user:${input.userId}`, 'balances', 'balances.changed', { asset: input.asset, network: input.network });
  return db.one<WalletRow>('SELECT * FROM wallets WHERE id = ?', [wallet.id]);
}

/**
 * Opening balance for a seeded/simulated wallet. In production the equivalent
 * event is "deposit confirmed on chain", posted by the deposits watcher.
 */
export function openBalance(input: {
  userId: string;
  asset: PayableAsset;
  network: NetworkCode;
  amountMinor: bigint;
  memo: string;
  paymentIntentId?: string | null;
}): void {
  const db = getDb();
  if (input.amountMinor <= 0n) return;
  db.tx(() => {
    const wallet = ensureWallet(input.userId, input.asset, input.network);
    db.run(
      `UPDATE wallets SET available_minor = CAST(CAST(available_minor AS INTEGER) + CAST(? AS INTEGER) AS TEXT), updated_at = ? WHERE id = ?`,
      [input.amountMinor.toString(), nowIso(), wallet.id],
    );
    postJournal({
      group: `opening:${input.userId}:${input.asset}`,
      asset: input.asset,
      paymentIntentId: input.paymentIntentId ?? null,
      memo: input.memo,
      entries: [
        {
          accountCode: treasuryAccount(input.asset, input.network, 'CUSTODY'),
          direction: 'DEBIT',
          asset: input.asset,
          amountMinor: input.amountMinor,
          code: 'TREASURY_CRYPTO_DEBIT',
          memo: input.memo,
        },
        {
          accountCode: accountForUser(input.userId, input.asset),
          direction: 'CREDIT',
          asset: input.asset,
          amountMinor: input.amountMinor,
          code: 'USER_CRYPTO_CREDIT',
          memo: input.memo,
        },
      ],
    });
  });
  log.info('opening balance posted', { user: input.userId, asset: input.asset, amount: input.amountMinor.toString() });
}

/**
 * Dashboard balances with KES equivalents. `dataOrigin` is explicit so the UI
 * labels simulated fixtures instead of implying a live exchange read.
 */
export function balancesFor(userId: string) {
  const db = getDb();
  const wallets = listWallets(userId);
  const usdKes = tryRate('USD', 'KES');
  const items = wallets.map((w) => {
    const asset = w.asset as AssetCode;
    const available = BigInt(w.available_minor);
    const reserved = BigInt(w.reserved_minor);
    const total = available + reserved;
    const rate = tryRate(asset, 'KES');
    const kesPerUnit = rate?.midRateScaled ?? 0n;
    const kesValue = kesPerUnit > 0n ? mulDiv(total * unitOf('KES'), kesPerUnit, unitOf(asset) * RATE_SCALE) : 0n;
    const assetRow = db.maybeOne<{ change24h_bps: number; usd_price_minor: string }>(
      'SELECT change24h_bps, usd_price_minor FROM assets WHERE code = ?',
      [asset],
    );
    return {
      asset,
      network: w.network as NetworkCode,
      availableMinor: available.toString(),
      reservedMinor: reserved.toString(),
      totalMinor: total.toString(),
      usdValueMinor: usdValueMinor(asset, total).toString(),
      kesValueMinor: kesValue.toString(),
      change24hPct: (assetRow?.change24h_bps ?? 0) / 100,
      unitPriceKes: rateNumber(kesPerUnit),
      custodial: w.kind === 'CUSTODIAL',
      custodyMode: w.custody_mode,
      label: w.label,
      address: w.address,
      dataOrigin: (w.data_origin === 'live' ? 'live' : 'sandbox') as 'sandbox' | 'live',
    };
  });
  const totalUsd = items.reduce<bigint>((acc, i) => acc + BigInt(i.usdValueMinor), 0n);
  return {
    totalUsdMinor: totalUsd.toString(),
    totalKesMinor: usdToKesMinor(totalUsd).toString(),
    referenceRateKesPerUsd: usdKes ? rateNumber(usdKes.midRateScaled) : '0',
    wallets: items,
    computedAt: nowIso(),
    dataOrigin: (usdKes && !usdKes.isSimulated ? 'live' : 'sandbox') as 'sandbox' | 'live',
  };
}

export function totalUsdFor(userId: string): bigint {
  return balancesFor(userId).wallets.reduce<bigint>((acc, w) => acc + BigInt(w.usdValueMinor), 0n);
}

function rateNumber(scaled: bigint): string {
  if (scaled <= 0n) return '0';
  return (Number(scaled) / Number(RATE_SCALE)).toFixed(4);
}

function usdValueMinor(asset: AssetCode, minor: bigint): bigint {
  if (asset === 'USDT' || asset === 'USDC') return mulDiv(minor, 1n, unitOf(asset) / unitOf('USD'));
  const priceRow = getDb().maybeOne<{ usd_price_minor: string }>('SELECT usd_price_minor FROM assets WHERE code = ?', [asset]);
  const cents = BigInt(priceRow?.usd_price_minor ?? '0');
  if (cents === 0n) return 0n;
  return mulDiv(minor, cents, unitOf(asset));
}

function usdToKesMinor(usdMinor: bigint): bigint {
  const rate = tryRate('USD', 'KES');
  if (!rate) return 0n;
  return mulDiv(usdMinor * unitOf('KES'), rate.midRateScaled, RATE_SCALE * unitOf('USD'));
}

/** Deposit address scoped to a single payment (custody partner in production). */
export function depositAddressFor(input: {
  userId: string;
  network: NetworkCode;
  asset: AssetCode;
  paymentIntentId: string;
}): { address: string; memo: string | null; simulated: boolean } {
  const wallet = walletFor(input.userId, input.asset, input.network);
  const simulated = !config.isProduction;
  const address =
    wallet?.address ?? pseudoAddress(addressKind(input.network), `${input.network}:${input.asset}:${input.paymentIntentId}`);
  return {
    address,
    memo: input.network === 'SOLANA' ? input.paymentIntentId.replace(/^pi_/, '').slice(0, 8).toUpperCase() : null,
    simulated,
  };
}

/** Reconciles the cached wallet balance with the ledger liability. */
/** Cached wallet balance vs the ledger liability that must agree with it. */
export function reconcile(userId: string): Array<{ asset: string; network: string; cached: bigint; ledger: bigint; delta: bigint }> {
  return listWallets(userId).map((w) => {
    const cached = BigInt(w.available_minor) + BigInt(w.reserved_minor);
    const liability = sumSigned(accountForUser(userId, w.asset as AssetCode), w.asset as AssetCode);
    return { asset: w.asset, network: w.network, cached, ledger: liability, delta: cached - liability };
  });
}

export function linkExternalWallet(input: { userId: string; asset: PayableAsset; network: NetworkCode; address: string; label: string }): { id: string } {
  const db = getDb();
  const walletId = id('wal');
  insert('wallets', {
    id: walletId,
    user_id: input.userId,
    business_id: null,
    kind: 'EXTERNAL',
    label: input.label,
    asset: input.asset,
    network: input.network,
    available_minor: '0',
    reserved_minor: '0',
    address: input.address,
    custody_mode: 'self_custody',
    data_origin: 'live',
    status: 'LINKED',
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  return { id: walletId };
}

export function unlinkWallet(userId: string, walletId: string): void {
  const db = getDb();
  const row = db.maybeOne<{ kind: string }>('SELECT kind FROM wallets WHERE id = ? AND user_id = ?', [walletId, userId]);
  if (!row) throw new DomainError('NOT_FOUND', 'That wallet is not linked to this account.');
  if (row.kind === 'CUSTODIAL') throw new DomainError('CONFLICT', 'Custodial balances cannot be unlinked; withdraw the funds first.');
  db.run('UPDATE wallets SET status = ? , updated_at = ? WHERE id = ?', ['UNLINKED', nowIso(), walletId]);
}

export function listExternalWallets(userId: string) {
  return getDb()
    .all<{ id: string; asset: string; network: string; label: string | null; address: string | null; status: string; created_at: string }>(
      `SELECT id, asset, network, label, address, status, created_at FROM wallets WHERE user_id = ? AND kind = 'EXTERNAL' ORDER BY created_at DESC`,
      [userId],
    )
    .map((w) => ({
      id: w.id,
      asset: w.asset,
      network: w.network,
      label: w.label,
      address: w.address,
      status: w.status,
      createdAt: w.created_at,
    }));
}
