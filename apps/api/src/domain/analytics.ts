import { RAILS, formatKes, type AssetCode, type RailCode } from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { nowIso } from '../lib/ids.js';
import * as ledger from './ledger.js';

/**
 * Reporting.
 *
 * Every figure is a query over the payment records and the ledger — there are no
 * pre-baked numbers anywhere in this module. When a chart shows "processing", it
 * is because those intents are genuinely in a processing state. `simulated: true`
 * is returned alongside sandbox data so the UI can badge it.
 */

export interface AnalyticsFilters {
  userId?: string | null;
  businessId?: string | null;
  from?: string | null;
  to?: string | null;
  asset?: AssetCode | null;
  rail?: RailCode | null;
}

interface Clause {
  sql: string;
  params: (string | number)[];
}

function where(filters: AnalyticsFilters): Clause {
  const clauses: string[] = ['1=1'];
  const params: (string | number)[] = [];
  if (filters.userId) {
    clauses.push('user_id = ?');
    params.push(filters.userId);
  }
  if (filters.businessId) {
    clauses.push('business_id = ?');
    params.push(filters.businessId);
  }
  if (filters.from) {
    clauses.push('created_at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push('created_at <= ?');
    params.push(filters.to);
  }
  if (filters.asset) {
    clauses.push('asset = ?');
    params.push(filters.asset);
  }
  if (filters.rail) {
    clauses.push('rail = ?');
    params.push(filters.rail);
  }
  return { sql: clauses.join(' AND '), params };
}

export function summary(filters: AnalyticsFilters) {
  const db = getDb();
  const clause = where(filters);
  const totals = db.maybeOne<{
    count: number;
    volume: number;
    completed: number;
    failed: number;
    refunded: number;
    open: number;
    crypto_debited: number;
    fees: number;
    median_seconds: number | null;
  }>(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN CAST(recipient_amount_minor AS INTEGER) ELSE 0 END), 0) / 100.0 AS volume,
            SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'REFUNDED' THEN 1 ELSE 0 END) AS refunded,
            SUM(CASE WHEN status NOT IN ('COMPLETED','FAILED','REFUNDED') THEN 1 ELSE 0 END) AS open,
            COALESCE(SUM(CAST(total_debit_minor AS INTEGER)), 0) / 1e6 AS crypto_debited,
            COALESCE(SUM(CAST(service_fee_minor AS INTEGER)), 0) / 1e6 AS fees,
            NULL AS median_seconds
     FROM payment_intents WHERE ${clause.sql}`,
    clause.params,
  );
  const settlement = db.maybeOne<{ median_seconds: number | null; p95_seconds: number | null }>(
    `SELECT
       NULLIF(CAST(AVG((julianday(completed_at) - julianday(created_at)) * 86400.0) AS REAL), '') AS median_seconds,
       NULL AS p95_seconds
     FROM payment_intents
     WHERE ${clause.sql} AND status = 'COMPLETED' AND completed_at IS NOT NULL`,
    clause.params,
  );
  const byStatus = db.all<{ status: string; c: number }>(
    `SELECT status, COUNT(*) AS c FROM payment_intents WHERE ${clause.sql} GROUP BY status ORDER BY c DESC`,
    clause.params,
  );
  const byAsset = db.all<{ asset: string; c: number; volume: number }>(
    `SELECT asset, COUNT(*) AS c, COALESCE(SUM(CAST(recipient_amount_minor AS INTEGER)),0) / 100.0 AS volume
     FROM payment_intents WHERE ${clause.sql} GROUP BY asset ORDER BY volume DESC`,
    clause.params,
  );
  const byRail = db.all<{ rail: string; c: number; volume: number; failed: number }>(
    `SELECT rail, COUNT(*) AS c,
            COALESCE(SUM(CAST(recipient_amount_minor AS INTEGER)),0) / 100.0 AS volume,
            SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed
     FROM payment_intents WHERE ${clause.sql} GROUP BY rail ORDER BY c DESC`,
    clause.params,
  );
  const failureCodes = db.all<{ code: string; c: number; sample: string | null }>(
    `SELECT COALESCE(failure_code,'UNKNOWN') AS code, COUNT(*) AS c, MAX(failure_message) AS sample
     FROM payment_intents WHERE ${clause.sql} AND status = 'FAILED' GROUP BY code ORDER BY c DESC LIMIT 12`,
    clause.params,
  );
  const daily = db.all<{ day: string; count: number; volume: number; completed: number; failed: number }>(
    `SELECT substr(created_at,1,10) AS day, COUNT(*) AS count,
            COALESCE(SUM(CAST(recipient_amount_minor AS INTEGER)),0) / 100.0 AS volume,
            SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed
     FROM payment_intents WHERE ${clause.sql} GROUP BY day ORDER BY day DESC LIMIT 60`,
    clause.params,
  );
  const counted = totals?.count ?? 0;
  return {
    generatedAt: nowIso(),
    window: { from: filters.from ?? null, to: filters.to ?? null },
    payments: counted,
    completed: totals?.completed ?? 0,
    failed: totals?.failed ?? 0,
    refunded: totals?.refunded ?? 0,
    open: totals?.open ?? 0,
    successRatePct: counted > 0 ? Math.round(((totals?.completed ?? 0) / counted) * 1000) / 10 : null,
    volumeKes: totals?.volume ?? 0,
    volumeKesFormatted: formatKes(BigInt(Math.round((totals?.volume ?? 0) * 100))),
    averageSettlementSeconds: settlement?.median_seconds !== null && settlement?.median_seconds !== undefined ? Math.round(settlement.median_seconds) : null,
    feesEstimatedUsd: totals?.fees ?? 0,
    byStatus,
    byAsset,
    byRail: byRail.map((row) => ({ ...row, label: RAILS[row.rail as RailCode]?.recipientFacing ?? row.rail })),
    failureCodes,
    daily: daily.reverse(),
    funnel: funnel(clause),
    simulated: config.isSandbox,
    note: config.isSandbox
      ? 'Sandbox analytics: computed from simulated payments created by the seed and demo actions. They are real calculations over demo data, not invented figures.'
      : 'Computed live from payment records; nothing here is estimated.',
  };
}

function funnel(clause: Clause): Array<{ stage: string; count: number; pct: number }> {
  const db = getDb();
  const rows = db.all<{ to_state: string; c: number }>(
    `SELECT e.to_state, COUNT(DISTINCT e.payment_intent_id) AS c
     FROM payment_events e JOIN payment_intents i ON i.id = e.payment_intent_id
     WHERE ${clause.sql.replace(/created_at/g, 'i.created_at').replace(/status =/g, 'i.status =')}
     GROUP BY e.to_state`,
    clause.params,
  );
  const seen = new Map(rows.map((r) => [r.to_state, r.c]));
  const stages = ['CREATED', 'AWAITING_PAYMENT', 'PAYMENT_DETECTED', 'RISK_REVIEW', 'CONVERSION_PENDING', 'LIQUIDITY_RESERVED', 'PAYOUT_SUBMITTED', 'COMPLETED'];
  const top = Math.max(1, ...stages.map((s) => seen.get(s) ?? 0));
  return stages.map((stage) => ({ stage, count: seen.get(stage) ?? 0, pct: Math.round(((seen.get(stage) ?? 0) / top) * 100) }));
}

/** Admin platform view: money in, money out, and whether it is healthy. */
export function platform() {
  const db = getDb();
  const week = db.maybeOne<{
    count: number;
    volume: number;
    completed: number;
    failed: number;
    fees: number;
    users: number;
  }>(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN CAST(recipient_amount_minor AS INTEGER) ELSE 0 END),0) / 100.0 AS volume,
            SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
            COALESCE(SUM(CAST(service_fee_minor AS INTEGER)),0) / 1e6 AS fees,
            COUNT(DISTINCT user_id) AS users
     FROM payment_intents WHERE created_at >= datetime('now','-7 days')`,
  );
  const revenue = ledger.incomeStatement(`${new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`, `${new Date().toISOString().slice(0, 10)}T23:59:59.999Z`);
  const hourly = db.all<{ hour: string; count: number; volume: number }>(
    `SELECT substr(created_at,1,13) AS hour, COUNT(*) AS count,
            COALESCE(SUM(CAST(recipient_amount_minor AS INTEGER)),0) / 100.0 AS volume
     FROM payment_intents WHERE created_at >= datetime('now','-48 hours') GROUP BY hour ORDER BY hour`,
  );
  return {
    last7Days: {
      payments: week?.count ?? 0,
      completed: week?.completed ?? 0,
      failed: week?.failed ?? 0,
      volumeKes: week?.volume ?? 0,
      volumeKesFormatted: formatKes(BigInt(Math.round((week?.volume ?? 0) * 100))),
      activeUsers: week?.users ?? 0,
      platformFeesUsd: week?.fees ?? 0,
      successRatePct: (week?.count ?? 0) > 0 ? Math.round(((week?.completed ?? 0) / (week?.count ?? 1)) * 1000) / 10 : null,
    },
    hourly: hourly.map((row) => ({ ...row, at: `${row.hour}:00:00.000Z` })),
    revenueLedger: revenue.map((row) => ({
      account: row.account,
      asset: row.asset,
      amountMinor: row.amountMinor.toString(),
      formatted: row.asset === 'KES' ? formatKes(row.amountMinor) : `${Number(row.amountMinor) / 1e6} ${row.asset}`,
    })),
    openCases: db.maybeOne<{ c: number }>(`SELECT COUNT(*) AS c FROM compliance_cases WHERE status = 'OPEN'`)?.c ?? 0,
    pendingRefunds: db.maybeOne<{ c: number }>(`SELECT COUNT(*) AS c FROM refunds WHERE state IN ('PENDING','SUBMITTED')`)?.c ?? 0,
    queuedPayouts: db.maybeOne<{ c: number }>(`SELECT COUNT(*) AS c FROM payouts WHERE state IN ('CREATED','QUEUED_FOR_RETRY')`)?.c ?? 0,
    simulated: config.isSandbox,
  };
}

/** CSV export for the reporting screen (spreadsheet-friendly, no BOM tricks). */
export function exportCsv(filters: AnalyticsFilters): string {
  const db = getDb();
  const clause = where(filters);
  const rows = db.all<Record<string, string | number | null>>(
    `SELECT reference, status, asset, network, rail, provider, recipient_currency, recipient_amount_minor,
            crypto_amount_minor, service_fee_minor, network_fee_minor, fx_rate_scaled, created_at, completed_at, failure_code
     FROM payment_intents WHERE ${clause.sql} ORDER BY created_at DESC LIMIT 5000`,
    clause.params,
  );
  const header = 'reference,status,asset,network,rail,provider,currency,recipient_amount_minor,crypto_amount_minor,service_fee_minor,network_fee_minor,fx_rate_scaled,created_at,completed_at,failure_code';
  const body = rows.map((row) =>
    [
      row.reference,
      row.status,
      row.asset,
      row.network,
      row.rail,
      row.provider,
      row.recipient_currency,
      row.recipient_amount_minor,
      row.crypto_amount_minor,
      row.service_fee_minor,
      row.network_fee_minor,
      row.fx_rate_scaled,
      row.created_at,
      row.completed_at ?? '',
      row.failure_code ?? '',
    ]
      .map((cell) => {
        const value = String(cell ?? '');
        return value.includes(',') ? `"${value}"` : value;
      })
      .join(','),
  );
  return [header, ...body].join('\n');
}

/** Per-merchant ranking for the admin merchants table. */
export function merchants(): Array<{ id: string; name: string; merchantCode: string; volumeKes: number; payments: number; successRatePct: number | null; kybStatus: string; status: string }> {
  return getDb()
    .all<{ id: string; name: string; merchant_code: string; volume: number; c: number; completed: number; kyb_status: string; status: string }>(
      `SELECT b.id, b.name, b.merchant_code,
              COALESCE(SUM(CASE WHEN i.status = 'COMPLETED' THEN CAST(i.recipient_amount_minor AS INTEGER) ELSE 0 END),0) / 100.0 AS volume,
              COUNT(i.id) AS c,
              SUM(CASE WHEN i.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
              b.kyb_status, b.status
       FROM businesses b LEFT JOIN payment_intents i ON i.business_id = b.id
       GROUP BY b.id ORDER BY volume DESC LIMIT 50`,
    )
    .map((row) => ({
      id: row.id,
      name: row.name,
      merchantCode: row.merchant_code,
      volumeKes: row.volume,
      payments: row.c,
      successRatePct: row.c > 0 ? Math.round(((row.completed ?? 0) / row.c) * 1000) / 10 : null,
      kybStatus: row.kyb_status,
      status: row.status,
    }));
}
