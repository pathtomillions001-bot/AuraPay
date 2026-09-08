/**
 * Exact fixed-point money arithmetic.
 *
 * Every monetary value in AuraPay is represented as an integer count of the
 * asset's minor unit (see `ASSET_SCALES`). Floats are never used for money:
 * quote math, ledger postings and balances are all `bigint`.
 *
 * Wire format: decimal *strings* (e.g. "2.710000"), parsed with
 * `parseAmount` / rendered with `formatAmount`.
 */

/** Number of decimal places for one unit of an asset. */
export const ASSET_SCALES = {
  // stablecoins
  USDT: 6,
  USDC: 6,
  // crypto
  BTC: 8,
  ETH: 18,
  // fiat
  KES: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  UGX: 0,
  TZS: 2,
  NGN: 2,
  GHS: 2,
  ZAR: 2,
} as const;

export type AssetCode = keyof typeof ASSET_SCALES;
export type MoneyAssetCode = AssetCode;

export const FIAT_CODES = [
  'KES',
  'USD',
  'EUR',
  'GBP',
  'AED',
  'UGX',
  'TZS',
  'NGN',
  'GHS',
  'ZAR',
] as const satisfies readonly AssetCode[];

export const CRYPTO_CODES = ['USDT', 'USDC', 'BTC', 'ETH'] as const satisfies readonly AssetCode[];

export function scaleOf(asset: AssetCode): number {
  const scale = ASSET_SCALES[asset];
  if (scale === undefined) throw new Error(`unknown asset: ${asset}`);
  return scale;
}

export function unitOf(asset: AssetCode): bigint {
  return 10n ** BigInt(scaleOf(asset));
}

/** "2.71" -> 2710000n for a 6-decimal asset. Accepts trailing/leading zeros, rejects garbage. */
export function parseAmount(input: string | number | bigint, asset: AssetCode): bigint {
  if (typeof input === 'bigint') return input;
  const raw = typeof input === 'number' ? fixedNumber(input, scaleOf(asset) + 4) : String(input).trim();
  const match = /^([+-]?)0*(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) throw new InvalidAmountError(raw, asset);
  const sign = match[1] ?? '';
  const whole = match[2] ?? '';
  const frac = match[3] ?? '';
  const scale = scaleOf(asset);
  if (frac.length > scale) throw new InvalidAmountError(raw, asset);
  const digits = (whole + frac.padEnd(scale, '0')) || '0';
  const value = BigInt(digits);
  return sign === '-' ? -value : value;
}

/** 2710000n -> "2.71" (trailing zeros trimmed) for a 6-decimal asset. */
export function formatAmount(minor: bigint, asset: AssetCode, opts: { trim?: boolean } = {}): string {
  const scale = scaleOf(asset);
  const neg = minor < 0n;
  const abs = (neg ? -minor : minor).toString().padStart(scale + 1, '0');
  const cut = abs.length - scale;
  const whole = abs.slice(0, cut) || '0';
  let frac = scale > 0 ? abs.slice(cut) : '';
  if (scale > 0 && opts.trim !== false) frac = frac.replace(/0+$/, '');
  if (scale > 0 && frac === '' && opts.trim === false) frac = '0'.repeat(scale);
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** 2710000n -> "2.71" with exactly `dp` fraction digits (no trimming). */
export function formatAmountFixed(minor: bigint, asset: AssetCode, dp = scaleOf(asset)): string {
  const full = formatAmount(minor, asset, { trim: false });
  if (dp >= scaleOf(asset)) return full.padEnd(dp + (full.includes('.') ? 1 : 2), '0');
  const [whole, frac = ''] = full.split('.');
  const rounded = roundHalfUpString(`${whole}.${frac}`, dp);
  const rparts = rounded.split('.');
  return `${rparts[0]}${rparts[1] ? `.${rparts[1]}` : ''}`;
}

export class InvalidAmountError extends Error {
  constructor(
    readonly input: string,
    readonly asset: AssetCode,
  ) {
    super(`invalid amount "${input}" for asset ${asset}`);
    this.name = 'InvalidAmountError';
  }
}

/** Integer division with half-up rounding: (a * b) / d. */
/**
 * Money amounts travel through SQLite as TEXT (a 64-bit minor value must not
 * pass through a float), so a value typed `bigint` can arrive as a numeric
 * string at runtime. Every arithmetic helper coerces defensively rather than
 * throwing "Cannot mix BigInt and other types" deep inside a payment.
 */
const asBigInt = (value: bigint): bigint =>
  typeof value === 'bigint' ? value : BigInt(value as unknown as string | number);

export function mulDiv(aRaw: bigint, bRaw: bigint, dRaw: bigint): bigint {
  const a = asBigInt(aRaw);
  const b = asBigInt(bRaw);
  const d = asBigInt(dRaw);
  if (d === 0n) throw new RangeError('division by zero');
  const neg = a < 0n !== b < 0n;
  const num = (a < 0n ? -a : a) * (b < 0n ? -b : b);
  const den = d < 0n ? -d : d;
  let q = num / den;
  const r = num % den;
  if (r * 2n >= den) q += 1n;
  return neg ? -q : q;
}

/** Truncate-toward-zero division, used for available-vs-reserved accounting. */
export function divTrunc(a: bigint, d: bigint): bigint {
  return asBigInt(a) / asBigInt(d);
}

export const BPS_DENOMINATOR = 10_000n;

/** Apply basis points to a minor-unit amount (half-up). */
export function applyBps(amount: bigint, bps: number | bigint): bigint {
  return mulDiv(amount, asBigInt(bps as bigint), BPS_DENOMINATOR);
}

/**
 * Convert an amount from one asset to another given a rate expressed as
 * `1 source-unit = rate target-units` (scaled by `RATE_PRECISION`).
 */
export const RATE_PRECISION = 12;
export const RATE_SCALE = 10n ** BigInt(RATE_PRECISION);

/** rateKesPerUnit: minor KES per whole unit of `asset`, scaled by 10^12. */
export function kesToAsset(kesMinor: bigint, rateKesPerUnitScaled: bigint, asset: AssetCode): bigint {
  // assetMinor = kesMinor * 10^assetScale * ratePrecisionScale / (rate * kesScale)
  return mulDiv(kesMinor * unitOf(asset) * RATE_SCALE, 1n, rateKesPerUnitScaled * unitOf('KES'));
}

export function assetToKes(assetMinor: bigint, rateKesPerUnitScaled: bigint, asset: AssetCode): bigint {
  return mulDiv(assetMinor * rateKesPerUnitScaled * unitOf('KES'), 1n, unitOf(asset) * RATE_SCALE);
}

export function usdToAsset(usdMinor: bigint, asset: AssetCode): bigint {
  // USD and stablecoins are treated as 1:1 at the *display* layer only; real
  // conversion always goes through the quote/FX layer.
  return mulDiv(usdMinor * unitOf(asset), 1n, unitOf('USD'));
}

function fixedNumber(value: number, dp: number): string {
  if (!Number.isFinite(value)) throw new Error('non-finite amount');
  return value.toFixed(Math.min(dp, 12));
}

function roundHalfUpString(value: string, dp: number): string {
  const parts = value.split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '';
  if (dp <= 0) {
    const bump = Number(frac[0] ?? '0') >= 5;
    return String(BigInt(whole) + (bump ? 1n : 0n));
  }
  const keep = frac.slice(0, dp).padEnd(dp, '0');
  const next = Number(frac[dp] ?? '0');
  let digits = BigInt(whole + keep) + (next >= 5 ? 1n : 0n);
  const s = digits.toString().padStart(dp + 1, '0');
  return `${s.slice(0, s.length - dp)}${dp > 0 ? `.${s.slice(s.length - dp)}` : ''}`;
}

/** Sum of minor-unit amounts. */
export function sumAmounts(values: readonly bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, 0n);
}

export function isZero(v: bigint): boolean {
  return v === 0n;
}

export function maxAmount(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minAmount(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
