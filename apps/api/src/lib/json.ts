import { InvalidAmountError } from '@aurapay/shared';

/**
 * `JSON.stringify` that survives the two types this codebase actually stores:
 * BigInt minor units (which would throw) and Zod validation errors (which
 * serialise to `{}` and lose every message).
 */
export function stringify(value: unknown, space?: number): string {
  const replacer = (_key: string, val: unknown): unknown => {
    if (typeof val === 'bigint') return val.toString();
    if (val instanceof InvalidAmountError) return { error: val.constructor.name, message: val.message };
    return val;
  };
  return JSON.stringify(value, replacer, space);
}

/** Parse back into bigints for the keys listed in `bigintFields`. */
export function parse<T>(text: string | null | undefined, bigintFields: string[] = []): T | null {
  if (!text) return null;
  const raw = JSON.parse(text) as Record<string, unknown>;
  for (const field of bigintFields) {
    const key = field.split('.').at(-1) as string;
    const parentPath = field.split('.').slice(0, -1);
    let node: Record<string, unknown> = raw;
    for (const part of parentPath) {
      const next = node?.[part];
      if (next === null || typeof next !== 'object') break;
      node = next as Record<string, unknown>;
    }
    const current = node?.[key];
    if (typeof current === 'string' && /^-?\d+$/.test(current)) node[key] = BigInt(current);
  }
  return raw as T;
}
