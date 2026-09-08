import { config } from '../config.js';
import { getDb } from '../db/index.js';
import type { RailCode } from '@aurapay/shared';

/**
 * Provider catalog.
 *
 * A provider is a *licensed third party* (or, in sandbox, the local
 * simulator). Nothing in the payment engine may call a provider directly; the
 * router returns a provider code and `payouts.ts` executes it through the
 * matching adapter.
 *
 * `sandboxOnly` providers exist so the demo is completable. They never contact
 * a real network and always stamp results with `data_origin = 'sandbox'`.
 */

export interface ProviderCatalogEntry {
  code: string;
  displayName: string;
  kind: 'MOBILE_MONEY' | 'BANK' | 'FX' | 'CUSTODY' | 'KYC' | 'SCREENING' | 'BLOCKCHAIN';
  rails: RailCode[];
  countries: string[];
  /** Only usable in sandbox mode (simulator). */
  sandboxOnly: boolean;
  /** Live credentials present in the environment. */
  configured(): boolean;
  /** Relative cost in basis points of the payout (used by the router). */
  feeBps: number;
  /** Fixed fee, KES minor units. */
  fixedFeeMinor: number;
  /** Target settlement latency in seconds. */
  latencySeconds: number;
  /** Whether the provider can reverse a payout on request. */
  supportsReversal: boolean;
  /** Max single payout in KES major units, per provider contract. */
  maxPayoutKes: number;
  notes: string;
}

export const PROVIDERS: ProviderCatalogEntry[] = [
  {
    code: 'aurapay-sandbox-simulator',
    displayName: 'AuraPay Sandbox Simulator',
    kind: 'MOBILE_MONEY',
    rails: ['MPESA', 'MPESA_TILL', 'MPESA_PAYBILL', 'AIRTEL_MONEY', 'PESALINK', 'BANK_TRANSFER'],
    countries: ['KE', 'TZ', 'UG'],
    sandboxOnly: true,
    configured: () => true,
    feeBps: 65,
    fixedFeeMinor: 0,
    latencySeconds: 8,
    supportsReversal: true,
    maxPayoutKes: 150_000,
    notes:
      'Deterministic in-process simulator used by sandbox and tests. Never calls an external network. ' +
      'Payout outcomes are driven by `sandbox_actions` so a demo can exercise success, failure and review paths.',
  },
  {
    code: 'safaricom-daraja',
    displayName: 'Safaricom Daraja (M-Pesa API)',
    kind: 'MOBILE_MONEY',
    rails: ['MPESA'],
    countries: ['KE'],
    sandboxOnly: false,
    configured: () =>
      config.providers.mpesa.liveEnabled &&
      Boolean(config.providers.mpesa.consumerKey && config.providers.mpesa.consumerSecret && config.providers.mpesa.shortcode),
    feeBps: 0,
    fixedFeeMinor: 0,
    latencySeconds: 30,
    // Daraja STK Push debits a customer, it does not credit one. Business-to-Customer
    // (B2C) is a separate product with its own contract — reversal is not part of the
    // public API, so refunds through this rail require a support process.
    supportsReversal: false,
    maxPayoutKes: 150_000,
    notes:
      'Requires a Daraja B2C/STK product subscription, shortcode + init key, IPN callbacks and an ' +
      'approved use case. Integration is implemented in adapters/safaricom.ts but stays disabled unless ' +
      'MPESA_LIVE_ENABLED=true with credentials present.',
  },
  {
    code: 'airtel-afrika-money',
    displayName: 'Airtel Africa Money',
    kind: 'MOBILE_MONEY',
    rails: ['AIRTEL_MONEY'],
    countries: ['KE', 'UG', 'TZ'],
    sandboxOnly: false,
    configured: () => config.providers.airtel.liveEnabled && Boolean(config.providers.airtel.clientId),
    feeBps: 75,
    fixedFeeMinor: 0,
    latencySeconds: 45,
    supportsReversal: true,
    maxPayoutKes: 120_000,
    notes: 'Merchant payout API with OAuth client credentials; needs a signed commercial agreement.',
  },
  {
    code: 'bank-corporate-host',
    displayName: 'Bank corporate host (PesaLink / RTGS)',
    kind: 'BANK',
    rails: ['PESALINK', 'BANK_TRANSFER'],
    countries: ['KE'],
    sandboxOnly: false,
    configured: () => config.providers.bank.liveEnabled && Boolean(config.providers.bank.host),
    feeBps: 15,
    fixedFeeMinor: 500,
    latencySeconds: 300,
    supportsReversal: false,
    maxPayoutKes: 5_000_000,
    notes: 'Used for large-ticket payouts where mobile-money limits do not apply.',
  },
  {
    code: 'mtn-momo',
    displayName: 'MTN Mobile Money',
    kind: 'MOBILE_MONEY',
    rails: ['MTN_MOMO'],
    countries: ['UG'],
    sandboxOnly: false,
    configured: () => false,
    feeBps: 80,
    fixedFeeMinor: 0,
    latencySeconds: 45,
    supportsReversal: true,
    maxPayoutKes: 0,
    notes: 'Adapter not implemented in this build; kept in the catalog so corridors can be configured later.',
  },
  {
    code: 'aurapay-sandbox-fx',
    displayName: 'AuraPay Reference Rate Feed (simulated)',
    kind: 'FX',
    rails: [],
    countries: ['*'],
    sandboxOnly: true,
    configured: () => true,
    feeBps: 0,
    fixedFeeMinor: 0,
    latencySeconds: 0,
    supportsReversal: false,
    maxPayoutKes: 0,
    notes: 'Sandbox pricing reference. Never executable liquidity — do not present as a tradable market rate.',
  },
  {
    code: 'custody-partner',
    displayName: 'Qualified custody partner',
    kind: 'CUSTODY',
    rails: [],
    countries: ['*'],
    sandboxOnly: false,
    configured: () => config.blockchain.custody.liveEnabled && Boolean(config.blockchain.custody.apiKey),
    feeBps: 0,
    fixedFeeMinor: 0,
    latencySeconds: 0,
    supportsReversal: false,
    maxPayoutKes: 0,
    notes:
      'Issues deposit addresses, holds keys in an HSM/MPC environment and signs sweep transactions. ' +
      'AuraPay never stores or derives private keys.',
  },
  {
    code: 'aurapay-internal-rules',
    displayName: 'AuraPay internal screening (rules + demo watchlist)',
    kind: 'SCREENING',
    rails: [],
    countries: ['*'],
    sandboxOnly: true,
    configured: () => true,
    feeBps: 0,
    fixedFeeMinor: 0,
    latencySeconds: 0,
    supportsReversal: false,
    maxPayoutKes: 0,
    notes:
      'Deterministic rules used in sandbox. Production must route sanctions/PEP/wallet screening to a ' +
      'contracted screening provider (KYC_PROVIDER/AML_PROVIDER).',
  },
];

export function providerByCode(code: string): ProviderCatalogEntry | undefined {
  return PROVIDERS.find((p) => p.code === code);
}

/** Providers that may serve a rail right now, given mode and credentials. */
export function eligibleProviders(rail: RailCode, country: string): ProviderCatalogEntry[] {
  return PROVIDERS.filter((p) => {
    if (!p.rails.includes(rail)) return false;
    if (!p.countries.includes(country) && !p.countries.includes('*')) return false;
    if (p.sandboxOnly && !config.isSandbox) return false;
    if (!p.sandboxOnly && !p.configured()) return false;
    if (!p.sandboxOnly && !providerRowOperational(p.code)) return false;
    return true;
  });
}

/** Ops can disable a provider at runtime without a deploy. */
function providerRowOperational(code: string): boolean {
  const row = getDb().maybeOne<{ operational: number; enabled: number }>(
    'SELECT operational, enabled FROM provider_accounts WHERE provider = ? LIMIT 1',
    [code],
  );
  if (!row) return true;
  return row.operational === 1 && row.enabled === 1;
}

export function providerDisplayName(code: string): string {
  return providerByCode(code)?.displayName ?? code;
}
