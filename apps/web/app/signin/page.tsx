'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, setCsrf } from '../../lib/api';
import { useSession } from '../../components/SessionProvider';
import { Brand, ErrorNote, Panel, SimulatedTag } from '../../components/ui';

const DEMO = [
  { email: 'kelvin@aurapay.dev', role: 'customer · tier 2 limits' },
  { email: 'amina@aurapay.dev', role: 'merchant · 2 businesses' },
  { email: 'admin@aurapay.dev', role: 'operations · treasury, cases, queue' },
];

function SignInInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, refresh } = useSession();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('kelvin@aurapay.dev');
  const [password, setPassword] = useState('aurapay-sandbox');
  const [fullName, setFullName] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const next = params.get('next') ?? '/app';

  useEffect(() => {
    if (user) router.replace(next);
  }, [user, router, next]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (user) {
      // Already signed in (e.g. an account was just created on this device and
      // the session cookie is live): sending another login would trip the CSRF
      // wall, which is correct but confusing here.
      router.replace(next);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        // Registration creates the session itself: the response carries the
        // CSRF token the next write needs. Do not send a second login.
        const created = await api<{ csrfToken?: string }>('/auth/register', {
          method: 'POST',
          body: { email, password, fullName, country: 'KE' },
        });
        setCsrf(created.csrfToken ?? null);
        await refresh();
        router.replace(next);
        return;
      }
      const res = await api<{ csrfToken: string; requiresTotp?: boolean }>('/auth/login', {
        method: 'POST',
        body: { email, password, totp: totp || undefined },
      });
      setCsrf(res.csrfToken);
      await refresh();
      router.replace(next);
    } catch (e) {
      const code = (e as { code?: string }).code;
      const details = (e as { details?: Record<string, unknown> }).details ?? {};
      if (details.requiresTotp || code === 'UNAUTHENTICATED') setNeedsTotp(true);
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative z-10 mx-auto flex min-h-screen max-w-[1080px] flex-col justify-center px-5 py-12">
      <div className="grid items-center gap-10 lg:grid-cols-[1fr_.85fr]">
        <div>
          <Brand />
          <h1 className="mt-6 max-w-[18ch] font-display text-[32px] leading-[1.1] tracking-[-0.02em] text-ink">
            Sign in to move money you can trace afterwards.
          </h1>
          <p className="mt-3 max-w-[60ch] text-[13.5px] leading-relaxed text-ink-dim">
            Sessions are httpOnly cookies scoped to this origin, and every write needs a CSRF token the page reads once. There is no
            &ldquo;continue with&rdquo; shortcut and no token in local storage to leak.
          </p>

          <div className="mt-8 space-y-2">
            <div className="label">
              Sandbox accounts <SimulatedTag text="password: aurapay-sandbox" />
            </div>
            {DEMO.map((d) => (
              <button
                key={d.email}
                type="button"
                onClick={() => {
                  setMode('login');
                  setEmail(d.email);
                  setPassword('aurapay-sandbox');
                  setError(null);
                }}
                className="flex w-full items-center justify-between gap-4 rounded-lg border border-hair bg-slate-950/60 px-3.5 py-2.5 text-left transition hover:border-mint-dim/60 hover:bg-slate-900/70"
              >
                <span className="money text-[13px] text-ink">{d.email}</span>
                <span className="text-[11px] text-ink-faint">{d.role}</span>
              </button>
            ))}
          </div>
        </div>

        <Panel className="p-6">
          <div className="mb-4 flex items-center gap-1 rounded-lg border border-hair bg-slate-950/70 p-1">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={`flex-1 rounded-md px-3 py-1.5 text-[12.5px] transition ${
                  mode === m ? 'bg-slate-800 text-ink' : 'text-ink-dim hover:text-ink'
                }`}
              >
                {m === 'login' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-3">
            <label className="block">
              <span className="label">Email</span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" className="input mt-1.5" required />
            </label>
            {mode === 'register' ? (
              <label className="block">
                <span className="label">Full name</span>
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} className="input mt-1.5" placeholder="As it appears on your ID" required />
              </label>
            ) : null}
            <label className="block">
              <span className="label">Password</span>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                className="input mt-1.5"
                required
                minLength={mode === 'register' ? 10 : undefined}
              />
              {mode === 'register' ? <span className="mt-1 block text-[11px] text-ink-faint">Ten characters minimum. We store a salted hash, never the password.</span> : null}
            </label>
            {needsTotp ? (
              <label className="block">
                <span className="label">Authenticator code</span>
                <input
                  value={totp}
                  onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  className="money input mt-1.5 tracking-[0.35em]"
                  placeholder="••••••"
                />
              </label>
            ) : null}

            <ErrorNote error={error} />

            <button type="submit" disabled={busy} className="btn-primary w-full">
              {busy ? 'Checking…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
            <p className="text-center text-[11px] leading-relaxed text-ink-faint">
              Six wrong passwords lock the account for 15 minutes — and a lockout is shown to you, not hidden behind a spinner.
            </p>
          </form>

          <div className="hairline my-4" />
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Registering in this sandbox creates an account with no KYC and no recipients. Limits and verification are enforced by the same code a
            live deployment uses. <Link href="/docs" className="text-ink-dim underline decoration-dotted">How settlement works</Link>
          </p>
        </Panel>
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInInner />
    </Suspense>
  );
}
