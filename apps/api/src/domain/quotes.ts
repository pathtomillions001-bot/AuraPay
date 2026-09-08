import {
  DomainError,
  NETWORKS,
  RAILS,
  RAIL_SURCHARGES,
  applyBps,
  feeSchedule,
  mulDiv,
  parseAmount,
  quoteTtl,
  unitOf,
  type AssetCode,
  type NetworkCode,
  type PayableAsset,
  type RailCode,
  RATE_SCALE,
  HIGH_VALUE_THRESHOLD_KES,
  formatAmount,
  messageFor,
} from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, isoIn, nowIso } from '../lib/ids.js';
import { getRate, type RateSnapshot } from './fx.js';
import { plan, type RoutePlan, type RoutingRequest } from './routing.js';
import { viewFor } from './liquidity.js';
import { quoteRiskHint } from './compliance.js';
import { createLogger } from '../logger.js';
import { insert } from '../db/rows.js';
import { stringify } from '../lib/json.js';

const log = createLogger('quotes');

/**
 * Quote engine.
 *
 * `quote = (what the recipient gets) + (every cost to deliver it)`, priced at a
 * *fresh* reference rate, frozen for a TTL. Three properties are structural, not
 * conventional:
 *
 *  1. **Freshness** — `getRate()` throws `QUOTE_STALE_RATE` if the newest rate is
 *     older than `maxRateAgeMs`, so a quote can never be built on stale pricing.
 *  2. **No hidden spread** — the spread is applied to the rate, disclosed in bps,
 *     and both the mid-market and the applied rate are returned.
 *  3. **Immutability** — once issued, a quote's numbers never change. A refresh
 *     mints a new quote id and marks the old one `INVALIDATED`, so a client can
 *     never confirm against a rate it did not see.
 */

export interface QuoteInput {
  userId: string;
  asset: PayableAsset;
  network?: NetworkCode;
  rail?: RailCode;
  kind?: RoutingRequest['kind'];
  country?: string;
  /** Either the amount the recipient should receive… */
  recipientAmountKesMajor?: number;
  /** …or the amount of crypto the payer wants to spend. */
  payAmountMinor?: string;
  recipientId?: string | null;
  businessId?: string | null;
  /** Optional: merchant QR/link settlement target overrides. */
  settlementRailOverride?: RailCode;
  verifiedRecipient?: boolean;
  riskLevelOverride?: 'LOW' | 'MEDIUM' | 'HIGH' | 'SEVERE';
}

export interface Quote {
  quoteId: string;
  status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'INVALIDATED';
  userId: string;
  asset: AssetCode;
  network: NetworkCode;
  rail: RailCode;
  recipientCountry: string;
  recipientCurrency: string;
  recipientAmountMinor: bigint;
  cryptoAmountMinor: bigint;
  networkFeeMinor: bigint;
  serviceFeeMinor: bigint;
  totalDebitMinor: bigint;
  providerSurchargeMinor: bigint;
  fxRate: bigint;
  midRate: bigint;
  feeBps: number;
  spreadBps: number;
  platformFeeKesMinor: bigint;
  railSurchargeMinor: bigint;
  route: RoutePlan;
  liquidity: { sufficient: boolean; availableMinor: bigint; requiredMinor: bigint; queuedIfInsufficient: boolean };
  riskHint: { level: 'LOW' | 'MEDIUM' | 'HIGH' | 'SEVERE'; reasons: string[] };
  createdAt: string;
  expiresAt: string;
  ttlSeconds: number;
  dataOrigin: 'sandbox' | 'live';
  estimatedSettlementSeconds: number;
  disclaimer: string;
}

interface QuoteRow {
  id: string;
  user_id: string | null;
  status: string;
  asset: string;
  network: string;
  rail: string;
  recipient_country: string;
  recipient_currency: string;
  recipient_amount_minor: string;
  crypto_amount_minor: string;
  network_fee_minor: string;
  service_fee_minor: string;
  total_debit_minor: string;
  fx_rate_scaled: string;
  mid_rate_scaled: string;
  fee_snapshot: string;
  route_snapshot: string;
  liquidity_snapshot: string;
  risk_hint: string;
  ttl_seconds: number;
  created_at: string;
  expires_at: string;
  mode: string;
  data_origin: string;
  invalidated_reason: string | null;
}

/** KES minor → asset minor at an applied (spread-inclusive) rate. */
export function kesToAssetMinor(kesMinor: bigint, rateScaled: bigint, asset: AssetCode): bigint {
  return mulDiv(kesMinor * unitOf(asset) * RATE_SCALE, 1n, rateScaled * unitOf('KES'));
}

/** Asset minor → KES minor at an applied rate. */
export function assetToKesMinor(assetMinor: bigint, rateScaled: bigint, asset: AssetCode): bigint {
  return mulDiv(assetMinor * rateScaled * unitOf('KES'), 1n, unitOf(asset) * RATE_SCALE);
}

/** USD-cents → asset minor units, used for on-chain fee estimates. */
function usdCentsToAssetMinor(cents: number, asset: AssetCode, usdKesRate: RateSnapshot, assetKesRate: bigint): bigint {
  const usdMinor = BigInt(cents);
  const kesMinor = mulDiv(usdMinor * unitOf('KES'), usdKesRate.rateScaled, RATE_SCALE * unitOf('USD'));
  return mulDiv(kesMinor * unitOf(asset), RATE_SCALE, assetKesRate * unitOf('KES'));
}

export function create(input: QuoteInput): Quote {
  const db = getDb();
  const asset = input.asset;
  const definition = NETWORKS[input.network ?? defaultNetwork(asset)] ? input.network ?? defaultNetwork(asset) : defaultNetwork(asset);
  const schedule = feeSchedule(asset, definition);
  const country = input.country ?? 'KE';

  // 1. target amount
  let recipientAmountMinor: bigint;
  if (input.recipientAmountKesMajor !== undefined) {
    recipientAmountMinor = BigInt(Math.round(input.recipientAmountKesMajor * Number(unitOf('KES'))));
  } else if (input.payAmountMinor) {
    // "Send exactly N USDT": the recipient receives what is left after rail cost,
    // platform fee and network fee. Derived from the same applied rate.
    const payMinor = parseAmount(input.payAmountMinor, asset);
    const preview = getRate(asset, 'KES');
    const previewApplied = mulDiv(
      (preview.midRateScaled > 0n ? preview.midRateScaled : preview.rateScaled),
      RATE_SCALE - BigInt(feeSchedule(asset, definition).spreadBps) * (RATE_SCALE / 10_000n),
      RATE_SCALE,
    );
    const feesMinor =
      kesToAssetMinor(maxBigInt(applyBps(payMinor, feeSchedule(asset, definition).platformFeeBps), BigInt(feeSchedule(asset, definition).platformFeeMinKes) * unitOf('KES')), previewApplied, asset) +
      usdCentsToAssetMinor(networkFeeCents(definition, asset), asset, getRate('USD', 'KES'), previewApplied);
    const netMinor = payMinor - feesMinor;
    if (netMinor <= 0n) {
      throw new DomainError('INSUFFICIENT_FUNDS', `At least ${formatAmount(feesMinor, asset)} ${asset} of that is fees — send more, or switch to setting the amount the recipient receives.`, {
        feesMinor: feesMinor.toString(),
      });
    }
    const grossKes = assetToKesMinor(netMinor, previewApplied, asset);
    // Gross it down by the rail's own cost, which the router finalises below.
    recipientAmountMinor = maxBigInt(subtractRailCost(grossKes, input, definition), 1n);
  } else {
    throw new DomainError('VALIDATION_FAILED', 'Enter either the amount the recipient receives or the amount you pay.');
  }

  if (recipientAmountMinor <= 0n) {
    throw new DomainError('VALIDATION_FAILED', 'The amount must be greater than zero.');
  }

  const routing = plan({
    asset,
    network: definition,
    kind: input.kind ?? 'PHONE',
    country,
    railHint: input.rail,
    amountMinor: recipientAmountMinor,
    currency: 'KES',
    riskLevel: input.riskLevelOverride,
    settlementRailOverride: input.settlementRailOverride,
    userId: input.userId,
  });

  const railDef = RAILS[routing.rail]!;
  if (recipientAmountMinor < BigInt(railDef.minAmountLocal * 100)) {
    throw new DomainError('VALIDATION_FAILED', `${railDef.name} payouts start at KES ${railDef.minAmountLocal}.`, {
      rail: routing.rail,
      minimumKes: railDef.minAmountLocal,
    });
  }
  if (recipientAmountMinor > BigInt(railDef.maxAmountLocal * 100)) {
    throw new DomainError(
      'LIMIT_EXCEEDED',
      `KES ${formatKESMajor(recipientAmountMinor)} exceeds the KES ${railDef.maxAmountLocal.toLocaleString('en-KE')} maximum for ${railDef.name}. Split the payment or use a bank payout.`,
      { rail: routing.rail, maximumKes: railDef.maxAmountLocal },
    );
  }

  // 2. pricing — getRate() is the fail-closed gate on staleness
  const assetRate = getRate(asset, 'KES');
  const usdRate = getRate('USD', 'KES');
  const mid = assetRate.midRateScaled > 0n ? assetRate.midRateScaled : assetRate.rateScaled;
  const applied = mulDiv(mid, RATE_SCALE - BigInt(schedule.spreadBps) * (RATE_SCALE / 10_000n), RATE_SCALE);
  if (applied <= 0n) throw new DomainError('QUOTE_STALE_RATE', 'Pricing is unavailable for this asset right now.');

  // 3. fees
  const providerSurchargeMinor = applyBps(recipientAmountMinor, routing.feeBps + railDef.providerFeeBps) + BigInt(railDef.providerFixedFeeMinor);
  const platformFeeKesMinor = maxBigInt(applyBps(recipientAmountMinor, schedule.platformFeeBps), BigInt(schedule.platformFeeMinKes) * unitOf('KES'));
  const railSurcharge = BigInt(RAIL_SURCHARGES[routing.rail] ?? schedule.railSurchargeMinor ?? 0);
  const kesToAsset = (kesMinor: bigint): bigint => kesToAssetMinor(kesMinor, applied, asset);

  const deliverableMinor = recipientAmountMinor + providerSurchargeMinor + railSurcharge;
  const cryptoPrincipalMinor = kesToAsset(deliverableMinor);
  const serviceFeeMinor = kesToAsset(platformFeeKesMinor);
  const networkFeeMinor = usdCentsToAssetMinor(
    networkFeeCents(definition, asset),
    asset,
    usdRate,
    applied,
  );
  const cryptoAmountMinor = cryptoPrincipalMinor;
  const totalDebitMinor = cryptoPrincipalMinor + serviceFeeMinor + networkFeeMinor;

  // 4. available balance must cover the total
  const wallet = db.maybeOne<{ available_minor: string }>(
    `SELECT available_minor FROM wallets WHERE user_id = ? AND asset = ? AND network = ? AND kind = 'CUSTODIAL' AND status = 'ACTIVE'
     ORDER BY id LIMIT 1`,
    [input.userId, asset, definition],
  );
  const available = BigInt(wallet?.available_minor ?? '0');
  if (available < totalDebitMinor) {
    throw new DomainError(
      'INSUFFICIENT_FUNDS',
      `This payment needs ${formatAmount(totalDebitMinor, asset)} ${asset} including fees, and your ${definition} wallet has ${formatAmount(available, asset)} ${asset} available.`,
      {
        requiredMinor: totalDebitMinor.toString(),
        availableMinor: available.toString(),
        asset,
        network: definition,
      },
    );
  }

  // 5. liquidity must exist for the payout we are promising
  const float = viewFor(routing.rail, 'KES');
  const requiredFloat = deliverableMinor;
  const liquidity = {
    sufficient: (float?.availableMinor ?? 0n) >= requiredFloat,
    availableMinor: float?.availableMinor ?? 0n,
    requiredMinor: requiredFloat,
    queuedIfInsufficient: config.liquidity.allowQueueOnInsufficient,
  };

  // 6. risk hint so the UI can warn *before* the payer commits
  const riskHint = quoteRiskHint({
    userId: input.userId,
    asset,
    amountMinor: recipientAmountMinor,
    rail: routing.rail,
    recipientVerified: input.verifiedRecipient ?? false,
    network: definition,
  });

  const ttl = quoteTtl(Number(recipientAmountMinor / unitOf('KES')));
  const quoteId = id('Q');
  const createdAt = nowIso();
  const expiresAt = isoIn(ttl);

  const quote: Quote = {
    quoteId,
    status: 'ACTIVE',
    userId: input.userId,
    asset,
    network: definition,
    rail: routing.rail,
    recipientCountry: country,
    recipientCurrency: 'KES',
    recipientAmountMinor,
    cryptoAmountMinor,
    networkFeeMinor,
    serviceFeeMinor,
    totalDebitMinor,
    providerSurchargeMinor,
    fxRate: applied,
    midRate: mid,
    feeBps: schedule.platformFeeBps,
    spreadBps: schedule.spreadBps,
    platformFeeKesMinor,
    railSurchargeMinor: railSurcharge,
    route: routing,
    liquidity,
    riskHint,
    createdAt,
    expiresAt,
    ttlSeconds: ttl,
    dataOrigin: assetRate.isSimulated ? 'sandbox' : 'live',
    estimatedSettlementSeconds: routing.estimatedSettlementSeconds,
    disclaimer: config.isSandbox
      ? 'Sandbox quote — pricing comes from a simulated reference feed and no value moves.'
      : 'Quote locked for the displayed window. Unconfirmed after expiry; a new quote is required.',
  };

  insert('quotes', {
    id: quoteId,
    user_id: input.userId,
    business_id: input.businessId ?? null,
    asset,
    network: definition,
    rail: routing.rail,
    recipient_country: country,
    recipient_currency: 'KES',
    recipient_amount_minor: recipientAmountMinor.toString(),
    crypto_amount_minor: cryptoAmountMinor.toString(),
    network_fee_minor: networkFeeMinor.toString(),
    service_fee_minor: serviceFeeMinor.toString(),
    total_debit_minor: totalDebitMinor.toString(),
    fx_rate_scaled: applied.toString(),
    mid_rate_scaled: mid.toString(),
    fee_snapshot: stringify({
      platformFeeBps: schedule.platformFeeBps,
      platformFeeMinKes: schedule.platformFeeMinKes,
      spreadBps: schedule.spreadBps,
      platformFeeKesMinor: platformFeeKesMinor.toString(),
      providerSurchargeMinor: providerSurchargeMinor.toString(),
      railSurchargeMinor: railSurcharge.toString(),
      railFeeBps: railDef.providerFeeBps,
      feeSource: 'fee_schedule_v1',
    }),
    route_snapshot: stringify(routing),
    liquidity_snapshot: stringify(liquidity),
    risk_hint: stringify(riskHint),
    status: 'ACTIVE',
    mode: config.mode,
    data_origin: assetRate.isSimulated ? 'sandbox' : 'live',
    ttl_seconds: ttl,
    created_at: createdAt,
    expires_at: expiresAt,
  });

  log.info('quote created', {
    quoteId,
    asset,
    network: definition,
    rail: routing.rail,
    recipient: recipientAmountMinor.toString(),
    total: totalDebitMinor.toString(),
    ttl,
    origin: quote.dataOrigin,
  });
  return quote;
}

/** Read + validate usability (status, expiry, ownership). */
export function get(quoteId: string, userId?: string): Quote {
  const db = getDb();
  const row = db.maybeOne<QuoteRow>('SELECT * FROM quotes WHERE id = ?', [quoteId]);
  if (!row) throw new DomainError('QUOTE_NOT_FOUND');
  if (userId && row.user_id !== userId) throw new DomainError('FORBIDDEN', 'This quote belongs to another account.');
  const quote = hydrate(row);
  if (quote.status === 'ACTIVE' && new Date(quote.expiresAt).getTime() <= Date.now()) {
    db.run(`UPDATE quotes SET status = 'EXPIRED' WHERE id = ? AND status = 'ACTIVE'`, [quoteId]);
    quote.status = 'EXPIRED';
  }
  return quote;
}

function hydrate(row: QuoteRow): Quote {
  const fees = JSON.parse(row.fee_snapshot) as Record<string, string | number>;
  return {
    quoteId: row.id,
    status: row.status as Quote['status'],
    userId: row.user_id ?? '',
    asset: row.asset as AssetCode,
    network: row.network as NetworkCode,
    rail: row.rail as RailCode,
    recipientCountry: row.recipient_country,
    recipientCurrency: row.recipient_currency,
    recipientAmountMinor: BigInt(row.recipient_amount_minor),
    cryptoAmountMinor: BigInt(row.crypto_amount_minor),
    networkFeeMinor: BigInt(row.network_fee_minor),
    serviceFeeMinor: BigInt(row.service_fee_minor),
    totalDebitMinor: BigInt(row.total_debit_minor),
    providerSurchargeMinor: BigInt(String(fees.providerSurchargeMinor ?? '0')),
    fxRate: BigInt(row.fx_rate_scaled),
    midRate: BigInt(row.mid_rate_scaled),
    feeBps: Number(fees.platformFeeBps ?? 0),
    spreadBps: Number(fees.spreadBps ?? 0),
    platformFeeKesMinor: BigInt(String(fees.platformFeeKesMinor ?? '0')),
    railSurchargeMinor: BigInt(String(fees.railSurchargeMinor ?? '0')),
    route: JSON.parse(row.route_snapshot) as RoutePlan,
    liquidity: JSON.parse(row.liquidity_snapshot) as Quote['liquidity'],
    riskHint: JSON.parse(row.risk_hint) as Quote['riskHint'],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ttlSeconds: row.ttl_seconds,
    dataOrigin: row.data_origin === 'live' ? 'live' : 'sandbox',
    estimatedSettlementSeconds: Number((JSON.parse(row.route_snapshot) as RoutePlan).estimatedSettlementSeconds ?? 0),
    disclaimer:
      row.data_origin === 'live'
        ? 'Quote locked for the displayed window.'
        : 'Sandbox quote — pricing comes from a simulated reference feed and no value moves.',
  };
}

/**
 * Atomic consumption: exactly one payment may be created from a quote.
 * Also guards against the two failure modes that matter in production:
 *   - the fee environment moved (network gas spike) → force a re-quote
 *   - the balance moved (concurrent spend)           → INSUFFICIENT_FUNDS
 */
export function consume(quoteId: string, userId: string): Quote {
  const db = getDb();
  const quote = get(quoteId, userId);
  if (quote.status !== 'ACTIVE') {
    throw new DomainError(quote.status === 'EXPIRED' ? 'QUOTE_EXPIRED' : 'CONFLICT', messageFor(quote.status === 'EXPIRED' ? 'QUOTE_EXPIRED' : 'CONFLICT'), {
      quoteStatus: quote.status,
    });
  }
  const currentNetworkFee = usdCentsToAssetMinor(
    networkFeeCents(quote.network, quote.asset),
    quote.asset,
    getRate('USD', 'KES'),
    quote.fxRate,
  );
  const drift = absDiff(currentNetworkFee, quote.networkFeeMinor);
  const tolerance = maxBigInt(quote.networkFeeMinor / 20n, 1n);
  if (drift > tolerance) {
    db.run(`UPDATE quotes SET status = 'INVALIDATED', invalidated_reason = ? WHERE id = ?`, [
      `network fee moved ${(Number(drift) / Number(unitOf(quote.asset)) * 100).toFixed(4)} while quoting`,
      quoteId,
    ]);
    throw new DomainError('QUOTE_ASSET_CHANGED', undefined, {
      previousNetworkFeeMinor: quote.networkFeeMinor.toString(),
      currentNetworkFeeMinor: currentNetworkFee.toString(),
    });
  }
  const updated = db.run(`UPDATE quotes SET status = 'CONSUMED', consumed_at = ? WHERE id = ? AND status = 'ACTIVE'`, [
    nowIso(),
    quoteId,
  ]);
  if (updated.changes !== 1) {
    throw new DomainError('CONFLICT', 'This quote was already used by another request.');
  }
  return { ...quote, status: 'CONSUMED' };
}

export function release(quoteId: string, reason: string): void {
  // A payment that died before taking funds frees its quote for one retry inside
  // the original TTL; after that it expires normally.
  getDb().run(`UPDATE quotes SET status = 'ACTIVE', consumed_at = NULL, invalidated_reason = ? WHERE id = ? AND status = 'CONSUMED' AND expires_at > ?`, [
    `released: ${reason}`,
    quoteId,
    nowIso(),
  ]);
}

export function expireStale(): number {
  const db = getDb();
  const res = db.run(`UPDATE quotes SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at <= ?`, [nowIso()]);
  if (res.changes > 0) log.info('quotes expired', { count: res.changes });
  return res.changes;
}

export function networkFeeCents(network: NetworkCode, asset: AssetCode): number {
  const def = NETWORKS[network];
  if (!def) return 0;
  const row = getDb().maybeOne<{ fee_estimate_usd_cents: number; status: string }>(
    'SELECT fee_estimate_usd_cents, status FROM networks WHERE code = ?',
    [network],
  );
  const base = row?.fee_estimate_usd_cents ?? def.sandboxFeeUsdCents;
  const congestion = row?.status === 'CONGESTED' ? 1.6 : row?.status === 'DEGRADED' ? 2.5 : 1;
  // Bitcoin fees are weight-based; larger token transfers cost marginally more.
  const assetFactor = asset === 'BTC' ? 1.1 : asset === 'ETH' ? 1.15 : 1;
  return Math.round(base * congestion * assetFactor);
}

export function toView(quote: Quote) {
  const asset = quote.asset;
  const rateNumber = Number(quote.fxRate) / Number(RATE_SCALE);
  const midNumber = Number(quote.midRate) / Number(RATE_SCALE);
  return {
    quoteId: quote.quoteId,
    status: quote.status,
    asset,
    network: quote.network,
    recipientCurrency: quote.recipientCurrency,
    recipientCountry: quote.recipientCountry,
    rail: quote.rail,
    recipientAmountKesMinor: quote.recipientAmountMinor.toString(),
    cryptoAmountMinor: quote.cryptoAmountMinor.toString(),
    networkFeeMinor: quote.networkFeeMinor.toString(),
    serviceFeeMinor: quote.serviceFeeMinor.toString(),
    totalDebitMinor: quote.totalDebitMinor.toString(),
    fxRate: rateNumber.toFixed(6),
    midMarketRate: midNumber.toFixed(6),
    fees: {
      networkFeeMinor: quote.networkFeeMinor.toString(),
      networkFeeUsdMinor: String(networkFeeCents(quote.network, asset)),
      networkFeeLabel: `${NETWORKS[quote.network]?.shortName ?? quote.network} network fee`,
      serviceFeeMinor: quote.serviceFeeMinor.toString(),
      serviceFeeKesMinor: quote.platformFeeKesMinor.toString(),
      providerSurchargeKesMinor: quote.providerSurchargeMinor.toString(),
      totalFeeKesMinor: (quote.platformFeeKesMinor + quote.providerSurchargeMinor + quote.railSurchargeMinor).toString(),
      feeBps: quote.feeBps,
      spreadBps: quote.spreadBps,
      hiddenSpread: false as const,
    },
    route: {
      routeId: quote.route.routeId,
      rail: quote.route.rail,
      provider: quote.route.provider,
      providerDisplayName: quote.route.providerDisplayName,
      rank: 1,
      considered: quote.route.considered.map((c) => ({
        provider: `${c.rail}/${c.provider}`,
        score: c.score,
        reason: c.accepted ? `accepted (${c.reason})` : `rejected: ${c.reason}`,
      })),
    },
    liquidityCheck: {
      sufficient: quote.liquidity.sufficient,
      availableKesMinor: quote.liquidity.availableMinor.toString(),
      requiredKesMinor: quote.liquidity.requiredMinor.toString(),
      queuedIfInsufficient: quote.liquidity.queuedIfInsufficient,
    },
    riskHint: quote.riskHint,
    estimatedSettlementSeconds: quote.estimatedSettlementSeconds,
    createdAt: quote.createdAt,
    expiresAt: quote.expiresAt,
    ttlSeconds: quote.ttlSeconds,
    dataOrigin: quote.dataOrigin,
    disclaimer: quote.disclaimer,
  };
}

function defaultNetwork(asset: AssetCode): NetworkCode {
  const row = getDb().maybeOne<{ network: string }>('SELECT network FROM wallets WHERE asset = ? ORDER BY id LIMIT 1', [asset]);
  if (row && NETWORKS[row.network as NetworkCode]) return row.network as NetworkCode;
  if (asset === 'USDT') return 'TRON';
  if (asset === 'USDC') return 'ETHEREUM';
  if (asset === 'BTC') return 'BITCOIN';
  return 'ETHEREUM';
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

function formatKESMajor(minor: bigint): string {
  return (Number(minor) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const RAIL_BY_COUNTRY_DEFAULT: RailCode = 'MPESA';
export const HIGH_VALUE_KES = HIGH_VALUE_THRESHOLD_KES;

/**
 * "You pay X USDT" mode must still cover the rail's own cost, which is only
 * known once the route is planned — so gross it up before the router runs using
 * the corridor's default rail.
 */
function subtractRailCost(grossKesMinor: bigint, input: QuoteInput, network: NetworkCode): bigint {
  const rail = input.rail ?? (input.kind === 'PHONE' ? RAIL_BY_COUNTRY_DEFAULT : input.rail);
  const bps = rail ? RAILS[rail]!.providerFeeBps : 0;
  const fixed = rail ? RAILS[rail]!.providerFixedFeeMinor : 0;
  return grossKesMinor - applyBps(grossKesMinor, bps) - BigInt(fixed);
}
