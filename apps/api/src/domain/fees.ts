import {
  DomainError,
  FEE_SCHEDULES,
  RAILS,
  RAIL_SURCHARGES,
  feeSchedule,
  formatKes,
  mulDiv,
  type AssetCode,
  type NetworkCode,
  type PayableAsset,
  type RailCode,
} from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, nowIso } from '../lib/ids.js';
import { insert } from '../db/rows.js';
import { getRate } from './fx.js';
import { stringify } from '../lib/json.js';

/**
 * Fee schedule.
 *
 * The published schedule is the `fees` table; `FEE_SCHEDULES` in the shared
 * package is only the fallback used when a row is missing. A change is a **new
 * dated row**, never an UPDATE: quotes already issued must keep the numbers the
 * customer saw, and an admin must be able to answer "what did we charge on
 * 14 March?" from the data.
 *
 * Nothing here can create a hidden cost: the platform fee, the rail fee, the
 * network fee and the spread are all returned separately, and the quote builder
 * in `quotes.ts` is the only thing that turns them into a total a customer pays.
 */

export interface FeeRowOut {
  id: string;
  asset: string;
  rail: string;
  platformFeeBps: number;
  platformFeeMinKes: number;
  spreadBps: number;
  railSurchargeMinor: string;
  active: boolean;
  effectiveFrom: string;
  updatedBy: string | null;
  note: string | null;
}

export function list(includeFuture = false): FeeRowOut[] {
  const db = getDb();
  const rows = db.all<{
    id: string;
    asset: string;
    rail: string;
    platform_fee_bps: number;
    platform_fee_min_kes: number;
    spread_bps: number;
    rail_surcharge_minor: string;
    active: number;
    effective_from: string;
    updated_by: string | null;
    note: string | null;
  }>(
    `SELECT * FROM fees ${includeFuture ? '' : "WHERE effective_from <= datetime('now')"} ORDER BY asset, rail, effective_from DESC`,
  );
  const seen = new Set<string>();
  const out: FeeRowOut[] = [];
  for (const row of rows) {
    const key = `${row.asset}:${row.rail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: row.id,
      asset: row.asset,
      rail: row.rail,
      platformFeeBps: row.platform_fee_bps,
      platformFeeMinKes: row.platform_fee_min_kes,
      spreadBps: row.spread_bps,
      railSurchargeMinor: row.rail_surcharge_minor,
      active: row.active === 1,
      effectiveFrom: row.effective_from,
      updatedBy: row.updated_by,
      note: row.note,
    });
  }
  // Assets/rails with no explicit row inherit the shared defaults, and the UI
  // says so — an inherited schedule must not look like a configured one.
  for (const asset of Object.keys(FEE_SCHEDULES) as PayableAsset[]) {
    if (seen.has(`${asset}:*`)) continue;
    const schedule = FEE_SCHEDULES[asset];
    out.push({
      id: `default:${asset}`,
      asset,
      rail: '*',
      platformFeeBps: schedule.platformFeeBps,
      platformFeeMinKes: schedule.platformFeeMinKes,
      spreadBps: schedule.spreadBps,
      railSurchargeMinor: String(schedule.railSurchargeMinor),
      active: true,
      effectiveFrom: 'inherited',
      updatedBy: null,
      note: 'Built-in default from the published schedule. Not stored in the fees table yet.',
    });
  }
  return out;
}

export function effective(asset: PayableAsset, rail: RailCode) {
  const db = getDb();
  const row = db.maybeOne<{
    id: string;
    platform_fee_bps: number;
    platform_fee_min_kes: number;
    spread_bps: number;
    rail_surcharge_minor: string;
    effective_from: string;
  }>(
    `SELECT * FROM fees WHERE asset = ? AND active = 1 AND (rail = ? OR rail = '*')
     ORDER BY CASE WHEN rail = ? THEN 0 ELSE 1 END, effective_from DESC LIMIT 1`,
    [asset, rail, rail],
  );
  const fallback = feeSchedule(asset);
  const surcharge = RAIL_SURCHARGES[rail] ?? 0;
  return {
    source: row ? ('fees_table' as const) : ('published_default' as const),
    id: row?.id ?? null,
    asset,
    rail,
    platformFeeBps: row?.platform_fee_bps ?? fallback.platformFeeBps,
    platformFeeMinKes: row?.platform_fee_min_kes ?? fallback.platformFeeMinKes,
    spreadBps: row?.spread_bps ?? fallback.spreadBps,
    railSurchargeMinor: String(row?.rail_surcharge_minor ?? BigInt(fallback.railSurchargeMinor + surcharge)),
    effectiveFrom: row?.effective_from ?? 'now',
  };
}

/**
 * Indicative cost preview for the admin fee screen and the developer docs.
 * The *binding* numbers always come from `POST /v1/quotes`, which re-prices the
 * network fee at the moment of quoting.
 */
export function preview(input: { asset: PayableAsset; network: NetworkCode; rail: RailCode; recipientAmountKesMajor: number }) {
  if (input.recipientAmountKesMajor <= 0) throw new DomainError('VALIDATION_FAILED', 'Enter an amount greater than zero.');
  const unit = 100n;
  const recipient = BigInt(Math.round(input.recipientAmountKesMajor * 100));
  const schedule = effective(input.asset, input.rail);
  const railFee = RAILS[input.rail]
    ? mulDiv(recipient, BigInt(RAILS[input.rail].providerFeeBps), 10_000n) + BigInt(RAILS[input.rail].providerFixedFeeMinor)
    : 0n;
  const platformFeeKes = recipient * BigInt(schedule.platformFeeBps) / 10_000n < BigInt(schedule.platformFeeMinKes) * unit
    ? BigInt(schedule.platformFeeMinKes) * unit
    : (recipient * BigInt(schedule.platformFeeBps)) / 10_000n;
  const gross = recipient + railFee + BigInt(schedule.railSurchargeMinor);
  const rate = getRate(input.asset, 'KES');
  const applied = mulDiv(rate.rateScaled, 10_000n - BigInt(schedule.spreadBps), 10_000n);
  const crypto = mulDiv(gross * 10n ** 12n, 10n ** 12n, applied);
  return {
    asset: input.asset,
    rail: input.rail,
    recipientAmountMinor: recipient.toString(),
    recipientAmountFormatted: formatKes(recipient),
    railFeeMinor: railFee.toString(),
    railFeeFormatted: formatKes(railFee),
    platformFeeMinor: platformFeeKes.toString(),
    platformFeeFormatted: formatKes(platformFeeKes),
    railSurchargeMinor: schedule.railSurchargeMinor,
    spreadBps: schedule.spreadBps,
    midRate: Number(rate.midRateScaled) / 1e12,
    appliedRate: Number(applied) / 1e12,
    indicativeCrypto: Number(crypto) / 10 ** (input.asset === 'BTC' ? 8 : input.asset === 'ETH' ? 18 : 6),
    source: schedule.source,
    note: 'Indicative preview at current rates. The amount you pay is fixed by the quote, which also adds the network fee.',
  };
}

export function update(input: {
  asset: PayableAsset | 'KES';
  rail?: RailCode | '*';
  platformFeeBps: number;
  platformFeeMinKes: number;
  spreadBps: number;
  railSurchargeMinor?: number;
  note?: string;
  actor: string;
  effectiveFrom?: string;
}): FeeRowOut {
  if (config.isProduction && !config.compliance.allowManualApproval) {
    throw new DomainError('FORBIDDEN', 'Fee changes in production require the pricing approval workflow.');
  }
  if (input.platformFeeBps < 0 || input.platformFeeBps > 1000) {
    throw new DomainError('VALIDATION_FAILED', 'Platform fee must be between 0 and 1000 bps (10%).');
  }
  if (input.spreadBps < 0 || input.spreadBps > 500) {
    throw new DomainError('VALIDATION_FAILED', 'The spread must be between 0 and 500 bps. Larger numbers belong in a different product.');
  }
  const db = getDb();
  const feeId = id('fee');
  const rail = input.rail ?? '*';
  db.tx(() => {
    db.run(`UPDATE fees SET active = 0, updated_at = ? WHERE asset = ? AND rail = ? AND active = 1`, [nowIso(), input.asset, rail]);
    insert('fees', {
      id: feeId,
      asset: input.asset,
      rail,
      platform_fee_bps: input.platformFeeBps,
      platform_fee_min_kes: input.platformFeeMinKes,
      spread_bps: input.spreadBps,
      rail_surcharge_minor: input.railSurchargeMinor ?? 0,
      active: 1,
      effective_from: input.effectiveFrom ?? nowIso(),
      updated_by: input.actor,
      note: input.note ?? null,
    });
    insert('audit_logs', {
      id: id('aud'),
      actor_user_id: null,
      actor_type: 'ADMIN',
      action: 'fees.version_created',
      target_type: 'fee',
      target_id: feeId,
      metadata: stringify({
        asset: input.asset,
        rail,
        platformFeeBps: input.platformFeeBps,
        spreadBps: input.spreadBps,
        actor: input.actor,
        note: input.note ?? null,
      }),
    });
  });
  const row = db.maybeOne<Record<string, string | number | null>>('SELECT * FROM fees WHERE id = ?', [feeId]);
  return {
    id: feeId,
    asset: String(row?.asset ?? input.asset),
    rail,
    platformFeeBps: input.platformFeeBps,
    platformFeeMinKes: input.platformFeeMinKes,
    spreadBps: input.spreadBps,
    railSurchargeMinor: String(input.railSurchargeMinor ?? 0),
    active: true,
    effectiveFrom: String(row?.effective_from ?? nowIso()),
    updatedBy: input.actor,
    note: input.note ?? null,
  };
}

export function history(limit = 60) {
  return getDb()
    .all<{
      id: string;
      asset: string;
      rail: string;
      platform_fee_bps: number;
      spread_bps: number;
      effective_from: string;
      updated_by: string | null;
      note: string | null;
      active: number;
    }>(`SELECT * FROM fees ORDER BY effective_from DESC LIMIT ?`, [limit])
    .map((row) => ({
      id: row.id,
      asset: row.asset as AssetCode,
      rail: row.rail,
      platformFeeBps: row.platform_fee_bps,
      spreadBps: row.spread_bps,
      effectiveFrom: row.effective_from,
      updatedBy: row.updated_by,
      note: row.note,
      active: row.active === 1,
    }));
}
