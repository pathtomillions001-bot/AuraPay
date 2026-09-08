import { ASSET_SCALES, DomainError, NETWORKS, formatCrypto, formatKes, type NetworkCode, type PayableAsset } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, nowIso } from '../lib/ids.js';
import * as ledger from './ledger.js';
import * as liquidity from './liquidity.js';
import { blockchain } from './blockchain.js';
import { readProviderHealth } from './routing.js';
import { PROVIDERS } from './providers.js';
import { change24hBps, rateHistory, tryRate } from './fx.js';
import { publish } from './realtime.js';
import { createLogger } from '../logger.js';

const log = createLogger('treasury');
import { insert } from '../db/rows.js';
import { stringify } from '../lib/json.js';


/**
 * Treasury: what the platform actually holds, where it is, and whether that is
 * enough to keep paying recipients.
 *
 * Every number here is derived from the ledger or from a partner-confirmed
 * state — nothing is estimated, and in sandbox the whole view is labelled
 * simulated. Alerts are the operations surface: LOW LIQUIDITY, PROVIDER
 * FAILURE, UNUSUAL VOLUME, CONGESTION, FX VOLATILITY.
 */

export function overview() {
  const db = getDb();
  const floatAccounts = liquidity.listAccounts();
  const custody = ledger.balancesByPattern('TREASURY:CRYPTO:%');
  const customerLiabilities = ledger.balancesByPattern('USER:%');
  const inFlight = ledger.sumSigned(ledger.accounts.payoutInFlight(), 'KES');
  const payoutLiability = ledger.sumSigned(ledger.accounts.payoutLiability(), 'KES');
  const providerPayable = ledger.sumSigned(ledger.accounts.providerFees(), 'KES');
  const gasHeld: Record<string, bigint> = {};
  for (const asset of Object.keys(ASSET_SCALES)) {
    if (asset === 'KES') continue;
    gasHeld[asset] = ledger.sumSigned(ledger.accounts.gasClearing(asset), asset as never);
  }
  const revenue = ledger.incomeStatement(dayStart(), dayEnd());
  const totalCustomerKes = customerLiabilities.reduce((acc, row) => {
    if (row.asset === 'KES') return acc + row.balanceMinor;
    const rate = tryRate(row.asset as PayableAsset, 'KES');
    if (!rate) return acc;
    const units = Number(row.balanceMinor) / 10 ** ASSET_SCALES[row.asset as keyof typeof ASSET_SCALES];
    return acc + BigInt(Math.round(units * Number(rate.rateScaled) / 1e12 * 100));
  }, 0n);
  const floatTotal = floatAccounts.reduce((acc, a) => acc + a.availableMinor, 0n);
  return {
    float: floatAccounts.map((a) => ({
      accountId: a.accountId,
      rail: a.rail,
      currency: a.currency,
      provider: a.provider,
      availableMinor: a.availableMinor.toString(),
      availableFormatted: formatKes(a.availableMinor),
      reservedMinor: a.reservedMinor.toString(),
      pendingPayoutMinor: a.pendingPayoutMinor.toString(),
      floatTargetMinor: a.floatTargetMinor.toString(),
      utilisationPct: a.utilisationPct,
      health: a.health,
      dataOrigin: a.dataOrigin,
    })),
    custody: custody.map((row) => ({
      account: row.code,
      asset: row.asset,
      balanceMinor: row.balanceMinor.toString(),
      balanceFormatted: formatCrypto(row.balanceMinor, row.asset as never),
      role: row.code.split(':').at(-1),
    })),
    onChainBalances: db
      .all<{ network: string; address: string }>(`SELECT DISTINCT network, address FROM wallets WHERE kind = 'TREASURY'`)
      .map((row) => ({ network: row.network, address: row.address, queried: false })),
    obligations: {
      customerLiabilityKesMinor: totalCustomerKes.toString(),
      customerLiabilityKesFormatted: formatKes(totalCustomerKes),
      payoutLiabilityKesMinor: payoutLiability.toString(),
      payoutsInFlightKesMinor: inFlight.toString(),
      providerFeesAccruedKesMinor: providerPayable.toString(),
      networkFeesHeldMinor: Object.fromEntries(Object.entries(gasHeld).map(([k, v]) => [k, v.toString()])),
      coverageRatio: floatTotal > 0n ? Math.round((Number(totalCustomerKes) / Number(floatTotal)) * 100) / 100 : null,
    },
    revenueToday: revenue.map((row) => ({
      account: row.account,
      asset: row.asset,
      amountMinor: row.amountMinor.toString(),
      formatted: row.asset === 'KES' ? formatKes(row.amountMinor) : formatCrypto(row.amountMinor, row.asset as never),
    })),
    integrity: ledger.verify(),
    simulated: config.isSandbox,
    note: config.isSandbox
      ? 'Sandbox treasury: balances, float and partner states are simulated fixtures. No custody positions here are real.'
      : 'Figures are taken from the double-entry ledger; the wallet cache is reconciled against it continuously.',
  };
}

function dayStart(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}
function dayEnd(): string {
  return `${new Date().toISOString().slice(0, 10)}T23:59:59.999Z`;
}

/** The operational alert families the product names, computed from real state. */
export interface TreasuryAlert {
  code: 'LOW_LIQUIDITY' | 'PROVIDER_FAILURE' | 'UNUSUAL_VOLUME' | 'CONGESTION' | 'FX_VOLATILITY' | 'LEDGER_INTEGRITY';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  rail?: string;
  value?: string;
  recommendedAction: string;
  at: string;
}

export function alerts(): TreasuryAlert[] {
  const db = getDb();
  const now = nowIso();
  const out: TreasuryAlert[] = [];

  for (const alert of liquidity.alerts()) {
    out.push({
      code: alert.kind === 'BLOCKCHAIN_CONGESTION' ? 'CONGESTION' : (alert.kind as TreasuryAlert['code']),
      severity: alert.severity,
      title: ALERT_TITLES[alert.kind] ?? 'Treasury alert',
      detail: alert.message,
      recommendedAction: ALERT_ACTIONS[alert.kind] ?? 'Review with the on-call operator.',
      at: alert.at,
    });
  }

  for (const provider of PROVIDERS.filter((p) => p.kind === 'MOBILE_MONEY' || p.kind === 'BANK')) {
    const health = readProviderHealth(provider.code);
    if (!health.operational || health.successRatePct < 90) {
      out.push({
        code: 'PROVIDER_FAILURE',
        severity: health.operational ? 'warning' : 'critical',
        title: `${provider.displayName} is ${health.operational ? 'degraded' : 'not operational'}`,
        detail: `Success rate ${health.successRatePct}%, ${health.errorRatePct.toFixed(1)}% errors, p50 ${health.latencyP50Ms}ms. The routing engine already prefers healthier providers.`,
        rail: provider.rails[0],
        value: `${health.successRatePct}%`,
        recommendedAction: health.operational
          ? 'Monitor. Payments continue through fallbacks while this clears.'
          : 'Confirm with the partner. Queued payouts are re-driven automatically once it reports healthy.',
        at: now,
      });
    }
  }

  const hour = db.maybeOne<{ c: number }>(`SELECT COUNT(*) AS c FROM payment_intents WHERE created_at >= datetime('now','-1 hour')`)?.c ?? 0;
  const dayWindow =
    db.maybeOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM payment_intents WHERE created_at < datetime('now','-1 hour') AND created_at >= datetime('now','-25 hours')`,
    )?.c ?? 0;
  const baseline = dayWindow / 24;
  if (baseline > 2 && hour > baseline * 5) {
    out.push({
      code: 'UNUSUAL_VOLUME',
      severity: 'warning',
      title: 'Unusual payment volume',
      detail: `${hour} payments in the last hour against a baseline of ${baseline.toFixed(1)} per hour. A monitoring signal, not an accusation — it can be abuse, a merchant campaign, or a stuck queue draining.`,
      value: `${hour}`,
      recommendedAction: 'Review the largest payments in the hour and any single merchant driving the spike.',
      at: now,
    });
  }

  for (const provider of blockchain.list()) {
    if (!provider.enabled) continue;
    const required = NETWORKS[provider.network]?.confirmationsRequired ?? 1;
    const stuck =
      db.maybeOne<{ c: number }>(
        `SELECT COUNT(*) AS c FROM payments WHERE network = ? AND status = 'CONFIRMING' AND updated_at < datetime('now','-10 minutes')`,
        [provider.network],
      )?.c ?? 0;
    if (stuck > 3) {
      out.push({
        code: 'CONGESTION',
        severity: stuck > 12 ? 'critical' : 'warning',
        title: `${NETWORKS[provider.network]?.name ?? provider.network} confirmations are slow`,
        detail: `${stuck} deposits are still below ${required} confirmations after 10 minutes. They stay in "confirming" until the chain catches up — AuraPay never marks them early.`,
        value: `${stuck}`,
        rail: provider.network,
        recommendedAction: 'Check the chain explorer; consider pausing that network for large payments.',
        at: now,
      });
    }
  }

  for (const asset of ['USDT', 'USDC', 'BTC', 'ETH'] as PayableAsset[]) {
    const bps = change24hBps(asset, 'KES');
    if (Math.abs(bps) >= 250) {
      out.push({
        code: 'FX_VOLATILITY',
        severity: Math.abs(bps) >= 600 ? 'critical' : 'warning',
        title: `${asset}/KES moved ${(bps / 100).toFixed(2)}% in 24h`,
        detail: 'Quote TTLs shorten automatically in volatile markets: fewer stale rates, more expired quotes. A quote that expires is a feature, not a failure.',
        rail: 'FX',
        value: `${(bps / 100).toFixed(2)}%`,
        recommendedAction: Math.abs(bps) >= 600 ? 'Consider widening the spread or pausing the asset for payouts.' : 'No action; monitor feed freshness.',
        at: now,
      });
    }
  }

  const integrity = ledger.verify();
  if (integrity.length) {
    out.push({
      code: 'LEDGER_INTEGRITY',
      severity: 'critical',
      title: 'Ledger integrity check failed',
      detail: `${integrity.length} journal(s) failed the balance check: ${integrity
        .slice(0, 3)
        .map((p) => `${p.kind} (${p.ref})`)
        .join(', ')}.`,
      recommendedAction: 'Stop payouts on the affected rail and reconcile with compensating entries only.',
      at: now,
    });
  }
  return out;
}

const ALERT_TITLES: Record<string, string> = {
  LOW_LIQUIDITY: 'Settlement float is running low',
  PROVIDER_FAILURE: 'A payout partner is failing',
  UNUSUAL_VOLUME: 'Unusual payment volume',
  BLOCKCHAIN_CONGESTION: 'A blockchain network is congested',
  FX_VOLATILITY: 'FX moved sharply inside the feed window',
};

const ALERT_ACTIONS: Record<string, string> = {
  LOW_LIQUIDITY: 'Top up the float from the treasury account; payments queue with an explicit pending state meanwhile.',
  PROVIDER_FAILURE: 'Open the partner incident channel and check the payout queue depth.',
  UNUSUAL_VOLUME: 'Look for a single driving merchant or repeated failures being retried.',
  BLOCKCHAIN_CONGESTION: 'Consider disabling the network for new quotes until it recovers.',
  FX_VOLATILITY: 'Review the spread and quote TTL; never quote from a stale rate.',
};

/**
 * Manual float movement by an operator. Booked as a *journal* — never by
 * editing a balance — so the audit trail explains the change.
 */
export function adjustFloat(input: {
  rail: string;
  currency: string;
  amountMinor: bigint;
  direction: 'IN' | 'OUT';
  reason: string;
  actor: string;
}): void {
  if (!input.reason.trim()) throw new DomainError('VALIDATION_FAILED', 'A treasury movement needs a written reason.');
  if (input.amountMinor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Amount must be greater than zero.');
  const db = getDb();
  const account = liquidity.findAccount(input.rail as never, input.currency);
  if (!account) throw new DomainError('NOT_FOUND', `No ${input.currency} float configured for ${input.rail}.`);
  const code = ledger.accounts.liquidity(input.rail, input.currency);
  db.tx(() => {
    ledger.postJournal({
      group: `treasury:float:${input.rail}:${Date.now()}`,
      asset: input.currency as never,
      memo: `${input.direction} float ${input.rail}: ${input.reason}`,
      isAdjustment: true,
      entries:
        input.direction === 'IN'
          ? [
              { accountCode: ledger.accounts.adjustment(`float_${input.rail}`), direction: 'CREDIT', asset: input.currency as never, amountMinor: input.amountMinor, code: 'ADJUSTMENT_CREDIT', memo: input.reason },
              { accountCode: code, direction: 'DEBIT', asset: input.currency as never, amountMinor: input.amountMinor, code: 'LIQUIDITY_DEBIT', memo: 'operator funding' },
            ]
          : [
              { accountCode: code, direction: 'CREDIT', asset: input.currency as never, amountMinor: input.amountMinor, code: 'LIQUIDITY_CREDIT', memo: 'operator withdrawal' },
              { accountCode: ledger.accounts.adjustment(`float_${input.rail}`), direction: 'DEBIT', asset: input.currency as never, amountMinor: input.amountMinor, code: 'ADJUSTMENT_DEBIT', memo: input.reason },
            ],
    });
    if (input.direction === 'IN') liquidity.credit(account.id, input.amountMinor, input.reason);
    else liquidity.debitFloat(account.id, input.amountMinor, input.reason);
    insert('audit_logs', {
      id: id('aud'),
      actor_user_id: null,
      actor_type: 'ADMIN',
      action: `treasury.float_${input.direction.toLowerCase()}`,
      target_type: 'liquidity_account',
      target_id: account.id,
      metadata: stringify({ amountMinor: input.amountMinor.toString(), reason: input.reason, actor: input.actor }),
      created_at: nowIso(),
    });
  });
  publish('admin', 'network', 'treasury.float_changed', { rail: input.rail, direction: input.direction, amountMinor: input.amountMinor.toString() });
  log.info('float adjusted', { rail: input.rail, direction: input.direction, amount: input.amountMinor.toString(), actor: input.actor });
}

/** Custody exposure per network, from the ledger (not from a chain query). */
export function custodyReport() {
  const rows = ledger.balancesByPattern('TREASURY:CRYPTO:%');
  const grouped = new Map<string, { role: string; balances: Record<string, bigint> }>();
  for (const row of rows) {
    const parts = row.code.split(':');
    const asset = parts[2] ?? '';
    const network = parts[3] ?? '';
    const role = parts[4] ?? 'CUSTODY';
    const key = `${network}:${role}`;
    const bucket = grouped.get(key) ?? { role, balances: {} };
    bucket.balances[asset] = (bucket.balances[asset] ?? 0n) + row.balanceMinor;
    grouped.set(key, bucket);
  }
  return [...grouped.entries()].map(([key, bucket]) => ({
    network: key.split(':')[0],
    role: bucket.role,
    balances: Object.fromEntries(Object.entries(bucket.balances).map(([asset, minor]) => [asset, { minor: minor.toString(), formatted: formatCrypto(minor, asset as never) }])),
  }));
}

export function fxBoard() {
  const rows: Array<{ pair: string; midRateScaled: string | null; appliedRateScaled: string | null; change24hBps: number; source: string; simulated: boolean; history: Array<{ at: string; rate: number }> }> = [];
  for (const asset of ['USDT', 'USDC', 'BTC', 'ETH'] as PayableAsset[]) {
    const rate = tryRate(asset, 'KES');
    rows.push({
      pair: `${asset}/KES`,
      midRateScaled: (rate?.midRateScaled ?? 0n).toString(),
      appliedRateScaled: (rate?.rateScaled ?? 0n).toString(),
      change24hBps: change24hBps(asset, 'KES'),
      source: rate?.source ?? 'none',
      simulated: rate?.isSimulated ?? true,
      history: rateHistory(asset, 'KES', 48).map((point) => ({ at: point.at, rate: point.rate })),
    });
  }
  return rows;
}

/** The sweep queue: what the treasury needs to move on-chain, and why. */
export function sweepQueue() {
  const db = getDb();
  const rows = db.all<{ network: string; asset: string; pending_minor: string; payments: number }>(
    `SELECT p.network, p.asset,
            CAST(SUM(CASE WHEN p.status = 'CONFIRMED' AND i.status NOT IN ('COMPLETED','FAILED','REFUNDED') THEN CAST(p.amount_minor AS INTEGER) ELSE 0 END) AS TEXT) AS pending_minor,
            COUNT(*) AS payments
     FROM payments p JOIN payment_intents i ON i.id = p.payment_intent_id
     GROUP BY p.network, p.asset`,
  );
  return rows.map((row) => ({
    network: row.network,
    asset: row.asset,
    pendingMinor: row.pending_minor,
    payments: row.payments,
    feeEstimateUsdCents: NETWORKS[row.network as NetworkCode]?.sandboxFeeUsdCents ?? 0,
    action: 'custody sweep to the liquidation account',
  }));
}
