import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Suspense } from 'react';
import { Chrome } from '../components/Chrome';
import { LandingCalculator } from '../components/LandingCalculator';
import { NetworkStrip } from '../components/NetworkStrip';
import { Badge, Dot, SimulatedTag } from '../components/ui';

// Loaded after paint, and only in the browser: the landing page's first frame must
// not wait on a WebGL canvas, and a payment screen never imports this at all.
const Hero3D = dynamic(() => import('../components/Hero3D'), { ssr: false });

const SETTLEMENT_STEPS = [
  {
    n: '01',
    title: 'You pick a price, not a guess',
    body: 'AuraPay reads the market, adds the network fee and the platform fee in the open, and locks that number for 90 seconds. If the rate moves, the quote expires instead of quietly repricing you.',
  },
  {
    n: '02',
    title: 'The deposit is held, not assumed',
    body: 'Your crypto moves to a custody address for that payment only. Nothing is treated as received until the chain says so — confirmations are counted, not estimated.',
  },
  {
    n: '03',
    title: 'Risk and liquidity are checked',
    body: 'Screening and float availability run before the payout is created. If the KES float is short, the payment waits and tells you why, rather than failing after your money moved.',
  },
  {
    n: '04',
    title: 'The rail pays, then proves it',
    body: 'A payout is only marked confirmed from the provider’s own response. A step never turns green on a timer, so the processing screen cannot lie to you.',
  },
  {
    n: '05',
    title: 'You get a document, not a screenshot',
    body: 'Completion issues a receipt with a content hash and a shareable link that expires. Corrections are new, dated ledger entries — the original is never edited.',
  },
];

const NEVER_LIST = [
  ['Your private keys', 'Custody addresses are generated for a payment window. Signing material is never uploaded, stored or exported.'],
  ['Silent repricing', 'A quote carries its rate, fees and expiry. What you were shown is what is debited, or the quote dies.'],
  ['Ledger edits', 'Journals are append-only. A mistake is answered with a compensating entry that shows both sides and who made it.'],
  ['Invented refunds', 'Reversal depends on the rail. Where a provider offers no reversal API, we say so and route it to a human.'],
];

export default function LandingPage() {
  return (
    <Chrome>
      <section className="relative overflow-hidden rounded-2xl border border-hair bg-obsidian/60">
        <Suspense fallback={null}>
          <Hero3D />
        </Suspense>
        <div className="relative z-10 grid gap-10 px-6 py-14 md:grid-cols-[1.05fr_.95fr] md:px-10 md:py-20">
          <div>
            <Badge tone="neutral" title="Simulated end to end: no licensed institution is being used yet.">
              <Dot tone="warn" pulse /> sandbox build — no real value moves
            </Badge>
            <h1 className="mt-5 max-w-[15ch] font-display text-[38px] leading-[1.03] tracking-[-0.025em] text-ink md:text-[54px]">
              Send stablecoins.
              <br />
              They land as shillings.
            </h1>
            <p className="mt-5 max-w-[62ch] text-[15px] leading-relaxed text-ink-dim">
              AuraPay turns USDT, USDC, BTC or ETH into a payout on the rail your recipient already uses — M-Pesa, a till, a PayBill or a
              bank — with the price, the fees and the expiry shown before you commit, and a settlement trail you can read afterwards.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/signin" className="btn-primary">
                Open the sandbox
              </Link>
              <Link href="/app/pay" className="btn-ghost">
                Try a live price →
              </Link>
              <Link href="/docs" className="text-[13px] text-ink-dim underline decoration-dotted hover:text-ink">
                read the settlement rules
              </Link>
            </div>
            <dl className="mt-10 grid max-w-[560px] grid-cols-2 gap-x-8 gap-y-4 border-t border-hair pt-6 sm:grid-cols-3">
              {[
                ['90 s', 'price lock, then it expires'],
                ['0.10%', 'platform fee, floor Ksh 32'],
                ['19', 'TRON confirmations before payout'],
              ].map(([v, k]) => (
                <div key={k}>
                  <dt className="money text-[19px] text-ink">
                    {v}
                    <SimulatedTag text="demo" />
                  </dt>
                  <dd className="text-[11px] leading-snug text-ink-faint">{k}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="relative">
            <LandingCalculator />
          </div>
        </div>
      </section>

      <NetworkStrip />

      <section className="mt-14">
        <div className="mb-6 flex items-end justify-between gap-6">
          <div>
            <h2 className="font-display text-[26px] tracking-[-0.02em] text-ink">What actually happens to your money</h2>
            <p className="mt-1.5 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-dim">
              Five stages, each one written to the ledger by the service that observed it. This is the same list the processing screen renders,
              step for step.
            </p>
          </div>
        </div>
        <ol className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {SETTLEMENT_STEPS.map((s) => (
            <li key={s.n} className="panel p-5">
              <div className="money text-[12px] text-mint-dim">{s.n}</div>
              <h3 className="mt-2 text-[14px] font-medium text-ink">{s.title}</h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-dim">{s.body}</p>
            </li>
          ))}
          <li className="panel border-mint/20 bg-mint/[0.04] p-5">
            <h3 className="text-[14px] font-medium text-ink">You are never asked to wait for an animation</h3>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-dim">
              The screen follows the backend. If settlement is slow, it says slow and tells you what it is waiting on; if it is finished, it stops
              immediately.
            </p>
          </li>
        </ol>
      </section>

      <section className="mt-14 grid gap-8 lg:grid-cols-[1.1fr_.9fr]">
        <div className="panel p-6">
          <h2 className="font-display text-[22px] tracking-tight text-ink">Four things we will not do with your money</h2>
          <div className="mt-4 divide-y divide-hair">
            {NEVER_LIST.map(([title, body]) => (
              <div key={title} className="py-3.5">
                <div className="flex items-start gap-2.5">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-mint" />
                  <div>
                    <div className="text-[13.5px] font-medium text-ink">{title}</div>
                    <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-dim">{body}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <div className="panel p-6">
            <h3 className="font-display text-[18px] text-ink">For businesses</h3>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-dim">
              A payment link and one printed QR carry the destination, not the rail: the payer chooses M-Pesa, a till, a PayBill or a bank.
              Settlement reporting, expiring links, refund capability per rail and signed webhooks are part of the same account.
            </p>
            <Link href="/signin?next=/app/merchant" className="mt-4 inline-block text-[13px] text-mint underline decoration-dotted">
              see the merchant console
            </Link>
          </div>
          <div className="panel p-6">
            <h3 className="font-display text-[18px] text-ink">For developers</h3>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-dim">
              Quote → pay → poll or subscribe. Idempotency keys are mandatory on anything that moves value, `test` and `live` keys cannot see each
              other’s data, and webhook payloads are HMAC-signed with a five-minute replay window.
            </p>
            <Link href="/admin" className="mt-4 inline-block text-[13px] text-mint underline decoration-dotted">
              provider &amp; queue state
            </Link>
          </div>
        </div>
      </section>
    </Chrome>
  );
}
