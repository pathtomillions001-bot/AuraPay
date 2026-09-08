import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const API = process.env.AURAPAY_API_ORIGIN ?? 'http://127.0.0.1:4000';

/**
 * Same-origin proxy for the API.
 *
 * Doing this in middleware rather than a `rewrites` rule is deliberate: it is the
 * one place we can stamp the host the browser actually used. Without it the API
 * sees the internal `127.0.0.1:4000` host on every forwarded write, and its
 * same-origin check would refuse a perfectly legitimate request from a preview or
 * tunnel URL — while a cross-site page still cannot add this header, because
 * `x-forwarded-host` is not in the CORS allowlist and a preflight would stop it.
 */
export function middleware(request: NextRequest) {
  const target = new URL(API);
  target.pathname = request.nextUrl.pathname;
  target.search = request.nextUrl.search;

  const headers = new Headers(request.headers);
  const host = request.headers.get('host');
  if (host) headers.set('x-forwarded-host', host);
  const proto = request.headers.get('x-forwarded-proto') ?? (host?.startsWith('localhost') || host?.endsWith(':80') ? 'http' : 'https');
  headers.set('x-forwarded-proto', proto);

  return NextResponse.rewrite(target, { request: { headers } });
}

export const config = { matcher: ['/v1/:path*'] };
