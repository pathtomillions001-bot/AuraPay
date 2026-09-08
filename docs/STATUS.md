# Build status — AuraPay

Live status of this working branch. Kept in the repo because "is it real yet?" should
be answerable without reading chat history.

## Proven running (not merely compiling)

```
npm -w @aurapay/shared run build     # clean
npx tsc -p apps/api/tsconfig.json --noEmit   # clean (run from the repo root)
python3 tools/check-sql-inserts.py   # all INSERT column/placeholder lists agree
MODE=sandbox npm -w @aurapay/api run seed          # full corpus + 8 driven payments
MODE=sandbox npm -w @aurapay/api run verify:ledger  # "Ledger integrity: OK"
MODE=sandbox npm -w @aurapay/api run smoke         # quote → settle → receipt → refund → re-verify
```

`npm run seed` builds the corridor and then drives the demo payments through the
**production code path** — the SQL job queue — not a seeding shortcut, so the
history in the sandbox is genuinely settled history:

| | |
| --- | --- |
| payments settled | 7 completed, each with a sha256-verified receipt |
| payments failed | 1, rejected by the simulated rail itself (real rejection → compensating entries → `retry_with_another_rail`) |
| assets / networks | USDT·TRON, USDC·ETHEREUM, USDC·SOLANA, BTC·BITCOIN, ETH·ETHEREUM |
| rails | M-Pesa (phone), Buy Goods till, PayBill |
| books | `ledger.verify()` reports no problems after seed, after a live payment, and after a refund |

`npm run smoke` additionally proves one fresh payment end to end from a cold
request: quote → hold → deposit address → simulated deposit → confirmations →
risk → conversion → float reservation → payout → provider confirmation →
COMPLETED → refund, with the ledger balanced at each gate. Nothing in that loop
calls the payment engine directly except the initial create; state advances only
because evidence exists.

## Architecture decided and enforced in code

* **Two processes**: Fastify API on `:4000`, Next.js on `:3000`, which rewrites
  `/v1/*` to the API so auth is same-origin and no CORS surface exists.
* **Data**: sync facade over `node:sqlite` for sandbox/demo/tests; the Postgres
  DDL mirror in `apps/api/db/postgres/0001_init.sql` is the production schema of
  record. Money is decimal **strings** in SQL (BigInt cannot bind through
  `node:sqlite`), integer minor units everywhere in code.
* **Ledger**: append-only, single-currency journals balanced per asset,
  two-currency conversions checked against `amount × rate` within the tolerance
  the *quote* allowed (stored on the journal, not a global fudge factor).
  Custody is relieved exactly once: user → `CLEARING:COMMITTED:<asset>` →
  custody on liquidation; the service fee is the only piece custody keeps; the
  network fee is a pass-through, so it is never also booked as an expense.
* **Routing**: capability gates which rails may compete, score decides between
  them, with a bounded preference for the rail the recipient handle was built
  for. No silent fallback to an instrument the recipient cannot use.
* **Honesty**: simulated rows carry `data_origin='sandbox'`; analytics computes
  from real rows; the landing-page network visualisation is typed `simulated: true`
  and labelled demonstration traffic.
* **Append-only exception**: `seed_lock` exists solely so the sandbox corpus can
  backdate *timestamps*. It refuses to arm outside sandbox mode, cannot touch
  amounts/states/directions, and writing and clearing it lands in `audit_logs`.

## Still to build

1. `apps/api/src/http/*` — routes (`/v1/quotes`, payment intents, links, payouts,
   transactions, refunds, balances, keys, webhooks incl. `POST /v1/webhooks/test`,
   realtime SSE `/v1/realtime/stream`), auth/session/CSRF/rate-limit wiring,
   `src/main.ts` calling `registerRefundHandler` / `registerXHandler` to break the
   import cycles, and `workers.start()`.
2. `apps/api/db/postgres/0001_init.sql` — mirror the SQLite schema: 4 new
   `refunds` columns, `ledger_journals.gross_to_minor / rate_scaled / pnl_minor /
   tolerance_minor`, expanded `receipts`, `liquidity_events`, `seed_lock` + the
   guarded triggers, `payment_intents.settlement_state`.
3. Docs: README, runbook, corridor/rail onboarding, security & compliance posture
   (support-not-claim wording, no licence claims anywhere).
4. `apps/web` — everything the user sees: landing + hero 3D (lazy, reduced-motion,
   2D fallback), auth shell, overview, Pay (5 rail tabs + live quote + trust panel),
   processing view driven only by backend state, success/receipt, requests,
   transactions, wallets, links/QR, bills, merchants, analytics, developer,
   settings, admin + treasury + compliance dashboards.
5. Boot both apps, curl the golden path, then wire the web app to the realtime bus.

## Known gaps to disclose rather than hide

* No `pg` driver is installed: `DATABASE_DRIVER=postgres` deliberately throws
  rather than silently running production on SQLite.
* External KYC/AML/screening adapters are absent; calls surface
  `PROVIDER_KEY_MISSING` instead of faking a check.
* Payout confirmation in sandbox arrives via the `payout.sandbox_confirm` job. In
  production it must come from a provider status query or IPN — a local timer is
  refused (`payout.sandbox_confirm` throws outside sandbox).
