'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Brand, Badge, Dot } from './ui';
import { useSession } from './SessionProvider';

const NAV = [
  { href: '/app', label: 'Overview' },
  { href: '/app/pay', label: 'Pay' },
  { href: '/app/transactions', label: 'Activity' },
  { href: '/app/merchant', label: 'Business' },
  { href: '/app/settings', label: 'Settings' },
];

/**
 * The header carries the two things a money screen must never hide: who you are
 * signed in as, and whether any of this is real. `mode` comes from the API: the
 * sandbox badge only exists while the deployment really is the sandbox, and it
 * disappears by itself on a live deployment.
 */
export function Chrome({ children }: { children: React.ReactNode }) {
  const { user, mode, isAdmin, signOut } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="relative z-10">
      <header className="sticky top-0 z-30 border-b border-hair bg-abyss/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1180px] items-center gap-6 px-5 py-3">
          <Brand />
          <nav className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => {
              const active = item.href === '/app' ? pathname === '/app' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-lg px-2.5 py-1.5 text-[13px] transition ${
                    active ? 'bg-slate-900 text-ink' : 'text-ink-dim hover:text-ink'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            {isAdmin ? (
              <Link href="/admin" className={`rounded-lg px-2.5 py-1.5 text-[13px] ${pathname.startsWith('/admin') ? 'bg-slate-900 text-ink' : 'text-ink-dim hover:text-ink'}`}>
                Operations
              </Link>
            ) : null}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {mode === 'sandbox' ? (
              <Badge tone="neutral" title="This is the AuraPay demo environment: rails, chains and identity checks are simulated by the sandbox so you can try every step safely.">
                demo environment
              </Badge>
            ) : null}
            {user ? (
              <div className="flex items-center gap-2">
                <span className="hidden text-[13px] text-ink-dim sm:inline">{user.fullName.split(' ')[0]}</span>
                <button
                  type="button"
                  className="btn-ghost !px-3 !py-1.5 text-[12px]"
                  onClick={async () => {
                    await signOut();
                    router.push('/signin');
                  }}
                >
                  Sign out
                </button>
              </div>
            ) : (
              <Link href="/signin" className="btn-primary !px-3.5 !py-1.5 text-[13px]">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1180px] px-5 py-6">{children}</main>
      <footer className="mx-auto max-w-[1180px] px-5 pb-10 pt-4">
        <div className="hairline mb-4" />
        <p className="max-w-[900px] text-[11px] leading-relaxed text-ink-faint">
          {mode === 'sandbox'
            ? 'Demo environment: settlement runs on simulated rails, chains, rates and identity checks so every step can be tried safely — no real value moves here.'
            : 'AuraPay operates through licensed payment, custody, FX and KYC/AML partners configured per jurisdiction.'}
        </p>
      </footer>
    </div>
  );
}
