import Link from 'next/link';
import { Chrome } from '../../components/Chrome';
import { Panel, SectionTitle, Badge } from '../../components/ui';

export const metadata = { title: 'Settlement rules — AuraPay' };

const RULES: Array<[string, string]> = [
  ['A price is a promise with a deadline', 'A quote carries the mid rate, the applied rate, the spread in basis points, the network fee, the rail surcharge and an expiry (90 seconds; 45 above Ksh 100,000). After expiry it is dead: the API refuses it and the UI asks for a new price. Nothing is silently repriced, and nothing quotes from a stale feed — a rate older than its own validity raises a stale-rate error instead.'],
  ['Money is held before it is moved', 'Confirming a payment moves the amount from your available balance into a reservation, and only then creates the intent and the deposit address. If a step fails before settlement, the reservation is released with a ledger entry saying so.'],
  ['A confirmation is evidence, not a timer', 'A deposit counts when the chain says so: confirmations are read from the blockchain provider and compared to the network&rsquo;s requirement (19 on Tron in this build). A payout counts when the rail returns a reference. Until then the payment is shown as waiting, with the reason.'],
  ['Settlement can wait; your money does not vanish', 'If the KES float for the chosen rail is short, the payment parks in a waiting-for-float state — the crypto deposit is still accepted and held, and you are told which side is short. Payments are never marked complete on hope.'],
  ['The ledger is append-only, enforced below the app', 'Journals cannot be updated or deleted by the application&rsquo;s own database role; corrections are new, dated, compensating entries that reference the original. Integrity checks run at every deploy: every journal must balance, every conversion must tie out, and the wallet cache must match customer liabilities.'],
  ['Refunds obey the rail', 'Where a provider has a reversal API, a failure is refunded automatically with a compensating journal. Where it does not — Daraja B2C, for example — the payment is marked for manual handling and the network fee you already paid to the chain is disclosed as unrecoverable. No instant-refund promise is made anywhere the rail cannot keep it.'],
  ['Keys and secrets stay out of the browser', 'The web app calls the API same-origin through a rewrite; the session is an httpOnly cookie and the CSRF token is scoped to it. API secrets are shown once at creation, stored as hashes, and a test key can never touch live data. Publishable keys can create a request for money and can never complete one.'],
  ['Sandbox never pretends', 'Simulated rails, chains, FX feeds and identity checks are labelled at the point of use, not in a footer. Demo data is produced by the same code path as a real payment, which is why one demo payment failed: that is what a rail rejection looks like.'],
];

export default function DocsPage() {
  return (
    <Chrome>
      <div className="mx-auto max-w-[820px] space-y-5">
        <div>
          <div className="label">Operating rules</div>
          <h1 className="mt-1 font-display text-[30px] leading-tight tracking-tight text-ink">What the system is required to do</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-dim">
            These are not marketing claims — each one is enforced in code, and the tests fail if the enforcement is removed. Where a rule depends on a
            third party, the sentence says which party and what happens when they do not deliver.
          </p>
        </div>

        <div className="space-y-3">
          {RULES.map(([title, body]) => (
            <Panel key={title} as="article">
              <h2 className="text-[14.5px] font-medium text-ink">{title}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-dim" dangerouslySetInnerHTML={{ __html: body }} />
            </Panel>
          ))}
        </div>

        <Panel>
          <SectionTitle hint={<Badge tone="neutral">v1</Badge>}>The API in four calls</SectionTitle>
          <pre className="overflow-x-auto rounded-lg border border-hair bg-slate-950/70 p-3 text-[11.5px] leading-relaxed text-ink-dim">
{`POST /v1/quotes          { asset, kind, recipientAmountKesMajor, recipientId }
POST /v1/payments        { quoteId, recipientId, strongConfirmation }
     Idempotency-Key: <per attempt>   x-csrf-token: <session token>
GET  /v1/payments/:id    → status, steps[], deposit, payout, receipt, failure
GET  /v1/realtime/stream → SSE; "refetch this" only, never "this succeeded"`}
          </pre>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
            Money leaves the API as decimal strings of minor units. A JSON number would turn a 64-bit integer into a float, and a receipt that says
            0.30000000000000004 USDT is a broken promise, not a rounding detail.
          </p>
        </Panel>

        <p className="text-[11.5px] leading-relaxed text-ink-faint">
          Back to <Link href="/" className="text-mint underline decoration-dotted">the product</Link>.
        </p>
      </div>
    </Chrome>
  );
}
