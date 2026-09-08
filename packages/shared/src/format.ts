import { ASSET_SCALES, formatAmount, formatAmountFixed, type AssetCode } from './money.js';

const kes = new Intl.NumberFormat('en-KE', {
  style: 'currency',
  currency: 'KES',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const kesCompact = new Intl.NumberFormat('en-KE', {
  style: 'currency',
  currency: 'KES',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatKes(minor: bigint | string, opts: { compact?: boolean } = {}): string {
  const value = typeof minor === 'string' ? Number(minor) / 100 : Number(minor) / 100;
  if (!Number.isFinite(value)) return 'KES —';
  return opts.compact ? kesCompact.format(value) : kes.format(value);
}

/** Accepts a major-unit number/string (e.g. 350 → "KES 350.00"). */
export function formatKesMajor(major: number | string, opts: { compact?: boolean } = {}): string {
  const value = Number(major);
  if (!Number.isFinite(value)) return 'KES —';
  return opts.compact ? kesCompact.format(value) : kes.format(value);
}

export function formatUsd(minor: bigint | number, opts: { compact?: boolean } = {}): string {
  const value = typeof minor === 'bigint' ? Number(minor) / 100 : minor;
  if (opts.compact && Math.abs(value) >= 1000) return `$${compactNumber(value)}`;
  return usd.format(value);
}

export function formatCrypto(minor: bigint, asset: AssetCode, opts: { dp?: number } = {}): string {
  const dp = opts.dp ?? naturalDecimals(minor, asset);
  return `${formatAmountFixed(minor, asset, dp)} ${asset}`;
}

export function formatCryptoRaw(minor: bigint, asset: AssetCode): string {
  return formatAmount(minor, asset);
}

/**
 * Significant-digit aware precision. A sub-unit amount needs *more* decimals, not
 * fewer: `0.00002807 BTC` rendered at two decimals says `0.00`, and a money
 * document that says zero for a real fee is a lie by rounding.
 */
function naturalDecimals(minor: bigint, asset: AssetCode): number {
  const scale = ASSET_SCALES[asset];
  const abs = minor < 0n ? -minor : minor;
  if (abs === 0n) return Math.min(scale, 2);
  const whole = abs / 10n ** BigInt(scale);
  if (whole > 0n) return Math.min(scale, 6);
  let decimals = Math.min(scale, 4);
  while (decimals < scale && abs < 10n ** BigInt(scale - decimals + 3)) decimals += 1;
  return decimals;
}

export function formatRate(kesPerUnit: string, asset: AssetCode): string {
  const n = Number(kesPerUnit);
  if (!Number.isFinite(n)) return '—';
  const dp = n > 1000 ? 2 : n > 10 ? 4 : 6;
  return `1 ${asset} = ${groupDecimal(n, dp)} KES`;
}

/**
 * Fixed-point text with thousands separators on the integer part only. Grouping the
 * whole string (the old behaviour here) turned `128.9300` into `128.9,300` — a rate
 * that looks like a typo and is not a number any more.
 */
function groupDecimal(value: number, dp: number): string {
  const fixed = Math.abs(value).toFixed(dp);
  const [whole = '0', frac = ''] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = value < 0 ? '−' : '';
  return dp > 0 ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

/**
 * A `×10^12` scaled rate → `1 USDT = 128.9347 KES`.
 *
 * Deliberately in BigInt. The receipt used to be produced by handing the scaled
 * integer to a float formatter, which printed "1 USDT = 128,934,652,108,500.00 KES"
 * on a real document — a rate that is 10^12 out is not a rounding detail, it is the
 * number the customer would use to check their own arithmetic.
 */
export function formatScaledRate(rateScaled: bigint | string, asset: string, dp = 4): string {
  let scaled: bigint;
  try {
    scaled = typeof rateScaled === 'string' ? BigInt(rateScaled.trim()) : rateScaled;
  } catch {
    return '\u2014';
  }
  if (scaled <= 0n) return '\u2014';
  const unit = 1_000_000_000_000n;
  const whole = scaled / unit;
  const rest = scaled % unit;
  const safeDp = Math.max(0, Math.min(12, dp));
  const frac = safeDp === 0 ? '' : `.${((rest * 10n ** BigInt(safeDp)) / unit).toString().padStart(safeDp, '0')}`;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `1 ${asset} = ${grouped}${frac} KES`;
}

export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return value.toFixed(0);
}

export function formatPercent(value: number, dp = 2): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(dp)}%`;
}

/** Kenyan MSISDN: "0712345678" / "254712345678" / "+254 712 345 678" → "0712 345 678". */
export function normalizeMsisdn(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  let local = '';
  if (digits.startsWith('+254')) local = digits.slice(4);
  else if (digits.startsWith('254')) local = digits.slice(3);
  else if (digits.startsWith('0')) local = digits.slice(1);
  else local = digits;
  if (!/^[71]\d{8}$/.test(local)) return null;
  return `0${local}`;
}

export function maskPhone(msisdn: string): string {
  const local = normalizeMsisdn(msisdn) ?? msisdn.replace(/\D/g, '');
  if (local.length < 10) return local;
  return `${local.slice(0, 4)}${'X'.repeat(3)} ${local.slice(-3)}`.replace(/(\d{4})/, '$1 ');
}

/** Product-safe recipient display: 07XX XXX XXX style, per the spec. */
export function maskPhoneForDisplay(msisdn: string): string {
  const local = (normalizeMsisdn(msisdn) ?? '').replace(/\D/g, '');
  if (local.length !== 10) return msisdn;
  return `${local.slice(0, 2)}XX XXX ${local.slice(-3)}`;
}

export function formatPhone(msisdn: string): string {
  const local = normalizeMsisdn(msisdn) ?? msisdn.replace(/\D/g, '');
  if (local.length !== 10) return msisdn;
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}

export function formatTill(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 5 ? `Till ${digits}` : `Till ${digits.slice(-5).padStart(5, '0')}`;
}

export function shortId(id: string, head = 6, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function formatTxHash(hash: string): string {
  if (hash.length <= 20) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function formatDateTime(iso: string, timeZone = 'Africa/Nairobi'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-KE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(d);
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeZone: 'Africa/Nairobi' }).format(d);
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Math.round((now - t) / 1000);
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.round(diff / 86400)}d ago`;
  return formatDate(iso);
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}
