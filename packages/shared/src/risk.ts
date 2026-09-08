import type { PayableAsset } from './assets.js';
import type { KycTier } from './status.js';

/**
 * Account limits and risk inputs. Limits are enforced in the payment pipeline
 * (fail-closed), not just in the UI.
 */
export interface TierLimits {
  tier: KycTier;
  label: string;
  /** Max single payment, KES major units. */
  perPaymentKes: number;
  /** Rolling 24h total, KES major units. */
  dailyKes: number;
  /** Rolling 30d total, KES major units. */
  monthlyKes: number;
  maxPayoutsPerDay: number;
  /** Requires step-up confirmation above this amount. */
  strongConfirmFromKes: number;
  kycRequired: boolean;
}

export const TIER_LIMITS: Record<KycTier, TierLimits> = {
  0: {
    tier: 0,
    label: 'Unverified',
    perPaymentKes: 0,
    dailyKes: 0,
    monthlyKes: 0,
    maxPayoutsPerDay: 0,
    strongConfirmFromKes: 0,
    kycRequired: true,
  },
  1: {
    tier: 1,
    label: 'Verified — basic',
    perPaymentKes: 50_000,
    dailyKes: 100_000,
    monthlyKes: 1_000_000,
    maxPayoutsPerDay: 25,
    strongConfirmFromKes: 40_000,
    kycRequired: false,
  },
  2: {
    tier: 2,
    label: 'Verified — enhanced',
    perPaymentKes: 500_000,
    dailyKes: 1_500_000,
    monthlyKes: 15_000_000,
    maxPayoutsPerDay: 200,
    strongConfirmFromKes: 100_000,
    kycRequired: false,
  },
  3: {
    tier: 3,
    label: 'Verified — business',
    perPaymentKes: 5_000_000,
    dailyKes: 20_000_000,
    monthlyKes: 200_000_000,
    maxPayoutsPerDay: 2_000,
    strongConfirmFromKes: 500_000,
    kycRequired: false,
  },
};

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'SEVERE';

export interface RiskSignal {
  code: string;
  label: string;
  weight: number;
  /** Signals with this flag block money movement outright. */
  blocking: boolean;
  detail?: string;
}

export interface RiskAssessment {
  score: number; // 0..100
  level: RiskLevel;
  signals: RiskSignal[];
  /** Result of the compliance decision, e.g. "AUTO_APPROVE" | "MANUAL_REVIEW". */
  decision: 'AUTO_APPROVE' | 'STEP_UP' | 'MANUAL_REVIEW' | 'BLOCK';
  evaluatedAt: string;
  provider: 'internal_rules' | 'partner_provider';
}

export function riskLevel(score: number): RiskLevel {
  if (score >= 85) return 'SEVERE';
  if (score >= 60) return 'HIGH';
  if (score >= 30) return 'MEDIUM';
  return 'LOW';
}

/** Velocity windows checked against ledger-backed aggregates. */
export const VELOCITY_WINDOWS = [
  { id: '15m', seconds: 900, maxPayments: 12 },
  { id: '1h', seconds: 3600, maxPayments: 40 },
  { id: '24h', seconds: 86_400, maxPayments: 120 },
] as const;

export const SANCTIONS_LIST_VERSION = 'demo-watchlist-2026-09';

export const ASSET_RISK_MULTIPLIER: Record<PayableAsset, number> = {
  USDT: 1,
  USDC: 1,
  BTC: 1.15,
  ETH: 1.1,
};
