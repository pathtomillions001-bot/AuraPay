import { formatCrypto, formatKes } from '@aurapay/shared';

/** Minor units arrive from the API as decimal strings; BigInt keeps them exact. */
export function kes(minor: string | bigint | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  try {
    return formatKes(typeof minor === 'string' ? BigInt(minor) : minor);
  } catch {
    return '—';
  }
}

export function crypto(minor: string | bigint | null | undefined, asset: string): string {
  if (minor === null || minor === undefined) return '—';
  try {
    return formatCrypto(typeof minor === 'string' ? BigInt(minor) : minor, asset as never);
  } catch {
    return '—';
  }
}

export function usd(minor: string | bigint | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  const value = Number(typeof minor === 'string' ? minor : minor.toString()) / 100;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const diff = Date.now() - at.getTime();
  if (Math.abs(diff) < 60_000) return diff >= 0 ? 'just now' : 'in a moment';
  if (Math.abs(diff) < 3_600_000) return `${Math.round(Math.abs(diff) / 60_000)}m ${diff >= 0 ? 'ago' : 'left'}`;
  if (Math.abs(diff) < 86_400_000) return `${Math.round(Math.abs(diff) / 3_600_000)}h ${diff >= 0 ? 'ago' : 'left'}`;
  return at.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
}

export function short(id: string | null | undefined, head = 8): string {
  if (!id) return '—';
  return id.length <= head + 4 ? id : `${id.slice(0, head)}…${id.slice(-4)}`;
}
