import type { NetworkCode } from './assets.js';

export interface NetworkDefinition {
  code: NetworkCode;
  name: string;
  shortName: string;
  /** Address format used for deposit addresses. */
  addressKind: 'evm' | 'tron' | 'solana' | 'bitcoin';
  /** Blocks/confirmations required before the platform treats a deposit as final. */
  confirmationsRequired: number;
  /** Average block time, seconds — used for confirmation ETA copy. */
  blockTimeSeconds: number;
  /** Estimated on-chain fee quoted to the user, in USD cents. Simulation in sandbox. */
  sandboxFeeUsdCents: number;
  /** Dynamic fee oracle (EIP-1559 / mempool) availability in production. */
  dynamicFee: boolean;
  /** Whether the adapter is implemented in this build. */
  adapterAvailable: boolean;
  color: string;
}

export const NETWORKS: Record<NetworkCode, NetworkDefinition> = {
  TRON: {
    code: 'TRON',
    name: 'Tron Network',
    shortName: 'Tron',
    addressKind: 'tron',
    confirmationsRequired: 19,
    blockTimeSeconds: 3,
    sandboxFeeUsdCents: 12,
    dynamicFee: false,
    adapterAvailable: true,
    color: '#eb0029',
  },
  ETHEREUM: {
    code: 'ETHEREUM',
    name: 'Ethereum Mainnet',
    shortName: 'Ethereum',
    addressKind: 'evm',
    confirmationsRequired: 12,
    blockTimeSeconds: 12,
    sandboxFeeUsdCents: 185,
    dynamicFee: true,
    adapterAvailable: true,
    color: '#5b7fff',
  },
  SOLANA: {
    code: 'SOLANA',
    name: 'Solana',
    shortName: 'Solana',
    addressKind: 'solana',
    confirmationsRequired: 32,
    blockTimeSeconds: 0.4,
    sandboxFeeUsdCents: 1,
    dynamicFee: true,
    adapterAvailable: true,
    color: '#14f195',
  },
  BNB_CHAIN: {
    code: 'BNB_CHAIN',
    name: 'BNB Smart Chain',
    shortName: 'BNB Chain',
    addressKind: 'evm',
    confirmationsRequired: 15,
    blockTimeSeconds: 3,
    sandboxFeeUsdCents: 8,
    dynamicFee: false,
    adapterAvailable: true,
    color: '#f0b90b',
  },
  BASE: {
    code: 'BASE',
    name: 'Base',
    shortName: 'Base',
    addressKind: 'evm',
    confirmationsRequired: 12,
    blockTimeSeconds: 2,
    sandboxFeeUsdCents: 2,
    dynamicFee: false,
    adapterAvailable: false,
    color: '#3b82f6',
  },
  ARBITRUM: {
    code: 'ARBITRUM',
    name: 'Arbitrum One',
    shortName: 'Arbitrum',
    addressKind: 'evm',
    confirmationsRequired: 20,
    blockTimeSeconds: 0.3,
    sandboxFeeUsdCents: 3,
    dynamicFee: false,
    adapterAvailable: false,
    color: '#28a0f0',
  },
  BITCOIN: {
    code: 'BITCOIN',
    name: 'Bitcoin',
    shortName: 'Bitcoin',
    addressKind: 'bitcoin',
    confirmationsRequired: 2,
    blockTimeSeconds: 600,
    sandboxFeeUsdCents: 220,
    dynamicFee: true,
    adapterAvailable: false,
    color: '#f7931a',
  },
  FIAT: {
    code: 'FIAT',
    name: 'Fiat ledger',
    shortName: 'Fiat',
    addressKind: 'evm',
    confirmationsRequired: 0,
    blockTimeSeconds: 0,
    sandboxFeeUsdCents: 0,
    dynamicFee: false,
    adapterAvailable: false,
    color: '#94a3b8',
  },
};

export const SUPPORTED_NETWORKS = ['TRON', 'ETHEREUM', 'SOLANA', 'BNB_CHAIN'] as const;
export type SupportedNetwork = (typeof SUPPORTED_NETWORKS)[number];

export function networkDefinition(code: NetworkCode): NetworkDefinition {
  const def = NETWORKS[code];
  if (!def) throw new Error(`unknown network ${code}`);
  return def;
}

/** Expected confirmation seconds for copy such as "settles in ~1 min". */
export function confirmationEtaSeconds(code: NetworkCode): number {
  const def = networkDefinition(code);
  return Math.max(1, Math.round(def.confirmationsRequired * def.blockTimeSeconds));
}
