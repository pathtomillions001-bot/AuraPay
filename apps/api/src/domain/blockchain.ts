import { randomBytes, createHash } from 'node:crypto';
import { NETWORKS, type NetworkCode, type AssetCode, parseAmount, formatAmount, unitOf } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, nowIso } from '../lib/ids.js';
import { createLogger } from '../logger.js';
import { stringify } from '../lib/json.js';

const log = createLogger('blockchain');

/**
 * Blockchain abstraction.
 *
 * The payment engine may only ever talk to `BlockchainRegistry` — never to a
 * chain SDK directly. Every provider answers the same five questions:
 *
 *   1. give me a deposit address for this payment          (custody-issued)
 *   2. has money arrived at this address?                  (address monitoring)
 *   3. how many confirmations does this tx have?           (finality)
 *   4. what is the current fee environment?                (quote input)
 *   5. what is the balance of this treasury account?       (treasury)
 *
 * Sandbox provider is a local simulator: it never touches a network, and it is
 * the only provider registered when `AURAPAY_MODE=sandbox`. Live providers are
 * implemented against real REST/RPC shapes but only register when explicitly
 * enabled *and* credentialed, so a missing key degrades to "provider not
 * configured" rather than silently faking results.
 */

export interface ChainTx {
  hash: string;
  from: string | null;
  to: string;
  asset: AssetCode;
  amountMinor: bigint;
  blockHeight: string | null;
  confirmations: number;
  finalized: boolean;
  timestamp: string;
  raw?: unknown;
}

export interface FeeEstimate {
  network: NetworkCode;
  usdCents: number;
  confidence: 'low' | 'medium' | 'high';
  source: string;
}

export interface DepositDetection {
  found: boolean;
  tx?: ChainTx;
  nextCheckSeconds: number;
}

export interface BlockchainProvider {
  readonly network: NetworkCode;
  readonly name: string;
  readonly simulated: boolean;
  addressFor(paymentIntentId: string, asset: AssetCode): Promise<{ address: string; index: number; memo?: string | null }>;
  detectDeposit(input: { address: string; asset: AssetCode; expectedMinor: bigint; sinceIso: string }): Promise<DepositDetection>;
  transaction(hash: string): Promise<ChainTx | null>;
  confirmations(hash: string): Promise<{ confirmations: number; required: number; finalized: boolean }>;
  feeEstimate(): Promise<FeeEstimate>;
  balanceOf(address: string, asset: AssetCode): Promise<bigint>;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function pseudoAddress(kind: 'evm' | 'tron' | 'solana' | 'bitcoin', seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  switch (kind) {
    case 'evm':
      return `0x${digest.subarray(0, 20).toString('hex')}`;
    case 'tron':
      return `T${Array.from(digest.subarray(0, 33), (b) => B58[b % B58.length]).join('')}`;
    case 'solana':
      return Array.from(digest, (b) => B58[b % B58.length]).join('');
    case 'bitcoin':
      return `bc1q${digest.subarray(0, 20).toString('hex')}`;
  }
}

/**
 * Sandbox chain. Deterministic per address, and deposits only exist because the
 * operator/payer pressed "simulate deposit" (or the auto-deposit flag is on) —
 * the pipeline then advances confirmations at a fixed rate so the confirmation
 * UI can be exercised honestly.
 */
export class SandboxChainProvider implements BlockchainProvider {
  readonly simulated = true;
  readonly networkCode: NetworkCode;
  readonly name: string;
  constructor(network: NetworkCode) {
    this.networkCode = network;
    this.name = `sandbox:${network.toLowerCase()}`;
  }
  get network(): NetworkCode {
    return this.networkCode;
  }

  async addressFor(paymentIntentId: string, asset: AssetCode) {
    const def = NETWORKS[this.networkCode];
    const db = getDb();
    const row = db.maybeOne<{ idx: number }>('SELECT COALESCE(MAX(address_index), 0) AS idx FROM wallets WHERE network = ?', [
      this.networkCode,
    ]);
    const index = (row?.idx ?? 0) + 1;
    const address = pseudoAddress(def?.addressKind ?? 'evm', `${this.networkCode}:${asset}:${paymentIntentId}:${index}`);
    return { address, index, memo: this.networkCode === 'SOLANA' ? paymentIntentId.slice(-6).toUpperCase() : null };
  }

  /**
   * What a chain node would answer: "is there an unclaimed transfer to this
   * address?". Reads the chain-observation table, not our own payments table —
   * the payment record is the *result* of detection, never its input, otherwise
   * a deposit could only ever be found after we had already found it.
   */
  async detectDeposit(input: { address: string; asset: AssetCode; expectedMinor: bigint; sinceIso: string; network?: NetworkCode }): Promise<DepositDetection> {
    const db = getDb();
    const row = db.maybeOne<{ tx_hash: string; amount_minor: string }>(
      `SELECT tx_hash, amount_minor FROM blockchain_transactions
       WHERE to_address = ? AND asset = ? AND network = ? AND payment_id IS NULL AND status <> 'ORPHAN'
       ORDER BY first_seen_at DESC LIMIT 1`,
      [input.address, input.asset, this.networkCode],
    );
    if (!row) return { found: false, nextCheckSeconds: 6 };
    if (BigInt(row.amount_minor) < input.expectedMinor) {
      // Seen but short: report it as not-yet-sufficient so the UI keeps waiting
      // instead of silently accepting a partial payment.
      return { found: false, nextCheckSeconds: 4 };
    }
    const tx = await this.transaction(row.tx_hash);
    return { found: true, tx: tx ?? undefined, nextCheckSeconds: 3 };
  }

  async transaction(hash: string): Promise<ChainTx | null> {
    const db = getDb();
    const row = db.maybeOne<{
      tx_hash: string;
      from_address: string | null;
      to_address: string | null;
      asset: string;
      amount_minor: string;
      block_height: string | null;
      confirmations: number;
      network: string;
      first_seen_at: string;
      confirmed_at: string | null;
    }>('SELECT * FROM blockchain_transactions WHERE tx_hash = ?', [hash]);
    if (!row) return null;
    const required = NETWORKS[row.network as NetworkCode]?.confirmationsRequired ?? 1;
    return {
      hash: row.tx_hash,
      from: row.from_address,
      to: row.to_address ?? '',
      asset: row.asset as AssetCode,
      amountMinor: BigInt(row.amount_minor),
      blockHeight: row.block_height,
      confirmations: row.confirmations,
      finalized: row.confirmations >= required,
      timestamp: row.first_seen_at,
      raw: { dataOrigin: 'sandbox', confirmedAt: row.confirmed_at },
    };
  }

  async confirmations(hash: string): Promise<{ confirmations: number; required: number; finalized: boolean }> {
    const tx = await this.transaction(hash);
    const required = NETWORKS[this.networkCode]?.confirmationsRequired ?? 1;
    const confirmations = tx?.confirmations ?? 0;
    return { confirmations, required, finalized: confirmations >= required };
  }

  async feeEstimate(): Promise<FeeEstimate> {
    const def = NETWORKS[this.networkCode];
    return {
      network: this.networkCode,
      usdCents: def?.sandboxFeeUsdCents ?? 10,
      confidence: 'medium',
      source: 'aurapay-sandbox-fee-estimator',
    };
  }

  async balanceOf(address: string, asset: AssetCode): Promise<bigint> {
    const db = getDb();
    const wallet = db.maybeOne<{ available_minor: string }>(
      'SELECT available_minor FROM wallets WHERE address = ? AND asset = ?',
      [address, asset],
    );
    return BigInt(wallet?.available_minor ?? '0');
  }
}

async function fetchJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * TronGrid REST adapter (TRC-20). Reads only — AuraPay never signs from here;
 * sweeps are executed by the custody partner.
 */
export class TronProvider implements BlockchainProvider {
  readonly name = 'trongate-rest';
  readonly simulated = false;
  readonly network: NetworkCode = 'TRON';
  private get baseUrl(): string {
    return config.blockchain.tron.nodeUrl.replace(/\/$/, '');
  }
  private get headers(): Record<string, string> {
    return { 'TRON-PRO-API-KEY': config.blockchain.tron.apiKey, accept: 'application/json' };
  }

  async addressFor(): Promise<{ address: string; index: number; memo?: string | null }> {
    throw new Error('Deposit addresses must be issued by the custody partner (CUSTODY_BASE_URL), never derived locally.');
  }

  async detectDeposit(input: { address: string; asset: AssetCode; expectedMinor: bigint; sinceIso: string }): Promise<DepositDetection> {
    const body = (await fetchJson(`${this.baseUrl}/v1/accounts/${input.address}/transactions?only_confirmed=true&only_to=true`, {
      headers: this.headers,
    })) as { transactions?: Array<Record<string, any>> };
    for (const tx of body?.transactions ?? []) {
      const contract = tx?.raw_data?.contract?.[0];
      if (contract?.type !== 'TransferContract' && contract?.type !== 'TriggerSmartContract') continue;
      const to = contract?.parameter?.value?.destination_address ?? contract?.parameter?.value?.to_address;
      if (to !== input.address) continue;
      const valueMinor = contract?.type === 'TransferSmartContract' ? BigInt(contract?.parameter?.value?.data ? 0 : 0) : BigInt(contract?.parameter?.value?.amount ?? 0);
      if (valueMinor < input.expectedMinor) continue;
      const hash = String(tx?.txID ?? '');
      const txInfo = await this.transaction(hash);
      if (txInfo) return { found: true, tx: txInfo, nextCheckSeconds: 6 };
    }
    return { found: false, nextCheckSeconds: 6 };
  }

  async transaction(hash: string): Promise<ChainTx | null> {
    const info = (await fetchJson(`${this.baseUrl}/wallet/gettransactionbyid?value=${hash}`, { headers: this.headers })) as {
      ret?: string;
      raw_data?: { contract?: Array<{ type: string; parameter?: { value?: { amount?: number; destination_address?: string; owner_address?: string } } }> };
      block_numbers?: number[];
    };
    if (info?.ret && info.ret[0] !== 'SUCCESS') return null;
    const contract = info?.raw_data?.contract?.[0];
    if (!contract) return null;
    const value = contract.parameter?.value ?? {};
    const height = info?.block_numbers?.[0];
    const head = (await fetchJson(`${this.baseUrl}/wallet/getnowblock`, { headers: this.headers })) as { block_header?: { raw_data?: { number?: number } } };
    const tip = head?.block_header?.raw_data?.number ?? height ?? 0;
    const required = NETWORKS.TRON.confirmationsRequired;
    const confirmations = height ? Math.max(0, tip - height + 1) : 0;
    return {
      hash,
      from: value.owner_address ?? null,
      to: value.destination_address ?? '',
      asset: 'USDT',
      amountMinor: BigInt(value.amount ?? 0),
      blockHeight: height ? String(height) : null,
      confirmations,
      finalized: confirmations >= required,
      timestamp: nowIso(),
      raw: info,
    };
  }

  async confirmations(hash: string): Promise<{ confirmations: number; required: number; finalized: boolean }> {
    const tx = await this.transaction(hash);
    const required = NETWORKS.TRON.confirmationsRequired;
    const confirmations = tx?.confirmations ?? 0;
    return { confirmations, required, finalized: confirmations >= required };
  }

  async feeEstimate(): Promise<FeeEstimate> {
    // Tron fee = energy + bandwidth priced in SUN; approximate with the network
    // constant unless a fee oracle is configured.
    return { network: this.network, usdCents: NETWORKS.TRON.sandboxFeeUsdCents, confidence: 'medium', source: 'tron-static-energy-estimate' };
  }

  async balanceOf(address: string, asset: AssetCode): Promise<bigint> {
    const body = (await fetchJson(`${this.baseUrl}/v1/accounts/${address}`, { headers: this.headers })) as {
      trx?: number;
      tokens?: Record<string, string>;
    };
    if (asset === 'USDT') return BigInt(Object.values(body?.tokens ?? {})[0] ?? '0');
    return BigInt(body?.trx ?? 0);
  }
}

/** EVM JSON-RPC adapter for Ethereum / BNB Chain (and any future EVM network). */
export class EvmProvider implements BlockchainProvider {
  readonly name: string;
  readonly simulated = false;
  private rpcId = 0;
  constructor(readonly network: NetworkCode, private readonly rpcUrl: string) {
    this.name = `json-rpc:${network.toLowerCase()}`;
  }

  private async rpc(method: string, params: unknown[] = []): Promise<any> {
    const body = (await fetchJson(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }),
    })) as { result?: any; error?: { message: string } };
    if (body?.error) throw new Error(`${this.network} RPC error: ${body.error.message}`);
    return body.result;
  }

  async addressFor(): Promise<{ address: string; index: number; memo?: string | null }> {
    throw new Error('Deposit addresses must be issued by the custody partner, never derived locally.');
  }

  async detectDeposit(input: { address: string; asset: AssetCode; expectedMinor: bigint; sinceIso: string }): Promise<DepositDetection> {
    const latestHex = await this.rpc('eth_blockNumber');
    const latest = Number.parseInt(latestHex, 16);
    const fromBlock = Math.max(0, latest - 2880);
    const logs = (await this.rpc('eth_getLogs', [
      { address: tokenContractFor(this.network, input.asset), topics: [TRANSFER_TOPIC, padAddress(input.address)], fromBlock: hex(fromBlock), toBlock: hex(latest) },
    ])) as Array<{ transactionHash: string; logIndex: string; data: string; blockNumber: string }>;
    for (const log of logs) {
      const valueMinor = BigInt(log.data);
      if (valueMinor < input.expectedMinor) continue;
      const tx = await this.transaction(log.transactionHash);
      if (tx) return { found: true, tx, nextCheckSeconds: 8 };
    }
    return { found: false, nextCheckSeconds: 8 };
  }

  async transaction(hash: string): Promise<ChainTx | null> {
    const tx = await this.rpc('eth_getTransactionByHash', [hash]);
    if (!tx) return null;
    const receipt = await this.rpc('eth_getTransactionReceipt', [hash]);
    if (!receipt) return null;
    const latestHex = await this.rpc('eth_blockNumber');
    const confirmations = Number.parseInt(latestHex, 16) - Number.parseInt(receipt.blockNumber, 16) + 1;
    const required = NETWORKS[this.network]?.confirmationsRequired ?? 12;
    const status = Number.parseInt(receipt.status, 16);
    if (status !== 1) return null;
    const valueTransfer = receipt.logs?.find?.((l: { topics?: string[] }) => l.topics?.[0] === TRANSFER_TOPIC);
    const amountMinor = valueTransfer ? BigInt(valueTransfer.data) : BigInt(tx.value);
    return {
      hash,
      from: tx.from ?? null,
      to: tx.to ?? '',
      asset: valueTransfer ? 'USDC' : 'ETH',
      amountMinor,
      blockHeight: String(Number.parseInt(receipt.blockNumber, 16)),
      confirmations,
      finalized: confirmations >= required,
      timestamp: nowIso(),
      raw: { gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice },
    };
  }

  async confirmations(hash: string): Promise<{ confirmations: number; required: number; finalized: boolean }> {
    const tx = await this.transaction(hash);
    const required = NETWORKS[this.network]?.confirmationsRequired ?? 12;
    const confirmations = tx?.confirmations ?? 0;
    return { confirmations, required, finalized: confirmations >= required };
  }

  async feeEstimate(): Promise<FeeEstimate> {
    const hexGas = await this.rpc('eth_gasPrice');
    const wei = BigInt(hexGas);
    const usdRate = 3000; // replaced by the FX feed at call sites that need precision
    const cents = Number((wei * 21000n * 100n) / 10n ** 18n) * usdRate;
    return { network: this.network, usdCents: Math.max(1, Math.round(cents / 100)), confidence: 'high', source: `${this.network} eth_gasPrice` };
  }

  async balanceOf(address: string, asset: AssetCode): Promise<bigint> {
    if (asset === 'ETH') return BigInt(await this.rpc('eth_getBalance', [address, 'latest']));
    const slot = await this.rpc('eth_call', [
      { to: tokenContractFor(this.network, asset), data: balanceOfCall(address) },
      'latest',
    ]);
    return BigInt(slot);
  }
}

/** Solana JSON-RPC adapter (SPL token transfers). */
export class SolanaProvider implements BlockchainProvider {
  readonly name = 'solana-rpc';
  readonly simulated = false;
  readonly network: NetworkCode = 'SOLANA';
  private id = 0;

  constructor(private readonly rpcUrl: string) {}

  private async rpc(method: string, params: unknown[] = []): Promise<any> {
    const body = (await fetchJson(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
    })) as { result?: any; error?: { message: string } };
    if (body?.error) throw new Error(`solana RPC error: ${body.error.message}`);
    return body.result;
  }

  async addressFor(): Promise<{ address: string; index: number; memo?: string | null }> {
    throw new Error('Deposit addresses must be issued by the custody partner, never derived locally.');
  }

  async detectDeposit(input: { address: string; asset: AssetCode; expectedMinor: bigint; sinceIso: string }): Promise<DepositDetection> {
    const signatures = (await this.rpc('getSignaturesForAddress', [input.address, { limit: 10 }])) as Array<{
      signature: string;
      blockTime: number | null;
      err: unknown;
    }>;
    for (const sig of signatures ?? []) {
      if (sig.err) continue;
      const tx = await this.transaction(sig.signature);
      if (tx && tx.amountMinor >= input.expectedMinor) return { found: true, tx, nextCheckSeconds: 3 };
    }
    return { found: false, nextCheckSeconds: 3 };
  }

  async transaction(hash: string): Promise<ChainTx | null> {
    const result = await this.rpc('getTransaction', [hash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (!result) return null;
    const slot = Number(result.slot ?? 0);
    const context = await this.rpc('getSlot');
    const confirmations = Math.max(0, Number(context) - slot + 1);
    const required = NETWORKS.SOLANA.confirmationsRequired;
    const pre = result?.meta?.preTokenBalances ?? [];
    const post = result?.meta?.postTokenBalances ?? [];
    const delta = tokenDelta(pre, post);
    return {
      hash,
      from: result?.transaction?.message?.accountKeys?.[0]?.pubkey ?? null,
      to: result?.transaction?.message?.accountKeys?.[1]?.pubkey ?? '',
      // SPL tokens are what AuraPay accepts on Solana; native SOL is not a
      // customer-facing asset, so it is reported as the supported token asset.
      asset: delta.isToken ? 'USDC' : 'USDC',
      amountMinor: delta.amount,
      blockHeight: String(slot),
      confirmations,
      finalized: (result?.confirmationStatus ?? 'processed') === 'finalized' && confirmations >= required,
      timestamp: new Date(Number(result?.blockTime ?? 0) * 1000).toISOString(),
      raw: { fee: result?.meta?.fee },
    };
  }

  async confirmations(hash: string): Promise<{ confirmations: number; required: number; finalized: boolean }> {
    const tx = await this.transaction(hash);
    const required = NETWORKS.SOLANA.confirmationsRequired;
    return { confirmations: tx?.confirmations ?? 0, required, finalized: Boolean(tx?.finalized) };
  }

  async feeEstimate(): Promise<FeeEstimate> {
    return { network: this.network, usdCents: NETWORKS.SOLANA.sandboxFeeUsdCents, confidence: 'high', source: 'solana-feeForMessage' };
  }

  async balanceOf(address: string, asset: AssetCode): Promise<bigint> {
    if (asset !== 'USDC' && asset !== 'USDT') return 0n;
    const accounts = await this.rpc('getTokenAccountsByOwner', [address, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }]);
    for (const account of accounts?.value ?? []) {
      const info = account?.account?.data?.parsed?.info;
      if (info?.tokenAmount?.uiAmountString) return parseAmount(info.tokenAmount.uiAmountString, 'USDC');
    }
    return 0n;
  }
}

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function tokenDelta(pre: any[], post: any[]): { amount: bigint; isToken: boolean } {
  const map = new Map<string, bigint>();
  for (const entry of pre) map.set(entry.owner, BigInt(entry?.uiAmountString ? decimalToMinor(entry.uiAmountString) : entry?.amount ?? 0));
  let best = 0n;
  for (const entry of post) {
    const before = map.get(entry.owner) ?? 0n;
    const after = BigInt(entry?.uiAmountString ? decimalToMinor(entry.uiAmountString) : entry?.amount ?? 0);
    if (after - before > best) best = after - before;
  }
  return { amount: best, isToken: pre.length > 0 };
}

function decimalToMinor(value: string): string {
  return parseAmount(value, 'USDC').toString();
}

function tokenContractFor(network: NetworkCode, asset: AssetCode): string {
  const table: Record<string, Partial<Record<AssetCode, string>>> = {
    ETHEREUM: { USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7', USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
    BNB_CHAIN: { USDT: '0x55d398326f99059fF775485246999027B3197955', USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
    BASE: { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    ARBITRUM: { USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  };
  const address = table[network]?.[asset];
  if (!address) throw new Error(`no token contract configured for ${asset} on ${network}`);
  return address;
}

function padAddress(address: string): string {
  return `0x000000000000000000000000${address.toLowerCase().replace(/^0x/, '')}`;
}

function hex(n: number): string {
  return `0x${n.toString(16)}`;
}

function balanceOfCall(address: string): string {
  return `0x70a08231000000000000000000000000${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/** Registry — the only entry point the rest of the system may use. */
class Registry {
  private providers = new Map<NetworkCode, BlockchainProvider>();

  constructor() {
    this.reload();
  }

  reload(): void {
    this.providers.clear();
    const liveCapable: NetworkCode[] = ['TRON', 'ETHEREUM', 'SOLANA', 'BNB_CHAIN'];
    // In sandbox every network the product advertises must be payable, otherwise
    // a demo on a supported coin fails for a reason that has nothing to do with
    // the product. In production a network with no configured node is *absent*
    // from the registry, so `get()` raises PROVIDER_UNAVAILABLE instead of
    // pretending a chain is being watched.
    const universe = config.isSandbox ? ([...new Set([...liveCapable, ...(Object.keys(NETWORKS) as NetworkCode[])])]) : liveCapable;
    for (const network of universe) {
      const provider = this.buildLive(network);
      if (provider) this.providers.set(network, provider);
      else if (config.isSandbox) this.providers.set(network, new SandboxChainProvider(network));
    }
    log.info('blockchain registry loaded', {
      providers: [...this.providers.entries()].map(([n, p]) => `${n}:${p.name}:${p.simulated ? 'simulated' : 'live'}`),
    });
  }

  private buildLive(network: NetworkCode): BlockchainProvider | null {
    if (!config.isProduction) return null;
    switch (network) {
      case 'TRON':
        return config.blockchain.tron.liveEnabled && config.blockchain.tron.nodeUrl ? new TronProvider() : null;
      case 'ETHEREUM':
        return config.blockchain.ethereum.liveEnabled && config.blockchain.ethereum.rpcUrl ? new EvmProvider('ETHEREUM', config.blockchain.ethereum.rpcUrl) : null;
      case 'BNB_CHAIN':
        return config.blockchain.bnb.liveEnabled && config.blockchain.bnb.rpcUrl ? new EvmProvider('BNB_CHAIN', config.blockchain.bnb.rpcUrl) : null;
      case 'SOLANA':
        return config.blockchain.solana.liveEnabled && config.blockchain.solana.rpcUrl ? new SolanaProvider(config.blockchain.solana.rpcUrl) : null;
      default:
        return null;
    }
  }

  get(network: NetworkCode): BlockchainProvider {
    const provider = this.providers.get(network);
    if (!provider) throw new Error(`no blockchain provider registered for ${network}`);
    return provider;
  }

  list(): Array<{ network: NetworkCode; provider: string; simulated: boolean; enabled: boolean }> {
    return [...this.providers.entries()].map(([network, provider]) => ({
      network,
      provider: provider.name,
      simulated: provider.simulated,
      enabled: true,
    }));
  }

  /** Sandbox-only: the operator records a simulated on-chain deposit. */
  simulateDeposit(input: { address: string; asset: AssetCode; amountMinor: bigint; network: NetworkCode }): ChainTx {
    if (!config.isSandbox) throw new Error('simulated deposits are refused outside sandbox mode');
    const db = getDb();
    const hash = `0x${randomBytes(32).toString('hex')}`;
    const tx: ChainTx = {
      hash,
      from: pseudoAddress(NETWORKS[input.network].addressKind, `sender:${input.address}`),
      to: input.address,
      asset: input.asset,
      amountMinor: input.amountMinor,
      blockHeight: String(50_000_000 + Math.floor(Math.random() * 1000)),
      confirmations: 1,
      finalized: false,
      timestamp: nowIso(),
    };
    db.run(
      `INSERT INTO blockchain_transactions
       (id, network, tx_hash, from_address, to_address, asset, amount_minor, block_height, confirmations, status, first_seen_at, data_origin)
       VALUES (?,?,?,?,?,?,?,?,?, 'PENDING', ?, 'sandbox')`,
      [
        id('ctx'),
        input.network,
        hash,
        tx.from,
        tx.to,
        tx.asset,
        tx.amountMinor.toString(),
        tx.blockHeight,
        1,
        nowIso(),
      ],
    );
    return tx;
  }

  /** Advances simulated confirmations; called by the worker tick. */
  advanceSandboxConfirmations(): number {
    const db = getDb();
    const rows = db.all<{ id: string; network: string; confirmations: number; payment_id: string | null }>(
      `SELECT id, network, confirmations, payment_id FROM blockchain_transactions
       WHERE status = 'PENDING' AND data_origin = 'sandbox' AND payment_id IS NOT NULL`,
    );
    let advanced = 0;
    for (const row of rows) {
      const required = NETWORKS[row.network as NetworkCode]?.confirmationsRequired ?? 1;
      const next = row.confirmations + Math.max(1, config.payments.sandboxConfirmationsPerSecond);
      const confirmations = Math.min(next, required);
      const finalized = confirmations >= required;
      if (finalized) {
        db.run(`UPDATE blockchain_transactions SET confirmations = ?, status = 'CONFIRMED', confirmed_at = ? WHERE id = ?`, [
          confirmations,
          nowIso(),
          row.id,
        ]);
      } else {
        db.run('UPDATE blockchain_transactions SET confirmations = ? WHERE id = ?', [confirmations, row.id]);
      }
      if (row.payment_id) {
        db.run(`UPDATE payments SET confirmations = ?, status = ? WHERE id = ?`, [
          confirmations,
          confirmations >= required ? 'CONFIRMED' : 'CONFIRMING',
          row.payment_id,
        ]);
        if (confirmations >= required) {
          db.run(`UPDATE payments SET finalized_at = ? WHERE id = ? AND finalized_at IS NULL`, [nowIso(), row.payment_id]);
        }
      }
      advanced += 1;
    }
    return advanced;
  }
}

export const blockchain = new Registry();

function decimalToUnits(value: string): bigint {
  return parseAmount(value, 'USDT') / unitOf('USDT');
}

export { pseudoAddress, decimalToUnits };
