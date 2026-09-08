import type { AssetCode } from './money.js';

export type NetworkCode =
  | 'TRON'
  | 'ETHEREUM'
  | 'SOLANA'
  | 'BNB_CHAIN'
  | 'BITCOIN'
  | 'BASE'
  | 'ARBITRUM'
  | 'FIAT';

export type AssetKind = 'stablecoin' | 'crypto';

export interface AssetDefinition {
  code: AssetCode;
  name: string;
  kind: AssetKind;
  /** Networks on which the platform can accept this asset. */
  networks: NetworkCode[];
  /** Default network used when the caller does not specify one. */
  defaultNetwork: NetworkCode;
  /** Display precision used by the UI. */
  displayDecimals: number;
  /** Stablecoins are priced directly in KES; others route via USD. */
  quoteViaUsd: boolean;
  /** Whether this asset may be used to fund a fiat payout in sandbox mode. */
  sandboxPayable: boolean;
  /** Whether the asset is enabled for production money movement (requires partner config). */
  productionEnabled: boolean;
}

export const ASSETS: Record<AssetCode, AssetDefinition> = {
  USDT: {
    code: 'USDT',
    name: 'Tether USD',
    kind: 'stablecoin',
    networks: ['TRON', 'ETHEREUM', 'SOLANA', 'BNB_CHAIN', 'ARBITRUM'],
    defaultNetwork: 'TRON',
    displayDecimals: 2,
    quoteViaUsd: false,
    sandboxPayable: true,
    productionEnabled: false,
  },
  USDC: {
    code: 'USDC',
    name: 'USD Coin',
    kind: 'stablecoin',
    networks: ['ETHEREUM', 'SOLANA', 'BASE', 'BNB_CHAIN', 'ARBITRUM'],
    defaultNetwork: 'ETHEREUM',
    displayDecimals: 2,
    quoteViaUsd: false,
    sandboxPayable: true,
    productionEnabled: false,
  },
  BTC: {
    code: 'BTC',
    name: 'Bitcoin',
    kind: 'crypto',
    networks: ['BITCOIN'],
    defaultNetwork: 'BITCOIN',
    displayDecimals: 6,
    quoteViaUsd: true,
    sandboxPayable: true,
    productionEnabled: false,
  },
  ETH: {
    code: 'ETH',
    name: 'Ether',
    kind: 'crypto',
    networks: ['ETHEREUM', 'BASE', 'BNB_CHAIN', 'ARBITRUM'],
    defaultNetwork: 'ETHEREUM',
    displayDecimals: 5,
    quoteViaUsd: true,
    sandboxPayable: true,
    productionEnabled: false,
  },
  KES: {
    code: 'KES',
    name: 'Kenyan Shilling',
    kind: 'crypto',
    networks: ['FIAT'],
    defaultNetwork: 'FIAT',
    displayDecimals: 2,
    quoteViaUsd: false,
    sandboxPayable: false,
    productionEnabled: false,
  },
  USD: {
    code: 'USD',
    name: 'US Dollar',
    kind: 'crypto',
    networks: ['FIAT'],
    defaultNetwork: 'FIAT',
    displayDecimals: 2,
    quoteViaUsd: false,
    sandboxPayable: false,
    productionEnabled: false,
  },
  EUR: { code: 'EUR', name: 'Euro', kind: 'crypto', networks: ['FIAT'], defaultNetwork: 'FIAT', displayDecimals: 2, quoteViaUsd: false, sandboxPayable: false, productionEnabled: false },
  GBP: { code: 'GBP', name: 'Pound Sterling', kind: 'crypto', networks: ['FIAT'], defaultNetwork: 'FIAT', displayDecimals: 2, quoteViaUsd: false, sandboxPayable: false, productionEnabled: false },
  AED: { code: 'AED', name: 'UAE Dirham', kind: 'crypto', networks: ['FIAT'], defaultNetwork: 'FIAT', displayDecimals: 2, quoteViaUsd: false, sandboxPayable: false, productionEnabled: false },
  UGX: { code: 'UGX', name: 'Ugandan Shilling', kind: 'crypto', networks: ['FIAT'], defaultNetwork: 'FIAT', displayDecimals: 2, quoteViaUsd: false, sandboxPayable: false, productionEnabled: false },
  TZS: { code: 'TZS', name: 'Tanzanian Shilling', kind: 'crypto', networks: ['FIAT'], defaultNetwork: 'FIAT', displayDecimals: 2, quoteViaUsd: false, sandboxPayable: false, productionEnabled: false },
  NGN: { code: 'NGN', name: 'Nigerian Naira', kind: 'crypto', networks: ['FIAT'], defaultNetwork: 'FIAT', displayDecimals: 2, quoteViaUsd: false, sandboxPayable: false, productionEnabled: false },
  GHS: { code: 'GHS', name: 'Ghanaian Cedi', kind: 'crypto', networks: ['FIAT'], defaultNetwork: 'FIAT', displayDecimals: 2, quoteViaUsd: false, sandboxPayable: false, productionEnabled: false },
  ZAR: { code: 'ZAR', name: 'South African Rand', kind: 'crypto', networks: ['FIAT'], defaultNetwork: 'FIAT', displayDecimals: 2, quoteViaUsd: false, sandboxPayable: false, productionEnabled: false },
};

export const PAYABLE_ASSETS = ['USDT', 'USDC', 'BTC', 'ETH'] as const satisfies readonly AssetCode[];
export type PayableAsset = (typeof PAYABLE_ASSETS)[number];

export function isPayableAsset(value: string): value is PayableAsset {
  return (PAYABLE_ASSETS as readonly string[]).includes(value);
}

export function assetDefinition(asset: AssetCode): AssetDefinition {
  const def = ASSETS[asset];
  if (!def) throw new Error(`unknown asset ${asset}`);
  return def;
}
