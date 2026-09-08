import { ASSETS, DomainError, NETWORKS, formatKes, parseAmount, type AssetCode, type NetworkCode, type PayableAsset } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, nowIso } from '../lib/ids.js';
import * as payments from './payments.js';
import * as paymentCore from './paymentCore.js';
import * as paymentRepo from './paymentRepo.js';
import * as wallets from './wallets.js';
import * as payouts from './payouts.js';
import * as ledger from './ledger.js';
import { blockchain } from './blockchain.js';
import { insert } from '../db/rows.js';
import { createLogger } from '../logger.js';

const log = createLogger('sandbox');

/**
 * Sandbox controls and the demo network feed.
 *
 * Two separate things live here, and they must never be confused:
 *
 *   1. **Sandbox actions** — buttons/endpoints that make the simulated pipeline
 *      move (a deposit appears, confirmations advance, a payout fails). They are
 *      refused outright when `MODE=production`, and every row they touch is
 *      tagged `data_origin='sandbox'`. They change *state*, and the UI renders
 *      whatever state results — never the other way round.
 *
 *   2. **The demo network feed** — the synthetic flow data behind the landing
 *      page's global visualization. It is generated noise, clearly labelled
 *      `simulated`, and it is never mixed into a user's transaction list, a
 *      receipt, an admin number, or an analytics figure.
 */

export function status() {
  return {
    mode: config.mode,
    sandbox: config.isSandbox,
    actionsEnabled: config.demo.sandboxActions,
    productionReady: !config.isSandbox,
    legalNote:
      'Sandbox environment: crypto deposits, blockchain confirmations, FX rates and payout outcomes are simulated by AuraPay. ' +
      'No real money moves and no real network is touched. Simulated records are tagged and never mixed with production data.',
    components: [
      { name: 'Blockchain', provider: 'SandboxChain', simulated: true, note: 'Addresses are pseudo-derived, confirmations advance on a timer.' },
      { name: 'FX feed', provider: config.fx.provider, simulated: true, note: 'A deterministic local rate feed. Rates are marked simulated and expire.' },
      { name: 'Payout rails', provider: 'aurapay-sandbox-simulator', simulated: true, note: 'No M-Pesa, Airtel, PesaLink or bank API is called.' },
      { name: 'KYC / screening', provider: config.compliance.kycProvider === 'none' ? 'internal_rules' : config.compliance.kycProvider, simulated: true, note: 'Local rules over a demo watchlist. Not a sanctions screening service.' },
      { name: 'Notifications', provider: 'console', simulated: true, note: 'In-app only; email/SMS are logged, not sent.' },
    ],
  };
}

function assertSandbox(): void {
  if (!config.isSandbox || !config.demo.sandboxActions) {
    throw new DomainError(
      'FORBIDDEN',
      'Sandbox controls are disabled. In production this endpoint does nothing, because a payment state can only be reached by real evidence.',
    );
  }
}

/** Make a matching on-chain deposit appear for a payment awaiting it. */
export async function simulateDeposit(input: { paymentId: string; amountMajor?: string; asset?: PayableAsset }): Promise<{ txHash: string; confirmations: number }> {
  assertSandbox();
  const row = paymentRepo.requireById(input.paymentId);
  if (!row.deposit_address) {
    throw new DomainError('INTERNAL', 'This payment has no deposit address, so there is nothing to simulate against.');
  }
  const asset = (input.asset ?? row.asset) as PayableAsset;
  const amountMinor = input.amountMajor
    ? parseAmount(input.amountMajor, asset)
    : BigInt(row.total_debit_minor);
  const tx = blockchain.simulateDeposit({
    address: row.deposit_address,
    asset: asset as AssetCode,
    amountMinor,
    network: row.network as NetworkCode,
  });
  if (!tx) throw new DomainError('INTERNAL', 'The sandbox chain provider is not available in this build.');
  log.info('simulated deposit', { payment: row.reference, hash: tx.hash, amountMinor: amountMinor.toString() });
  await payments.drive(input.paymentId, 'sandbox-action');
  return { txHash: tx.hash, confirmations: tx.confirmations };
}

/** Advance every sandbox deposit's confirmation count one tick. */
export async function advanceConfirmations(): Promise<{ advanced: number; states: Record<string, number> }> {
  assertSandbox();
  const advanced = blockchain.advanceSandboxConfirmations();
  const open = getDb().all<{ id: string }>(
    `SELECT id FROM payment_intents WHERE status IN ('AWAITING_PAYMENT','PAYMENT_DETECTED','BLOCKCHAIN_CONFIRMING','RISK_REVIEW','CONVERSION_PENDING','LIQUIDITY_RESERVED','FIAT_SETTLEMENT_PENDING','PAYOUT_SUBMITTED')
     ORDER BY updated_at LIMIT 20`,
  );
  const states: Record<string, number> = {};
  for (const row of open) {
    await payments.drive(row.id, 'sandbox-action');
    const status = paymentRepo.byId(row.id)?.status ?? 'UNKNOWN';
    states[status] = (states[status] ?? 0) + 1;
  }
  return { advanced, states };
}

/** Force an outcome to exercise failure and refund paths. */
export async function forceOutcome(
  paymentId: string,
  outcome: 'PAYOUT_FAIL' | 'MANUAL_REVIEW' | 'CONFIRM_NOW' | 'QUOTE_EXPIRE',
): Promise<{ state: string; detail: string }> {
  assertSandbox();
  const row = paymentRepo.requireById(paymentId);
  switch (outcome) {
    case 'PAYOUT_FAIL': {
      await paymentCore.failPayment(
        paymentId,
        'SANDBOX_FORCED_FAILURE',
        'Simulated rail failure for testing. The pipeline returned the funds to the payer exactly as it would for a real rejection.',
        'retry_payment',
      );
      return { state: paymentRepo.byId(paymentId)?.status ?? 'FAILED', detail: 'payout marked failed' };
    }
    case 'MANUAL_REVIEW': {
      getDb().run(`UPDATE payment_intents SET risk_decision = 'MANUAL_REVIEW', risk_level = 'HIGH', risk_score = 82 WHERE id = ?`, [paymentId]);
      const openCase = ledger.journalGroupsFor(paymentId);
      void openCase;
      return { state: row.status, detail: 'risk decision set to MANUAL_REVIEW; the payment will park on the next pipeline step' };
    }
    case 'CONFIRM_NOW': {
      const payout = paymentRepo.latestPayout(paymentId);
      if (!payout) throw new DomainError('CONFLICT', 'There is no payout to confirm yet — this payment has not reached the rail.');
      paymentCore.confirmPayout(paymentId, payout.provider_reference ?? 'SANDBOX-MANUAL', 'operator confirmed delivery in sandbox');
      return { state: paymentRepo.byId(paymentId)?.status ?? 'COMPLETED', detail: 'payout confirmed' };
    }
    case 'QUOTE_EXPIRE': {
      if (row.quote_id) {
        getDb().run(`UPDATE quotes SET status = 'EXPIRED', expires_at = ?, invalidated_reason = 'sandbox: forced expiry' WHERE id = ?`, [nowIso(), row.quote_id]);
      }
      await payments.expire(paymentId, 'sandbox: forced expiry');
      return { state: paymentRepo.byId(paymentId)?.status ?? 'FAILED', detail: 'deposit window closed' };
    }
  }
}

/** Credit a sandbox wallet with test funds (opening-balance journal, tagged). */
export function topUp(input: { userId: string; asset: PayableAsset; network: NetworkCode; amountMajor: string; memo?: string }): { availableMinor: string } {
  assertSandbox();
  const amountMinor = parseAmount(input.amountMajor, input.asset);
  if (amountMinor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Enter an amount greater than zero.');
  wallets.openBalance({
    userId: input.userId,
    asset: input.asset,
    network: input.network,
    amountMinor,
    memo: input.memo ?? 'Sandbox top-up — simulated funds, not a real deposit',
  });
  const wallet = wallets.walletFor(input.userId, input.asset, input.network);
  return { availableMinor: wallet?.available_minor ?? '0' };
}

/** Re-run the payout engine for a payment stuck waiting on a partner. */
export async function retryPayout(paymentId: string): Promise<{ state: string }> {
  assertSandbox();
  const payout = paymentRepo.latestPayout(paymentId);
  if (!payout) throw new DomainError('NOT_FOUND', 'No payout exists for that payment yet.');
  await payouts.execute(payout.id);
  return { state: paymentRepo.byId(paymentId)?.status ?? 'UNKNOWN' };
}

/** Ledger + wallet self-check, exposed in the sandbox panel. */
export function integrity(): { problems: number; details: Array<{ kind: string; ref: string; detail: string }>; ok: boolean } {
  const details = ledger.verify();
  return { problems: details.length, details: details.slice(0, 20), ok: details.length === 0 };
}

/* ------------------------------------------------------------------ *
 * Demo network feed — synthetic, for the landing visualization only
 * ------------------------------------------------------------------ */

export interface DemoCorridor {
  id: string;
  from: string;
  fromCountry: string;
  to: string;
  toCountry: string;
  asset: PayableAsset;
  rail: string;
  amountUsd: number;
  outcome: 'settled' | 'pending' | 'failed';
  latencySeconds: number;
  at: string;
  simulated: true;
}

const CORRIDORS: Array<{ from: string; fromCountry: string; to: string; toCountry: string; rail: string; weight: number }> = [
  { from: 'Dubai', fromCountry: 'AE', to: 'Nairobi', toCountry: 'KE', rail: 'MPESA', weight: 9 },
  { from: 'London', fromCountry: 'GB', to: 'Nairobi', toCountry: 'KE', rail: 'MPESA', weight: 8 },
  { from: 'San Francisco', fromCountry: 'US', to: 'Nairobi', toCountry: 'KE', rail: 'MPESA', weight: 7 },
  { from: 'Toronto', fromCountry: 'CA', to: 'Kampala', toCountry: 'UG', rail: 'MTN_MOMO', weight: 5 },
  { from: 'Amsterdam', fromCountry: 'NL', to: 'Lagos', toCountry: 'NG', rail: 'BANK_TRANSFER', weight: 5 },
  { from: 'Johannesburg', fromCountry: 'ZA', to: 'Nairobi', toCountry: 'KE', rail: 'PESA_LINK', weight: 4 },
  { from: 'Doha', fromCountry: 'QA', to: 'Dar es Salaam', toCountry: 'TZ', rail: 'AIRTEL_MONEY', weight: 4 },
  { from: 'Singapore', fromCountry: 'SG', to: 'Accra', toCountry: 'GH', rail: 'BANK_TRANSFER', weight: 3 },
  { from: 'Paris', fromCountry: 'FR', to: 'Kigali', toCountry: 'RW', rail: 'MPESA', weight: 3 },
  { from: 'Cape Town', fromCountry: 'ZA', to: 'Kampala', toCountry: 'UG', rail: 'AIRTEL_MONEY', weight: 2 },
];

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

/**
 * The landing page visualization must show *something* on first paint, but it
 * must not invent transaction history. So this feed is generated from a fixed
 * seed, is labelled simulated at the type level, is stored in its own table, and
 * is documented on the page as a visual demonstration.
 */
export function demoNetworkFeed(limit = 42): { items: DemoCorridor[]; totals: { perHour: number; usd24h: number; successRatePct: number }; simulated: true; note: string } {
  const db = getDb();
  const stored = db.all<{ kind: string; corridor: string | null; amount_usd: number | null; rail: string | null; asset: string | null; outcome: string; latency_ms: number | null; created_at: string }>(
    `SELECT * FROM sandbox_events WHERE kind = 'network_flow' ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
  let items: DemoCorridor[] = stored.map((row) => {
    const [fromCountry, toCountry] = (row.corridor ?? 'AE:KE').split(':');
    const corridor = CORRIDORS.find((c) => c.fromCountry === fromCountry && c.toCountry === toCountry) ?? CORRIDORS[0]!;
    return {
      id: `${row.created_at}:${row.corridor}`,
      from: corridor.from,
      fromCountry: corridor.fromCountry,
      to: corridor.to,
      toCountry: corridor.toCountry,
      asset: (row.asset ?? 'USDT') as PayableAsset,
      rail: row.rail ?? corridor.rail,
      amountUsd: row.amount_usd ?? 0,
      outcome: (row.outcome as DemoCorridor['outcome']) ?? 'settled',
      latencySeconds: (row.latency_ms ?? 9000) / 1000,
      at: row.created_at,
      simulated: true as const,
    };
  });
  if (items.length < 12) items = generate();
  const settled = items.filter((i) => i.outcome === 'settled').length;
  return {
    items,
    totals: {
      perHour: Math.round(items.length / 2),
      usd24h: Math.round(items.reduce((acc, i) => acc + i.amountUsd, 0) * 24),
      successRatePct: items.length ? Math.round((settled / items.length) * 1000) / 10 : 100,
    },
    simulated: true,
    note: 'Demonstration traffic for the visualisation. These are not real payments, not AuraPay customers, and not a volume claim.',
  };
}

function generate(): DemoCorridor[] {
  const rand = seededRandom(20260101);
  const assets: PayableAsset[] = ['USDT', 'USDT', 'USDT', 'USDC', 'BTC', 'ETH'];
  const totalWeight = CORRIDORS.reduce((acc, c) => acc + c.weight, 0);
  const items: DemoCorridor[] = [];
  for (let i = 0; i < 42; i += 1) {
    let pick = rand() * totalWeight;
    let corridor = CORRIDORS[0]!;
    for (const c of CORRIDORS) {
      pick -= c.weight;
      if (pick <= 0) {
        corridor = c;
        break;
      }
    }
    const roll = rand();
    const outcome: DemoCorridor['outcome'] = roll > 0.94 ? 'failed' : roll > 0.86 ? 'pending' : 'settled';
    const amountUsd = Math.round((60 + rand() * rand() * 2_400) * 100) / 100;
    items.push({
      id: `demo-${i}`,
      from: corridor.from,
      fromCountry: corridor.fromCountry,
      to: corridor.to,
      toCountry: corridor.toCountry,
      asset: assets[Math.floor(rand() * assets.length)] ?? 'USDT',
      rail: corridor.rail,
      amountUsd,
      outcome,
      latencySeconds: Math.round(6 + rand() * 90),
      at: new Date(Date.now() - i * 7 * 60_000).toISOString(),
      simulated: true,
    });
  }
  return items;
}

/** Persist a snapshot of demo flow so the viz is stable across reloads. */
export function storeDemoFeed(): number {
  const db = getDb();
  const count = db.maybeOne<{ c: number }>(`SELECT COUNT(*) AS c FROM sandbox_events WHERE kind = 'network_flow'`)?.c ?? 0;
  if (count > 0) return 0;
  const feed = generate();
  for (const item of feed) {
    insert('sandbox_events', {
      id: undefined,
      kind: 'network_flow',
      corridor: `${item.fromCountry}:${item.toCountry}`,
      amount_usd: item.amountUsd,
      rail: item.rail,
      asset: item.asset,
      outcome: item.outcome,
      latency_ms: Math.round(item.latencySeconds * 1000),
      created_at: item.at,
    });
  }
  return feed.length;
}

export function supportedAssets() {
  return Object.values(ASSETS).map((asset) => ({
    code: asset.code,
    name: asset.name,
    kind: asset.kind,
    decimals: asset.displayDecimals,
    networks: asset.networks,
    defaultNetwork: asset.defaultNetwork,
    sandboxPayable: asset.sandboxPayable && config.isSandbox,
    productionEnabled: asset.productionEnabled,
  }));
}

export function supportedNetworks() {
  const db = getDb();
  const rows = db.all<{ code: string; status: string; confirmations_required: number }>('SELECT code, status, confirmations_required FROM networks');
  const byCode = new Map(rows.map((r) => [r.code, r]));
  return Object.values(NETWORKS).map((network) => ({
    code: network.code,
    name: network.name,
    confirmationsRequired: byCode.get(network.code)?.confirmations_required ?? network.confirmationsRequired,
    blockTimeSeconds: network.blockTimeSeconds,
    status: byCode.get(network.code)?.status ?? 'OPERATIONAL',
    adapter: network.code,
    simulated: config.isSandbox,
  }));
}

export function formatLocalKes(minor: string | bigint): string {
  return formatKes(typeof minor === 'string' ? BigInt(minor) : minor);
}
