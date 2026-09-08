/**
 * Structured logging. JSON on stdout (machine-parsed in production), a compact
 * readable form in sandbox. No secrets, no full PII, no card/msisdn beyond the
 * masked forms the caller passes in.
 */
import { config } from './config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(config.observability.logLevel as LogLevel) ?? 'info'];

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const REDACTED_KEYS = /^(password|secret|authorization|cookie|token|apikey|api_key|privatekey|private_key|passkey|pin|otp|totp|masterPublicKey)$/i;

function scrub(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function emit(scope: string, level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const at = new Date().toISOString();
  if (config.observability.prettyLogs) {
    const suffix = fields && Object.keys(fields).length ? ` ${JSON.stringify(scrub(fields))}` : '';
    process.stdout.write(`${COLORS[level]}${at.slice(11, 23)} ${level.toUpperCase().padEnd(5)}\x1b[0m ${scope} · ${msg}${suffix}\n`);
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ level, time: at, scope, msg, ...(fields ? (scrub(fields) as object) : {}) })}\n`,
  );
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit(scope, 'debug', m, f),
    info: (m, f) => emit(scope, 'info', m, f),
    warn: (m, f) => emit(scope, 'warn', m, f),
    error: (m, f) => emit(scope, 'error', m, f),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('aurapay');
