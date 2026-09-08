import type { PayableAsset } from './assets.js';
import type { NetworkCode } from './assets.js';
import type { RailCode } from './rails.js';

/**
 * Fee model — public, no hidden spread.
 *
 * `spreadBps` is the only mark-up applied to the reference FX rate and it is
 * always disclosed on the quote as "rate includes X% spread" so a user can
 * reconcile `1 USDT = 129.05 KES` against the published mid-market rate.
 */
export interface FeeSchedule {
  /** Platform fee in basis points of the KES amount delivered. */
  platformFeeBps: number;
  /** Minimum platform fee in KES (integer shillings, not cents). */
  platformFeeMinKes: number;
  /** FX spread in basis points applied against mid-market. */
  spreadBps: number;
  /** Whether a fixed payout-network surcharge is added. */
  railSurchargeMinor: number;
}

export const FEE_SCHEDULES: Record<PayableAsset, FeeSchedule> = {
  USDT: { platformFeeBps: 100, platformFeeMinKes: 3, spreadBps: 25, railSurchargeMinor: 0 },
  USDC: { platformFeeBps: 100, platformFeeMinKes: 3, spreadBps: 25, railSurchargeMinor: 0 },
  BTC: { platformFeeBps: 175, platformFeeMinKes: 5, spreadBps: 60, railSurchargeMinor: 0 },
  ETH: { platformFeeBps: 150, platformFeeMinKes: 5, spreadBps: 45, railSurchargeMinor: 0 },
};

/** Rail-level surcharges layered on top of the asset schedule (KES cents). */
export const RAIL_SURCHARGES: Partial<Record<RailCode, number>> = {
  MPESA_TILL: 0,
  MPESA_PAYBILL: 0,
  PESALINK: 200,
  BANK_TRANSFER: 500,
};

export const QUOTE_TTL_SECONDS = 90;
export const QUOTE_TTL_SECONDS_HIGH_VALUE = 45;
export const HIGH_VALUE_THRESHOLD_KES = 100_000; // KES (major units)

export function feeSchedule(asset: PayableAsset, network?: NetworkCode): FeeSchedule {
  const base = FEE_SCHEDULES[asset] ?? FEE_SCHEDULES.USDT;
  // Stablecoins on Solana/Tron get a marginally tighter spread: cheaper, faster
  // liquidation of the incoming deposit.
  if (asset === 'USDT' && network === 'SOLANA') return { ...base, spreadBps: 20 };
  return base;
}

export function quoteTtl(kesAmountMajor: number): number {
  return kesAmountMajor >= HIGH_VALUE_THRESHOLD_KES ? QUOTE_TTL_SECONDS_HIGH_VALUE : QUOTE_TTL_SECONDS;
}
