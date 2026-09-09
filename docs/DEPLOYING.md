# Deploying AuraPay

## The two-process rule

The repo is two apps, and only one of them is deployable to a static/Jamstack host.

| | what it is | deployable to |
| --- | --- | --- |
| `apps/web` | Next.js 14 frontend. Talks to the API only through relative `/v1/*` URLs. | Netlify, Vercel, any Node host |
| `apps/api` | One long-lived Fastify process that also runs the settlement worker. | a host with a persistent process |

`apps/api` cannot run on serverless functions, and that is not a packaging
inconvenience — it is what the money path depends on:

* `workers/queue.ts` claims `job_queue` rows on a ~1s tick. **That loop is what
  moves a payment out of `AWAITING_PAYMENT`.** A function that is frozen between
  invocations settles nothing, so every payment would stall mid-pipeline forever
  with a customer holding a deposit address.
* `/v1/realtime/stream` is a long-lived SSE response (the processing screen is
  driven by it, not by polling).
* Sessions, the `@fastify/rate-limit` buckets and the FX cache are process memory.
* Sandbox storage is a file (`.data/aurapay.sqlite`); a serverless filesystem is
  ephemeral, so the ledger would vanish between deploys.

So: frontend on Netlify, API on Fly.io / Render / Railway / a VPS.

## Frontend on Netlify

`netlify.toml` at the repo root carries the working configuration. The one thing
that is easy to get wrong is build ordering, and it fails loudly:

`@aurapay/shared` is consumed through `packages/shared/dist`, which is gitignored.
A fresh clone has no `dist`, webpack cannot resolve the bare specifier, and the
deploy dies with `Module not found: Can't resolve '@aurapay/shared'` — while
`npm install` succeeded and the workspace symlinks in `node_modules/@aurapay/*`
are all present. Nothing is wrong with the install; the dependency simply has not
been compiled.

That is fixed structurally rather than in one command string, because deploy
providers let you configure the command in three different places and only the
repo can be made correct:

* `apps/web` has a **`prebuild`** that compiles `@aurapay/shared`. Any command that
  builds `@aurapay/web` gets the ordering for free — Netlify UI, Netlify toml, CI,
  or a human in a terminal.
* `apps/api` has the same `prebuild`, for the same reason in a Docker image.
* the root `typecheck` builds shared first, because `tsc` resolves the workspace
  through the same `dist/index.d.ts` and produced ~15 `TS2307` errors on a clean
  checkout (plus cascaded bogus errors where an unresolved import typed a `bigint`
  argument as `number`).

If you had already set a build command in the Netlify UI, **the UI value overrides
`netlify.toml`** — `commandOrigin: ui` in a deploy log is the tell. The `prebuild`
hook means the old UI command now works unchanged, but to make the toml
authoritative: *Site configuration → Build & deployment → Build command* → clear it.

Two smaller notes:

* `NODE_VERSION = "22"` is pinned in the toml. Without a pin Netlify picked
  24.20.0; the repo's engines require `>=20.11`.
* `⚠ No build cache found` is a suggestion, not an error, and it is configured in
  the UI (Continuous deployment → Caches), not in `netlify.toml`. Add
  `apps/web/.next/cache` if rebuilds are slow.

## Joining the two

* On Netlify: `AURAPAY_API_ORIGIN = https://api.<your-domain>` (read in
  `apps/web/middleware.ts`). The middleware rewrites `/v1/*` there and stamps
  `x-forwarded-host`, which is what lets the API's same-origin CSRF check accept a
  non-localhost host — cookies stay same-origin to the Netlify site and no API
  secret ever appears in frontend code. `CSRF_ALLOWED_ORIGINS` does not need the
  Netlify host for that reason; set it only for clients that bypass the proxy.
* On the API: `PUBLIC_URL = https://<your-netlify-origin>`. Payment links and QR
  codes are built from it, so a wrong value silently produces checkout URLs that
  point at the wrong place.
* Do not point the browser at the API directly. The frontend has no CORS
  dependency to remove and no bearer token to store; that same-origin design is
  deliberate.

## What "production" means for this build today

`AURAPAY_MODE=production` refuses to boot until the live integrations exist, and
`assertProductionReady()` in `apps/api/src/config.ts` prints why. Two of those
gates are genuine work, not configuration: no `pg` driver is installed, so
`DATABASE_DRIVER=postgres` throws by design rather than quietly running
production on SQLite, and there are no KYC/AML provider adapters.

What can be deployed today is the sandbox on a persistent host (a volume for the
SQLite file), clearly labelled: simulated rails, simulated FX, `data_origin =
'sandbox'` on every simulated row, and no claim anywhere of being a licensed
payment or virtual-asset service provider.
