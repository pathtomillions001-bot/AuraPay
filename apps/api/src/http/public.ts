import type { FastifyInstance } from 'fastify';
import { ASSETS, PAYABLE_ASSETS, NETWORKS, RAILS, type PayableAsset, type NetworkCode, type RailCode } from '@aurapay/shared';
import { config, LEGAL_DISCLAIMER } from '../config.js';
import * as fx from '../domain/fx.js';
import * as quotes from '../domain/quotes.js';
import * as sandbox from '../domain/sandbox.js';
import * as routing from '../domain/routing.js';
import { PROVIDERS } from '../domain/providers.js';
import * as feesDomain from '../domain/fees.js';
import { getDb } from '../db/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('public');

/** Minor-unit scaled rate → human text, without importing a float path. */
function formatRateText(rateScaled: bigint): string {
  const whole = rateScaled / 1_000_000_000_000n;
  const frac = (rateScaled % 1_000_000_000_000n) / 1_000_000_000n;
  return `${whole.toString()}.${frac.toString().padStart(3, '0')}`;
}

/**
 * Unauthenticated surface. Nothing here can move money, reveal a balance or
 * name a customer: it is pricing, network health and the sandbox label.
 */
export function registerPublicRoutes(app: FastifyInstance): void {
  app.get('/v1/health', async () => {
    const db = getDb();
    const jobStats = db.maybeOne<{ ready: number; dead: number }>(
      `SELECT SUM(CASE WHEN status = 'READY' THEN 1 ELSE 0 END) AS ready,
              SUM(CASE WHEN status = 'DEAD' THEN 1 ELSE 0 END) AS dead
       FROM job_queue`,
    );
    return {
      ok: true,
      mode: config.mode,
      version: '0.1.0',
      // Deliberately not a bare "up": a service that is up but cannot settle is
      // exactly the failure a customer notices first.
      settlement: {
        quotesActive: db.maybeOne<{ c: number }>(`SELECT COUNT(*) AS c FROM quotes WHERE status = 'ACTIVE'`)?.c ?? 0,
        paymentsInFlight:
          db.maybeOne<{ c: number }>(
            `SELECT COUNT(*) AS c FROM payment_intents WHERE status NOT IN ('COMPLETED','FAILED','REFUNDED','CANCELLED')`,
          )?.c ?? 0,
        jobsReady: jobStats?.ready ?? 0,
        jobsDead: jobStats?.dead ?? 0,
      },
      simulated: config.isSandbox,
      legalNote: LEGAL_DISCLAIMER,
    };
  });

  app.get('/v1/network-status', async () => {
    const db = getDb();
    const chains = db.all<{ code: string; status: string; block_height: string | null; fee_estimate_usd_cents: number | null; updated_at: string }>(
      'SELECT code, status, block_height, fee_estimate_usd_cents, updated_at FROM networks ORDER BY code',
    );
    return {
      networks: chains.map((n) => ({
        code: n.code,
        name: NETWORKS[n.code as NetworkCode]?.name ?? n.code,
        status: n.status,
        confirmationsRequired: NETWORKS[n.code as NetworkCode]?.confirmationsRequired ?? 1,
        // Reported as recorded, never inferred: a stale height is labelled stale.
        blockHeight: n.block_height,
        feeEstimateUsdCents: n.fee_estimate_usd_cents ?? null,
        observedAt: n.updated_at,
        simulated: config.isSandbox,
      })),
      rails: Object.values(RAILS).map((r) => ({
        code: r.code,
        name: r.name,
        recipientFacing: r.recipientFacing,
        kind: r.kind,
        instant: r.instant,
        refundable: r.refundable,
        minAmountLocal: r.minAmountLocal,
        maxAmountLocal: r.maxAmountLocal,
      })),
      providers: PROVIDERS.map((p) => {
        const health = routing.readProviderHealth(p.code);
        return {
          code: p.code,
          name: p.displayName,
          kind: p.kind,
          rails: p.rails,
          countries: p.countries,
          simulated: p.sandboxOnly,
          enabled: p.configured(),
          operational: health.operational,
          successRatePct: health.successRatePct,
          latencyP50Ms: health.latencyP50Ms,
          errorRatePct: health.errorRatePct,
        };
      }),
      updatedAt: new Date().toISOString(),
      note: config.isSandbox
        ? 'Sandbox status feed. Network and provider figures here are simulated by AuraPay and are not a claim about any live chain or partner.'
        : 'Status is derived from provider responses recorded by this deployment.',
    };
  });

  app.get('/v1/rates', async (request) => {
    const { history } = request.query as { history?: string };
    const assets = Object.values(ASSETS)
      .filter((a) => a.quoteViaUsd || a.code === 'USD')
      .map((a) => {
        const rate = fx.tryRate(a.code as PayableAsset, 'KES');
        return {
          asset: a.code,
          kesPerUnit: rate ? rate.midRateScaled.toString() : null,
          midRateScaled: rate?.midRateScaled.toString() ?? null,
          rateScaled: rate?.rateScaled.toString() ?? null,
          change24hPct: fx.change24hBps(a.code as PayableAsset, 'KES') / 100,
          source: rate?.source ?? 'none',
          observedAt: rate?.fetchedAt ?? null,
          // A rate past its expiry is not a price. The UI shows it greyed out and
          // refuses to quote from it, rather than quietly using it.
          expiresAt: rate?.expiresAt ?? null,
          stale: !rate || new Date(rate.expiresAt).getTime() < Date.now(),
          simulated: rate?.isSimulated ?? true,
        };
      });
    const historyRows = history === '1' ? fx.rateHistory('USDT', 'KES', 60) : [];
    return {
      assets: assets.map((a) => ({ ...a, midRateFormatted: a.midRateScaled ? formatRateText(BigInt(a.midRateScaled)) : null })),
      usdToKes: fx.usdToKes(100n).toString(),
      history: historyRows,
      updatedAt: new Date().toISOString(),
      note: config.isSandbox
        ? 'Sandbox price feed: simulated mid rates from a local generator. Do not treat as market data.'
        : undefined,
    };
  });

  /**
   * Pricing preview for the landing page and the checkout "see your rate" panel.
   * It is a *display* quote, not a reservable one: no id is issued, nothing is
   * consumed, and the numbers carry the same disclosed spread as a real quote.
   */
  app.post(
    '/v1/quote-preview',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const body = (request.body ?? {}) as { asset?: PayableAsset; amountKesMajor?: number; kind?: 'PHONE' | 'TILL' | 'PAYBILL' | 'BANK' };
      const asset = (body.asset && (PAYABLE_ASSETS as readonly string[]).includes(body.asset) ? body.asset : 'USDT') as PayableAsset;
      const amountKesMajor = Math.max(1, Math.min(1_000_000, Number(body.amountKesMajor ?? 1000)));
      const quote = quotes.create({
        // A preview belongs to nobody, so it is booked against the platform's own
        // fee account holder and never consumable by a customer.
        userId: 'preview',
        asset,
        network: ASSETS[asset].defaultNetwork as NetworkCode,
        kind: body.kind ?? 'PHONE',
        recipientAmountKesMajor: amountKesMajor,
        verifiedRecipient: true,
      });
      log.debug('quote preview created', { asset, amountKesMajor });
      return {
        ...quote,
        quoteId: undefined,
        previewOnly: true,
        note: 'Indicative only. Prices move with the market: start a payment to lock a rate for a fixed window.',
      };
    },
  );

  app.get('/v1/fees', async (request) => {
    const query = request.query as { asset?: string; rail?: string };
    const asset = (query.asset ?? 'USDT') as PayableAsset;
    const rail = (query.rail ?? 'MPESA') as RailCode;
    return { asset, rail, schedule: feesDomain.effective(asset, rail), quoteTtlSeconds: config.quotes.ttlSeconds };
  });

  /** The landing page's "global flows" visual, from clearly synthetic data. */
  app.get('/v1/demo/network-feed', async () => {
    if (!config.demo.demoNetworkEnabled) return { enabled: false, points: [] };
    const feed = sandbox.demoNetworkFeed();
    return {
      enabled: true,
      disclaimer:
        'Demonstration traffic generated by this sandbox so the visualisation has something to show. It is not AuraPay volume, and it is not a claim about real networks.',
      ...feed,
    };
  });

  app.get('/v1/sandbox', async () => ({ ...sandbox.status(), mode: config.mode }));
}
