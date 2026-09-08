/**
 * Country / currency / rail / provider configuration layers.
 *
 * Nothing in the payment engine is allowed to hard-code Kenya: the country
 * configuration is the single source of truth for what the settlement stack of
 * a corridor looks like. KENYA is the fully-configured reference corridor.
 */

export type RailCode =
  | 'MPESA'
  | 'MPESA_TILL'
  | 'MPESA_PAYBILL'
  | 'AIRTEL_MONEY'
  | 'PESALINK'
  | 'BANK_TRANSFER'
  | 'CRYPTO_WALLET'
  | 'CARD'
  | 'MTN_MOMO'
  | 'TESET';

export type RecipientKind = 'PHONE' | 'TILL' | 'PAYBILL' | 'QR' | 'LINK' | 'BANK' | 'WALLET';

export interface RailDefinition {
  code: RailCode;
  name: string;
  /** Who the recipient ultimately sees on their statement / SMS. */
  recipientFacing: string;
  kind: RecipientKind;
  /** Typical settlement latency target in seconds. */
  targetLatencySeconds: number;
  /** Hard cap for a single payout, in the payout currency's minor units is computed in the router. */
  maxAmountLocal: number;
  minAmountLocal: number;
  /** Fee charged by the payout partner, basis points of the payout amount. */
  providerFeeBps: number;
  /** Fixed fee per payout, in local minor units (cents). */
  providerFixedFeeMinor: number;
  /** Whether the rail supports reversals initiated by the platform. */
  refundable: boolean;
  /** Whether "instant" settlement can be promised. Rails that settle async must not be labelled instant. */
  instant: boolean;
}

export const RAILS: Record<RailCode, RailDefinition> = {
  MPESA: {
    code: 'MPESA',
    name: 'M-Pesa (Safaricom)',
    recipientFacing: 'M-Pesa',
    kind: 'PHONE',
    targetLatencySeconds: 45,
    maxAmountLocal: 150_000,
    minAmountLocal: 1,
    providerFeeBps: 65,
    providerFixedFeeMinor: 0,
    refundable: true,
    instant: true,
  },
  MPESA_TILL: {
    code: 'MPESA_TILL',
    name: 'M-Pesa Buy Goods (Till)',
    recipientFacing: 'M-Pesa Till',
    kind: 'TILL',
    targetLatencySeconds: 60,
    maxAmountLocal: 1_000_000,
    minAmountLocal: 1,
    providerFeeBps: 55,
    providerFixedFeeMinor: 0,
    // A Till credit is a merchant account entry; reversals require the merchant's
    // approval, so refunds are "requested", not guaranteed.
    refundable: false,
    instant: false,
  },
  MPESA_PAYBILL: {
    code: 'MPESA_PAYBILL',
    name: 'M-Pesa PayBill',
    recipientFacing: 'M-Pesa PayBill',
    kind: 'PAYBILL',
    targetLatencySeconds: 120,
    maxAmountLocal: 1_000_000,
    minAmountLocal: 1,
    providerFeeBps: 50,
    providerFixedFeeMinor: 0,
    refundable: false,
    instant: false,
  },
  AIRTEL_MONEY: {
    code: 'AIRTEL_MONEY',
    name: 'Airtel Money',
    recipientFacing: 'Airtel Money',
    kind: 'PHONE',
    targetLatencySeconds: 90,
    maxAmountLocal: 120_000,
    minAmountLocal: 10,
    providerFeeBps: 75,
    providerFixedFeeMinor: 0,
    refundable: true,
    instant: false,
  },
  PESALINK: {
    code: 'PESALINK',
    name: 'PesaLink (bank-to-bank)',
    recipientFacing: 'PesaLink',
    kind: 'BANK',
    targetLatencySeconds: 180,
    maxAmountLocal: 1_000_000,
    minAmountLocal: 100,
    providerFeeBps: 20,
    providerFixedFeeMinor: 200,
    refundable: false,
    instant: true,
  },
  BANK_TRANSFER: {
    code: 'BANK_TRANSFER',
    name: 'Local bank transfer',
    recipientFacing: 'Bank transfer',
    kind: 'BANK',
    targetLatencySeconds: 3600,
    maxAmountLocal: 5_000_000,
    minAmountLocal: 100,
    providerFeeBps: 15,
    providerFixedFeeMinor: 500,
    refundable: false,
    instant: false,
  },
  CRYPTO_WALLET: {
    code: 'CRYPTO_WALLET',
    name: 'Crypto wallet',
    recipientFacing: 'Crypto transfer',
    kind: 'WALLET',
    targetLatencySeconds: 120,
    maxAmountLocal: 100_000_000,
    minAmountLocal: 1,
    providerFeeBps: 0,
    providerFixedFeeMinor: 0,
    refundable: false,
    instant: false,
  },
  CARD: {
    code: 'CARD',
    name: 'Card acquiring',
    recipientFacing: 'Card',
    kind: 'LINK',
    targetLatencySeconds: 86_400,
    maxAmountLocal: 500_000,
    minAmountLocal: 50,
    providerFeeBps: 250,
    providerFixedFeeMinor: 300,
    refundable: true,
    instant: false,
  },
  MTN_MOMO: {
    code: 'MTN_MOMO',
    name: 'MTN Mobile Money',
    recipientFacing: 'MTN MoMo',
    kind: 'PHONE',
    targetLatencySeconds: 90,
    maxAmountLocal: 100_000,
    minAmountLocal: 10,
    providerFeeBps: 80,
    providerFixedFeeMinor: 0,
    refundable: true,
    instant: false,
  },
  TESET: {
    code: 'TESET',
    name: 'Teset / bank switch',
    recipientFacing: 'Teset',
    kind: 'BANK',
    targetLatencySeconds: 300,
    maxAmountLocal: 1_000_000,
    minAmountLocal: 100,
    providerFeeBps: 18,
    providerFixedFeeMinor: 100,
    refundable: false,
    instant: false,
  },
};

export interface CountryDefinition {
  code: string; // ISO-3166 alpha-2
  name: string;
  currency: string;
  /** Phone dial code used by recipient validation. */
  dialCode: string;
  /** Mobile money MSISDN pattern (local format, no dial code). */
  phonePattern: string;
  rails: RailCode[];
  defaultRail: RailCode;
  /** Sandbox liquidity pool the platform pretends to hold, in minor units of `currency`. */
  sandboxLiquidityMinor: number;
  /** Rollout status — controls what the UI may offer. */
  status: 'live' | 'sandbox' | 'coming_soon';
  lat: number;
  lon: number;
}

export const COUNTRIES: Record<string, CountryDefinition> = {
  KE: {
    code: 'KE',
    name: 'Kenya',
    currency: 'KES',
    dialCode: '+254',
    phonePattern: '^(7|1)\\d{8}$',
    rails: ['MPESA', 'MPESA_TILL', 'MPESA_PAYBILL', 'AIRTEL_MONEY', 'PESALINK', 'BANK_TRANSFER', 'CARD', 'CRYPTO_WALLET'],
    defaultRail: 'MPESA',
    sandboxLiquidityMinor: 8_500_000_00,
    status: 'sandbox',
    lat: -0.0236,
    lon: 37.9062,
  },
  UG: {
    code: 'UG',
    name: 'Uganda',
    currency: 'UGX',
    dialCode: '+256',
    phonePattern: '^7\\d{8}$',
    rails: ['MTN_MOMO', 'AIRTEL_MONEY', 'BANK_TRANSFER'],
    defaultRail: 'MTN_MOMO',
    sandboxLiquidityMinor: 0,
    status: 'coming_soon',
    lat: 0.3476,
    lon: 32.5825,
  },
  TZ: {
    code: 'TZ',
    name: 'Tanzania',
    currency: 'TZS',
    dialCode: '+255',
    phonePattern: '^(6|7)\\d{8}$',
    rails: ['MPESA', 'AIRTEL_MONEY', 'TESET'],
    defaultRail: 'MPESA',
    sandboxLiquidityMinor: 0,
    status: 'coming_soon',
    lat: -6.369,
    lon: 34.8888,
  },
  NG: {
    code: 'NG',
    name: 'Nigeria',
    currency: 'NGN',
    dialCode: '+234',
    phonePattern: '^[789]\\d{9}$',
    rails: ['BANK_TRANSFER', 'CARD'],
    defaultRail: 'BANK_TRANSFER',
    sandboxLiquidityMinor: 0,
    status: 'coming_soon',
    lat: 9.082,
    lon: 8.6753,
  },
  US: {
    code: 'US',
    name: 'United States',
    currency: 'USD',
    dialCode: '+1',
    phonePattern: '^\\d{10}$',
    rails: ['CARD', 'BANK_TRANSFER', 'CRYPTO_WALLET'],
    defaultRail: 'CARD',
    sandboxLiquidityMinor: 0,
    status: 'coming_soon',
    lat: 37.0902,
    lon: -95.7129,
  },
  GB: {
    code: 'GB',
    name: 'United Kingdom',
    currency: 'GBP',
    dialCode: '+44',
    phonePattern: '^7\\d{9}$',
    rails: ['CARD', 'BANK_TRANSFER'],
    defaultRail: 'CARD',
    sandboxLiquidityMinor: 0,
    status: 'coming_soon',
    lat: 55.3781,
    lon: -3.436,
  },
  AE: {
    code: 'AE',
    name: 'United Arab Emirates',
    currency: 'AED',
    dialCode: '+971',
    phonePattern: '^5\\d{8}$',
    rails: ['CARD', 'BANK_TRANSFER'],
    defaultRail: 'CARD',
    sandboxLiquidityMinor: 0,
    status: 'coming_soon',
    lat: 23.4241,
    lon: 53.8478,
  },
  DE: {
    code: 'DE',
    name: 'Germany',
    currency: 'EUR',
    dialCode: '+49',
    phonePattern: '^1\\d{9,10}$',
    rails: ['CARD', 'BANK_TRANSFER'],
    defaultRail: 'CARD',
    sandboxLiquidityMinor: 0,
    status: 'coming_soon',
    lat: 51.1657,
    lon: 10.4515,
  },
};

export function countryFor(code: string): CountryDefinition {
  const c = COUNTRIES[code.toUpperCase()];
  if (!c) throw new Error(`unsupported country ${code}`);
  return c;
}

export function railFor(kind: RecipientKind, opts: { country?: string; hint?: string } = {}): RailCode {
  const country = countryFor(opts.country ?? 'KE');
  switch (kind) {
    case 'PHONE':
      return country.defaultRail;
    case 'TILL':
      return 'MPESA_TILL';
    case 'PAYBILL':
      return 'MPESA_PAYBILL';
    case 'BANK':
      return country.rails.includes('PESALINK') ? 'PESALINK' : 'BANK_TRANSFER';
    case 'WALLET':
      return 'CRYPTO_WALLET';
    case 'QR':
    case 'LINK':
      return opts.hint === 'CARD' ? 'CARD' : country.defaultRail;
  }
}

/** Corridor hubs used by the network visualization (positions are display data only). */
export const NETWORK_HUBS = [
  { id: 'NAIROBI', label: 'Nairobi', country: 'KE', lat: -1.2921, lon: 36.8219, role: 'settlement' as const },
  { id: 'MOMBASA', label: 'Mombasa', country: 'KE', lat: -4.0435, lon: 39.6682, role: 'settlement' as const },
  { id: 'KISUMU', label: 'Kisumu', country: 'KE', lat: -0.0917, lon: 34.768, role: 'settlement' as const },
  { id: 'NEW_YORK', label: 'New York', country: 'US', lat: 40.7128, lon: -74.006, role: 'origination' as const },
  { id: 'LONDON', label: 'London', country: 'GB', lat: 51.5074, lon: -0.1278, role: 'origination' as const },
  { id: 'DUBAI', label: 'Dubai', country: 'AE', lat: 25.2048, lon: 55.2708, role: 'origination' as const },
  { id: 'FRANKFURT', label: 'Frankfurt', country: 'DE', lat: 50.1109, lon: 8.6821, role: 'origination' as const },
  { id: 'KAMPALA', label: 'Kampala', country: 'UG', lat: 0.3476, lon: 32.5825, role: 'settlement' as const },
  { id: 'DAR_ES_SALAAM', label: 'Dar es Salaam', country: 'TZ', lat: -6.7924, lon: 39.2083, role: 'settlement' as const },
  { id: 'LAGOS', label: 'Lagos', country: 'NG', lat: 6.5244, lon: 3.3792, role: 'origination' as const },
];

/** The settlement pipeline rendered by the network view and the processing screen. */
export const SETTLEMENT_STAGES = [
  { id: 'crypto', label: 'Crypto deposit', node: 'USDT / USDC / BTC / ETH' },
  { id: 'blockchain', label: 'Blockchain confirmation', node: 'Mempool → block' },
  { id: 'risk', label: 'Risk verification', node: 'Screening + limits' },
  { id: 'conversion', label: 'Currency conversion', node: 'Stable → KES' },
  { id: 'liquidity', label: 'KES liquidity', node: 'Treasury reserve' },
  { id: 'rail', label: 'Local settlement', node: 'M-Pesa / Till / Bank' },
  { id: 'recipient', label: 'Recipient delivered', node: 'Local money received' },
] as const;

export type SettlementStageId = (typeof SETTLEMENT_STAGES)[number]['id'];
