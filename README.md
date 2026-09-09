# AuraPay

Stablecoin-to-local-payments network: pay in USDT/USDC/BTC/ETH, the recipient
receives KES on the rail they already use. Sandbox only — no real value moves.

## Run it locally

```bash
npm ci
npm run seed        # sandbox corpus, driven through the real payment pipeline
npm run dev         # shared (watch) + API :4000 + web :3000
```

Sign in at http://localhost:3000 with `kelvin@aurapay.dev` / `aurapay-sandbox`
(merchant: `amina@aurapay.dev`, staff: `admin@aurapay.dev`).

Useful checks: `npm run typecheck`, `npm run smoke -w @aurapay/api` (one fresh
payment end to end), `npm run verify:ledger -w @aurapay/api`.

`packages/shared` compiles to a gitignored `dist/`, so build it before anything
that imports it — `npm run dev` and each workspace's `prebuild` already do.

## Deploying

See [docs/DEPLOYING.md](docs/DEPLOYING.md). Short version: `apps/web` deploys to
Netlify; `apps/api` is a long-lived process (its job queue is what settles
payments) and needs a persistent host, with `AURAPAY_API_ORIGIN` pointing the web
app at it.
