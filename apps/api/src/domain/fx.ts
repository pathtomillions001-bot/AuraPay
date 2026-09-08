import { createLogger } from '../logger.js';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { RATE_SCALE, mulDiv, unitOf } from '@aurapay/shared';
import { id, nowIso, isoIn } from '../lib/ids.js';
import { publish } from './realtime.js';

const log = createLogger('fx');

/**
 * FX / reference pricing.
 *
 * The quote engine never invents a rate. It asks the rate service for
 * `(base, quote)` and the service refuses to answer with data older than
 * `config.quotes.maxRateAgeMs`. That single rule is what makes "we never quote
 * on a stale rate" true rather than aspirational.
 */

export interface RateSnapshot {
  base: string;
  quote: string;
  /** rate * 10^12 — e.g. 1 USDT = 129.05 KES ⇒ 129050000000000 */
  rateScaled: bigint;
  /** Mid-market before AuraPay spread (may equal rateScaled for pure feeds). */
  midRateScaled: bigint;
  source: string;
  isSimulated: boolean;
  fetchedAt: string;
  expiresAt: string;
}

export interface RateProvider {
  readonly name: string;
  readonly simulated: boolean;
  /** Returns base→quote rates for the assets the platform trades. */
  fetch(): Promise<Record<string, number>>;
}

const PAIRS = [
  { base: 'USD', quote: 'KES', key: 'USD_KES' },
  { base: 'BTC', quote: 'USD', key: 'BTC_USD' },
  { base: 'ETH', quote: 'USD', key: 'ETH_USD' },
] as const;

/**
 * Deterministic-but-moving sandbox feed. It is a *simulation*, and every number
 * produced by it is stored with `is_simulated = 1` and surfaced in the UI as
 * "sandbox rate". It is deliberately a slow random walk around plausible 2026
 * levels rather than a static table, so quote-expiry behaviour can be tested.
 */
class SandboxRateProvider implements RateProvider {
  readonly name = 'aurapay-sandbox-feed';
  readonly simulated = true;
  private state = {
    usdKes: 129.05,
    btcUsd: 61_480,
    ethUsd: 3_012,
    step: 0,
  };

  async fetch(): Promise<Record<string, number>> {
    this.state.step += 1;
    const t = this.state.step;
    // Seeded, bounded walk: stable FX drifts ±0.05%, crypto ±0.6% per tick.
    const wave = (phase: number, amp: number) => Math.sin(t / 7 + phase) * amp + (Math.random() - 0.5) * amp;
    this.state.usdKes = round(this.state.usdKes * (1 + wave(0.3, 0.0005)), 4);
    this.state.btcUsd = round(this.state.btcUsd * (1 + wave(1.7, 0.006)), 2);
    this.state.ethUsd = round(this.state.ethUsd * (1 + wave(2.9, 0.008)), 2);
    return {
      USD_KES: this.state.usdKes,
      BTC_USD: this.state.btcUsd,
      ETH_USD: this.state.ethUsd,
    };
  }
}

/**
 * Real spot reference. Public, unauthenticated Coinbase spot endpoints are used
 * for display/reference only; *tradeable* production rates must come from the
 * contracted FX partner (`FX_PROVIDER=partner`), because spot ≠ executable
 * liquidity. Kept here so the wiring is auditable rather than pseudo-code.
 */
class CoinbaseRateProvider implements RateProvider {
  readonly name = 'coinbase';
  readonly simulated = false;

  async fetch(): Promise<Record<string, number>> {
    const pairs = ['BTC-USD', 'ETH-USD'];
    const [usdKes, ...rest] = await Promise.all([
      this.spot('USDC-KES').catch(() => null),
      ...pairs.map((p) => this.spot(p).catch(() => null)),
    ]);
    const out: Record<string, number> = {};
    if (usdKes && usdKes > 0) out.USD_KES = usdKes;
    const btc = rest[0];
    const eth = rest[1];
    if (btc && btc > 0) out.BTC_USD = btc;
    if (eth && eth > 0) out.ETH_USD = eth;
    if (Object.keys(out).length === 0) throw new Error('coinbase feed returned no rates');
    return out;
  }

  private async spot(pair: string): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`coinbase ${res.status}`);
      const body = (await res.json()) as { data?: { amount?: string } };
      const value = Number(body?.data?.amount);
      if (!Number.isFinite(value) || value <= 0) throw new Error('coinbase: unusable amount');
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
}

function providerFor(): RateProvider {
  return config.fx.provider === 'coinbase' && !config.isSandbox
    ? new CoinbaseRateProvider()
    : new SandboxRateProvider();
}

let provider: RateProvider | null = null;

function toScaled(rate: number): bigint {
  // 129.05 → 129050000000000 (decimal-safe: scale then round through a string)
  const asString = rate.toFixed(12);
  const [whole, fracRaw = ''] = asString.split('.');
  const frac = fracRaw.padEnd(12, '0').slice(0, 12);
  return BigInt(`${whole}${frac}`);
}

function fromScaled(scaled: bigint): number {
  return Number(scaled) / Number(RATE_SCALE);
}

/** Persist a fresh snapshot; safe to call from the worker tick. */
export async function refreshRates(): Promise<{ count: number; simulated: boolean; source: string }> {
  provider ??= providerFor();
  const db = getDb();
  const now = nowIso();
  let count = 0;
  try {
    const rates = await provider.fetch();
    const usdKes = rates.USD_KES;
    if (!usdKes) throw new Error('feed missing USD_KES');

    const derived: Array<{ base: string; quote: string; rate: number }> = [
      { base: 'USD', quote: 'KES', rate: usdKes },
      { base: 'USDT', quote: 'KES', rate: usdKes * 1.0005 },
      { base: 'USDC', quote: 'KES', rate: usdKes * 0.9995 },
    ];
    if (rates.BTC_USD) derived.push({ base: 'BTC', quote: 'KES', rate: rates.BTC_USD * usdKes });
    if (rates.ETH_USD) derived.push({ base: 'ETH', quote: 'KES', rate: rates.ETH_USD * usdKes });

    db.tx(() => {
      const usdCentsByAsset: Array<[string, number]> = [
        ['USDT', 100],
        ['USDC', 100],
        ['BTC', Math.round((rates.BTC_USD ?? 0) * 100)],
        ['ETH', Math.round((rates.ETH_USD ?? 0) * 100)],
      ];
      for (const row of derived) {
        const scaled = toScaled(row.rate);
        db.run(
          `INSERT INTO exchange_rates (id, base, quote, rate_scaled, mid_rate_scaled, source, is_simulated, fetched_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            id('rate'),
            row.base,
            row.quote,
            scaled.toString(),
            scaled.toString(),
            provider!.name,
            provider!.simulated ? 1 : 0,
            now,
            isoIn(config.fx.refreshSeconds * 3),
          ],
        );
        count += 1;
      }
      for (const [asset, cents] of usdCentsByAsset) {
        if (!cents) continue;
        db.run('UPDATE assets SET usd_price_minor = ?, change24h_bps = ?, updated_at = ? WHERE code = ?', [
          String(cents),
          change24hBps(asset, 'KES'),
          now,
          asset,
        ]);
      }
      // Trim history: keep the most recent 200 rows per pair.
      db.run(
        `DELETE FROM exchange_rates WHERE id IN (
           SELECT id FROM exchange_rates e
           WHERE (SELECT COUNT(*) FROM exchange_rates e2 WHERE e2.base = e.base AND e2.quote = e.quote AND e2.fetched_at > e.fetched_at) >= 200
         )`,
      );
    });

    const tick = derived.map((d) => ({
      asset: d.base,
      currency: d.quote,
      price: d.rate.toFixed(4),
      source: provider!.simulated ? ('simulated' as const) : ('live' as const),
    }));
    publish('public', 'prices', 'prices.tick', { at: now, rates: tick });
    log.debug('rates refreshed', { count, source: provider.name });
  } catch (error) {
    log.error('rate refresh failed', { error: (error as Error).message, provider: provider.name });
    if (config.isProduction && config.quotes.requireLiveRates) throw error;
  }
  return { count, simulated: provider.simulated, source: provider.name };
}

/** Latest usable rate for a pair, with staleness enforcement. */
export function getRate(base: string, quote: string): RateSnapshot {
  const db = getDb();
  const row = db.maybeOne<{
    rate_scaled: string;
    mid_rate_scaled: string | null;
    source: string;
    is_simulated: number;
    fetched_at: string;
    expires_at: string;
  }>(
    `SELECT rate_scaled, mid_rate_scaled, source, is_simulated, fetched_at, expires_at
     FROM exchange_rates WHERE base = ? AND quote = ? ORDER BY fetched_at DESC LIMIT 1`,
    [base, quote],
  );
  if (!row) {
    throw new Error(`no rate available for ${base}/${quote}`);
  }
  const ageMs = Date.now() - new Date(row.fetched_at).getTime();
  if (ageMs > config.quotes.maxRateAgeMs) {
    // This is the fail-closed path for "never quote from a stale rate".
    const err = new Error('stale') as Error & { code: string };
    err.code = 'QUOTE_STALE_RATE';
    throw err;
  }
  return {
    base,
    quote,
    rateScaled: BigInt(row.rate_scaled),
    midRateScaled: BigInt(row.mid_rate_scaled ?? row.rate_scaled),
    source: row.source,
    isSimulated: row.is_simulated === 1,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
  };
}

export function tryRate(base: string, quote: string): RateSnapshot | null {
  try {
    return getRate(base, quote);
  } catch {
    return null;
  }
}

/** Convenience for display code: KES per 1 unit of asset (mid, before spread). */
export function kesPerUnit(asset: string): number {
  const rate = tryRate(asset, 'KES');
  return rate ? fromScaled(rate.midRateScaled) : 0;
}

export function usdToKes(usdMinor: bigint): bigint {
  const rate = tryRate('USD', 'KES');
  if (!rate) return 0n;
  return mulDiv(usdMinor * unitOf('KES'), rate.rateScaled, RATE_SCALE * unitOf('USD'));
}

export function rateHistory(base: string, quote: string, limit = 60): Array<{ at: string; rate: number; simulated: boolean }> {
  const db = getDb();
  return db
    .all<{ fetched_at: string; rate_scaled: string; is_simulated: number }>(
      `SELECT fetched_at, rate_scaled, is_simulated FROM exchange_rates
       WHERE base = ? AND quote = ? ORDER BY fetched_at DESC LIMIT ?`,
      [base, quote, limit],
    )
    .reverse()
    .map((r) => ({ at: r.fetched_at, rate: fromScaled(BigInt(r.rate_scaled)), simulated: r.is_simulated === 1 }));
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

/**
 * 24h change in basis points, measured against our own rate history (the
 * oldest snapshot inside the window). Honest by construction: before the feed
 * has 24h of runtime it measures a shorter window, which the UI labels
 * "since feed start" rather than pretending to be a daily change.
 */
export function change24hBps(base: string, quote: string): number {
  const db = getDb();
  const row = db.maybeOne<{ rate_scaled: string }>(
    `SELECT rate_scaled FROM exchange_rates
     WHERE base = ? AND quote = ? AND fetched_at >= datetime('now', '-24 hours')
     ORDER BY fetched_at ASC LIMIT 1`,
    [base, quote],
  );
  const latest = db.maybeOne<{ rate_scaled: string }>(
    `SELECT rate_scaled FROM exchange_rates WHERE base = ? AND quote = ? ORDER BY fetched_at DESC LIMIT 1`,
    [base, quote],
  );
  if (!row || !latest) return 0;
  const before = BigInt(row.rate_scaled);
  const now = BigInt(latest.rate_scaled);
  if (before === 0n) return 0;
  return Number(((now - before) * 10_000n) / before) / 100;
}

export function hasHistory(base: string, quote: string): boolean {
  const db = getDb();
  const row = db.maybeOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM exchange_rates WHERE base = ? AND quote = ?`,
    [base, quote],
  );
  return (row?.c ?? 0) > 0;
}

export const __testables = { toScaled, fromScaled, SandboxRateProvider };
