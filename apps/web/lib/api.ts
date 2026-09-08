/**
 * One fetch wrapper for the whole app.
 *
 * The API is reached through Next's rewrite at `/v1/*`, so requests are
 * same-origin: the session cookie is sent without CORS, no bearer token lives in
 * localStorage, and there is nowhere for a payment secret to leak into page code.
 */

let csrfToken: string | null = null;

export class ApiError extends Error {
  code: string;
  details: Record<string, unknown>;
  status: number;
  constructor(status: number, body: { error?: { code?: string; message?: string; details?: Record<string, unknown> } }) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code ?? 'INTERNAL';
    this.details = body?.error?.details ?? {};
  }
}

export function setCsrf(token: string | null): void {
  csrfToken = token;
}

export function csrf(): string | null {
  return csrfToken;
}

type Init = Omit<RequestInit, 'body'> & { body?: unknown };

export async function api<T = unknown>(path: string, init: Init = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(`/v1${path}`, {
    ...init,
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
    cache: 'no-store',
  });

  const text = await res.text();
  const parsed = text ? (safeJson(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new ApiError(res.status, parsed as { error?: Record<string, unknown> });
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'INTERNAL', message: 'The service returned something unreadable. Nothing was changed.' } };
  }
}

/** POST helper that always sends a fresh idempotency key per user intent. */
export function newKey(prefix = 'web'): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `${prefix}-${rand}`.slice(0, 200);
}
