import {
  DomainError,
  RAILS,
  type NetworkCode,
  type RailCode,
  type RecipientKind,
  railFor,
  countryFor,
  applyBps,
  unitOf,
  type AssetCode,
} from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { eligibleProviders, providerDisplayName, type ProviderCatalogEntry } from './providers.js';
import { createLogger } from '../logger.js';

const log = createLogger('routing');

/**
 * Payment routing engine.
 *
 * Chooses *which rail and which provider* should settle a payment, and proves
 * the choice is defensible: every candidate considered is returned with its
 * score and the reason it won or lost, so ops can replay a routing decision and
 * the API can expose `route.considered` to merchants.
 *
 * Never depends on a single provider: a rail is only ever usable through the
 * providers that are configured, healthy and within limits. If none qualify the
 * router fails closed with a human-readable reason.
 */

export interface RoutingRequest {
  asset: AssetCode;
  network: NetworkCode;
  kind: RecipientKind;
  country: string;
  railHint?: RailCode;
  amountMinor: bigint;
  currency: string;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'SEVERE';
  /** Business (merchant) settlement preference overrides the payer's default. */
  settlementRailOverride?: RailCode;
  userId?: string | null;
}

export interface RouteCandidate {
  rail: RailCode;
  provider: string;
  providerDisplayName: string;
  score: number;
  feeMinor: bigint;
  latencySeconds: number;
  accepted: boolean;
  reason: string;
  components: Record<string, number>;
}

export interface RoutePlan {
  routeId: string;
  rail: RailCode;
  provider: string;
  providerDisplayName: string;
  feeMinor: bigint;
  fixedFeeMinor: bigint;
  feeBps: number;
  latencySeconds: number;
  refundable: boolean;
  instant: boolean;
  estimatedSettlementSeconds: number;
  considered: RouteCandidate[];
  fallbacks: Array<{ rail: RailCode; provider: string; reason: string }>;
  dataOrigin: 'sandbox' | 'live';
  notes: string[];
}

/** Scoring weights — exposed so the admin UI can show *why* a route won. */
export const WEIGHTS = {
  fee: 0.3,
  latency: 0.22,
  success: 0.28,
  liquidity: 0.14,
  capacity: 0.06,
} as const;

interface ProviderHealth {
  operational: boolean;
  successRatePct: number;
  latencyP50Ms: number;
  errorRatePct: number;
}

export function readProviderHealth(code: string): ProviderHealth {
  const row = getDb().maybeOne<{
    operational: number;
    enabled: number;
    success_rate_bps: number;
    latency_p50_ms: number;
    error_rate_bps: number;
  }>('SELECT * FROM provider_accounts WHERE provider = ? LIMIT 1', [code]);
  if (!row) return { operational: true, successRatePct: 100, latencyP50Ms: 0, errorRatePct: 0 };
  return {
    operational: row.operational === 1 && row.enabled === 1,
    successRatePct: row.success_rate_bps / 100,
    latencyP50Ms: row.latency_p50_ms,
    errorRatePct: row.error_rate_bps / 100,
  };
}

export function railForKind(kind: RecipientKind, country: string, hint?: string): RailCode {
  return railFor(kind, { country, hint });
}

/** Rails that could serve this recipient, in preference order. */
/**
 * Which rails can physically deliver money to which kind of destination handle.
 * A phone number cannot be credited by a bank transfer, so the router must never
 * "optimise" its way into an instrument the recipient cannot use. Score decides
 * *between* capable rails; capability decides *which rails are in the race*.
 * Keyed on rail `kind`, so it holds for every corridor, not only Kenya.
 */
const CAPABILITY_EXCEPTIONS: Partial<Record<RecipientKind, RailCode[]>> = {
  // PesaLink addresses a phone number as an interbank transfer.
  PHONE: ['PESALINK'],
  // A printed AuraPay QR encodes a till, a paybill or a Lipa na M-Pesa number.
  QR: ['MPESA', 'MPESA_TILL', 'MPESA_PAYBILL', 'AIRTEL_MONEY', 'MTN_MOMO'],
  // A hosted link lets the payer choose, so anything but a crypto address.
  LINK: ['MPESA', 'MPESA_TILL', 'MPESA_PAYBILL', 'AIRTEL_MONEY', 'MTN_MOMO', 'PESALINK', 'BANK_TRANSFER'],
};

function railCanServe(rail: RailCode, kind: RecipientKind): boolean {
  const def = RAILS[rail];
  if (!def) return false;
  if (def.kind === kind) return true;
  if (kind === 'WALLET') return def.kind === 'WALLET';
  return (CAPABILITY_EXCEPTIONS[kind] ?? []).includes(rail);
}

export function candidateRails(request: RoutingRequest): RailCode[] {
  const country = countryFor(request.country);
  if (request.settlementRailOverride && country.rails.includes(request.settlementRailOverride)) {
    return [request.settlementRailOverride, ...country.rails.filter((r) => r !== request.settlementRailOverride)];
  }
  if (request.kind === 'WALLET') return ['CRYPTO_WALLET'];
  const primary = request.railHint && country.rails.includes(request.railHint) ? request.railHint : railForKind(request.kind, request.country);
  const ordered: RailCode[] = [primary, ...country.rails];
  return [...new Set(ordered)].filter((rail) => country.rails.includes(rail) && railCanServe(rail, request.kind));
}

function networkPressure(network: NetworkCode | null | undefined): number {
  if (!network) return 0;
  const row = getDb().maybeOne<{ status: string }>('SELECT status FROM networks WHERE code = ?', [network]);
  if (!row) return 0;
  if (row.status === 'CONGESTED') return 0.35;
  if (row.status === 'DEGRADED') return 0.7;
  return 0;
}

/**
 * The router itself. Pure function of state: same DB state + same request ⇒
 * same decision, which is what makes routing testable and debuggable.
 */
export function plan(request: RoutingRequest): RoutePlan {
  const rails = candidateRails(request);
  const considered: RouteCandidate[] = [];
  const notes: string[] = [];

  if (rails.length === 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `A ${request.kind.toLowerCase()} destination cannot be paid with the rails configured for ${request.country}. Check the recipient details — for a phone number use M-Pesa or Airtel Money, for a bank account add the account number and sort code.`,
      { kind: request.kind, country: request.country, configured: countryFor(request.country).rails },
    );
  }

  for (const rail of rails) {
    const railDef = RAILS[rail];
    if (!railDef) {
      notes.push(`${rail}: no rail definition for ${request.country}`);
      continue;
    }
    const providers = eligibleProviders(rail, request.country);
    if (providers.length === 0) {
      notes.push(
        `${rail}: no configured provider${config.isSandbox ? '' : ' (a live provider must be contracted and enabled)'}`,
      );
      continue;
    }
    for (const provider of providers) {
      const candidate = score(request, rail, provider, notes);
      considered.push(candidate);
    }
  }

  // The rail the recipient's details were actually built for (M-Pesa for a phone
  // number, a till for Buy Goods…) gets a small preference: it is the account the
  // money is expected to land in. A degraded or expensive primary rail still loses.
  const preferredRail = railForKind(request.kind, request.country);
  const scored = considered.map((c) => ({
    ...c,
    rank: c.accepted && c.rail === preferredRail && c.score >= 70 ? c.score + 5 : c.score,
  }));

  const accepted = scored
    .filter((c) => c.accepted)
    .sort((a, b) => b.rank - a.rank || Number(a.feeMinor - b.feeMinor));

  if (accepted.length === 0) {
    const reasons = [...new Set(considered.map((c) => c.reason).filter(Boolean))];
    log.warn('no route', { asset: request.asset, amount: request.amountMinor.toString(), reasons });
    throw new DomainError('RAIL_UNAVAILABLE', 'No payout route can serve this payment right now.', {
      country: request.country,
      considered: considered.map(({ rail, provider, reason }) => ({ rail, provider, reason })),
    });
  }

  const winner = accepted[0]!;
  const railDef = RAILS[winner.rail]!;
  const provider = eligibleProviders(winner.rail, request.country).find((p) => p.code === winner.provider)!;
  const maxMinor = BigInt(Math.round(railDef.maxAmountLocal * 100));

  return {
    routeId: `R_${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    rail: winner.rail,
    provider: provider.code,
    providerDisplayName: provider.displayName,
    feeMinor: winner.feeMinor,
    fixedFeeMinor: BigInt(provider.fixedFeeMinor),
    feeBps: provider.feeBps,
    latencySeconds: provider.latencySeconds,
    refundable: railDef.refundable && provider.supportsReversal,
    instant: railDef.instant,
    estimatedSettlementSeconds: estimateSettlement(request.network, railDef.targetLatencySeconds),
    considered,
    fallbacks: accepted.slice(1).map((c) => ({
      rail: c.rail,
      provider: c.provider,
      reason: c.rail === winner.rail ? `next provider on ${c.rail}` : `next best rail (${c.score.toFixed(1)} vs ${winner.score.toFixed(1)})`,
    })),
    dataOrigin: config.isSandbox ? 'sandbox' : 'live',
    notes: [
      ...notes,
      `route capped at ${(Number(maxMinor) / 100).toLocaleString('en-KE')} KES per payout on ${winner.rail}`,
      railDef.refundable ? '' : `${winner.rail} cannot be reversed automatically — refunds become manual requests`,
    ].filter(Boolean),
  };
}

function score(request: RoutingRequest, rail: RailCode, provider: ProviderCatalogEntry, notes: string[]): RouteCandidate {
  const railDef = RAILS[rail]!;
  const health = readProviderHealth(provider.code);
  const amount = request.amountMinor;
  const feeMinor = applyBps(amount, provider.feeBps + railDef.providerFeeBps) + BigInt(provider.fixedFeeMinor);
  const liquidity = getDb().maybeOne<{ available_minor: string }>(
    'SELECT available_minor FROM liquidity_accounts WHERE rail = ? AND currency = ? LIMIT 1',
    [rail, request.currency],
  );
  const available = BigInt(liquidity?.available_minor ?? '0');
  const feeNorm = clamp01(Number(feeMinor) / Number(amount || 1n) / 0.05);
  const latencyNorm = clamp01(provider.latencySeconds / 600);
  const success = clamp01(health.successRatePct / 100);
  const liquidityFit = available <= 0n ? 0 : clamp01(Number(available) / Number((amount + feeMinor) * 3n));
  const capacity = amount > BigInt(railDef.maxAmountLocal * 100) || amount > BigInt(provider.maxPayoutKes * 100) ? 0 : 1;

  let accepted = true;
  let reason = 'selected';
  if (amount < BigInt(railDef.minAmountLocal * 100)) {
    accepted = false;
    reason = `below the ${rail} minimum of ${railDef.minAmountLocal} ${request.currency}`;
  } else if (capacity === 0) {
    accepted = false;
    reason = `above the ${rail} per-payout limit`;
  } else if (!health.operational) {
    accepted = false;
    reason = `${provider.displayName} is not operational`;
  } else if (health.successRatePct < 90) {
    accepted = false;
    reason = `${provider.displayName} success rate ${health.successRatePct.toFixed(1)}% is below the 90% routing floor`;
  } else if (provider.sandboxOnly && !config.isSandbox) {
    accepted = false;
    reason = 'sandbox simulator is not available in production';
  } else if (rail === 'MPESA' && request.network && networkPressure(request.network) > 0.6) {
    notes.push(`${rail} kept despite network pressure: no alternative rail for this corridor`);
  }

  const components = {
    fee: (1 - feeNorm) * WEIGHTS.fee,
    latency: (1 - latencyNorm) * WEIGHTS.latency,
    success,
    liquidity: liquidityFit * WEIGHTS.liquidity,
    capacity: capacity * WEIGHTS.capacity,
  };
  const riskPenalty = request.riskLevel === 'SEVERE' ? 0.5 : request.riskLevel === 'HIGH' ? 0.15 : 0;
  const total =
    (components.fee + components.latency + components.success * WEIGHTS.success + components.liquidity + components.capacity) *
    100 *
    (1 - riskPenalty);

  return {
    rail,
    provider: provider.code,
    providerDisplayName: provider.displayName,
    score: Number(total.toFixed(2)),
    feeMinor,
    latencySeconds: provider.latencySeconds,
    accepted,
    reason,
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, Number(v.toFixed(4))])),
  };
}

function estimateSettlement(network: NetworkCode, railTargetSeconds: number): number {
  const pressure = 1 + networkPressure(network) * 2;
  const networkRow = getDb().maybeOne<{ confirmations_required: number; block_time_seconds: number }>(
    'SELECT confirmations_required, block_time_seconds FROM networks WHERE code = ?',
    [network],
  );
  const chainSeconds = networkRow
    ? Math.max(30, Math.round(networkRow.confirmations_required * networkRow.block_time_seconds))
    : 60;
  const sandboxSpeedup = config.isSandbox ? 0.15 : 1;
  return Math.max(5, Math.round((chainSeconds + railTargetSeconds) * pressure * sandboxSpeedup));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Used by the pay screen to explain the rail the user picked before quoting. */
export function describeRail(rail: RailCode): {
  rail: RailCode;
  name: string;
  recipientFacing: string;
  minKes: number;
  maxKes: number;
  refundable: boolean;
  instant: boolean;
  feeBps: number;
} {
  const def = RAILS[rail];
  if (!def) throw new DomainError('VALIDATION_FAILED', `Unknown rail ${rail}`);
  return {
    rail,
    name: def.name,
    recipientFacing: def.recipientFacing,
    minKes: def.minAmountLocal,
    maxKes: def.maxAmountLocal,
    refundable: def.refundable,
    instant: def.instant,
    feeBps: def.providerFeeBps,
  };
}

export function unitForCurrency(currency: string): bigint {
  return unitOf(currency as AssetCode) || unitOf('KES');
}

export { unitOf };
