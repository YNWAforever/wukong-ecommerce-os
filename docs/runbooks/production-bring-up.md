# Production bring-up

Bringing the Cloudflare Worker runtime up for the first time, so that drafts stop
falling back to `retry_required`.

Use this when the pipeline is unreachable — the Worker is missing, its secrets are
unset, or Vercel does not know where to send queue work. For redeploys of a Worker
that already exists, use `docs/runbooks/production-ai-runtime.md` instead; that
runbook assumes the runtime exists and this one creates it.

**No credential value appears in this file, and none should be added.** Every id,
endpoint and connection string below is written as a placeholder with the command
that reveals it. See `.env.example` for the same convention.

## Verified state as of 2026-08-01

Established by running the commands in "Reading the current state" below, not from
memory or assumption. Re-run them before trusting any of it.

| Component                                          | State                                              |
| -------------------------------------------------- | -------------------------------------------------- |
| Queues (all four)                                  | exist, created 2026-07-27                          |
| Hyperdrive config `wukong-neon-production`         | exists, points at the Neon pooler                  |
| Worker `wukong-runtime-production`                 | **does not exist** — never deployed                |
| The five Worker secrets                            | **cannot exist** — there is no Worker to hold them |
| Vercel `S3_*`, `DATABASE_URL`, `AUTH_*`            | set                                                |
| Vercel `QUEUE_INGRESS_URL`, `QUEUE_INGRESS_SECRET` | **absent**                                         |

## Prerequisites

- `wrangler` authenticated against the right Cloudflare account
  (`pnpm --filter @wukong/worker exec wrangler whoami`). Confirm the account id
  matches the one that owns the queues.
- A **paid Workers plan**. Cloudflare Queues is not available on the free plan.
- The Vercel CLI authenticated against `ynwaforevers-projects/wukong-ecommerce-os`.
- The Neon **runtime** connection string — never the admin URL.
- Postgres running locally if you intend to run `pnpm test`.

## Reading the current state

These commands are read-only and safe to run at any time.

```bash
pnpm --filter @wukong/worker exec wrangler whoami
pnpm --filter @wukong/worker exec wrangler queues list
pnpm --filter @wukong/worker exec wrangler hyperdrive list
pnpm --filter @wukong/worker exec wrangler secret list --name wukong-runtime-production
npx vercel env ls production
```

`wrangler secret list` failing with `Worker "wukong-runtime-production" not found`
is the signal that the Worker has never been deployed. That is a different problem
from secrets being missing, and it is the one that blocks everything else.

## First deploy of an environment

`deploy:production` now handles a Worker that does not exist: the secret preflight
warns and lets the deploy through, because `wrangler deploy` is about to create
it. No manual bootstrap is required.

The order still matters, because a Worker deployed without secrets fails at
runtime until they are set. Export the render inputs first — the deploy script
sets `CLOUDFLARE_ENV` itself, so do not pass it:

```bash
export CLOUDFLARE_HYPERDRIVE_ID="<id from wrangler hyperdrive list>"
export BUILD_SHA="$(git rev-parse HEAD)"
export AI_PROVIDER=openai
export OPENAI_LISTING_MODEL=gpt-5-mini
export S3_BUCKET=wukong-opak-prod-assets
export S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
export S3_REGION=auto
export S3_FORCE_PATH_STYLE=false
```

1. `pnpm --filter @wukong/worker deploy:production` — creates the Worker. The
   preflight prints a warning that the Worker did not exist and that secrets must
   be set before the environment is usable.

2. Set the five secrets now that the Worker exists. The exact commands are in
   `docs/runbooks/production-ai-runtime.md`; use
   `--name wukong-runtime-production`.

   `SHOPLINE_TOKEN_ENCRYPTION_KEY` is required by the preflight but **inert** under
   CSV-only operation. A generated placeholder is the correct value, not a real
   key. The two shopline queues are inert for the same reason.

3. `pnpm --filter @wukong/worker deploy:production` again — this time the preflight
   verifies all five secret names properly and the Worker runs with them.

## Wiring Vercel

`QUEUE_INGRESS_SECRET` must be **byte-identical** to the Worker secret of the same
name. A mismatch is the single most common failure in this sequence: both sides
report healthy and drafts silently stall.

```bash
npx vercel env add QUEUE_INGRESS_URL production      # the Worker origin
npx vercel env add QUEUE_INGRESS_SECRET production   # identical to the Worker secret
npx vercel --prod                                    # env vars apply at build time
```

## Verifying

```bash
QUEUE_INGRESS_URL="<worker-origin>" \
QUEUE_INGRESS_SECRET="<same-secret>" \
CLOUDFLARE_HYPERDRIVE_ID="<hyperdrive-id>" \
pnpm runtime:doctor production
```

`health-signed` is the check that matters. It is the only one that proves Vercel
and the Worker hold the same secret, because every other check proves only that a
value is _present_.

| `health-signed` says                               | Meaning                                              |
| -------------------------------------------------- | ---------------------------------------------------- |
| `secret agrees and the database answers`           | done                                                 |
| `Vercel's QUEUE_INGRESS_SECRET does not match ...` | the two values differ; re-set the Worker secret      |
| `secret matches, but the database did not answer`  | secret is fine; the Neon connection string is wrong  |
| `worker unreachable`                               | `QUEUE_INGRESS_URL` is wrong or the Worker is not up |

Finally, create a draft in the production app and confirm it no longer falls back
to `retry_required`.

## How the doctor reads Cloudflare state

`wrangler queues list` and `wrangler hyperdrive list` have no machine-readable
output — the only flag either accepts is `--page` — so the doctor parses their
box-drawing table, keyed off the header row.

That means the checks are parsing presentation output, and wrangler may change it.
A change surfaces as `unknown — output format changed`, never as a false answer.
If it recurs often, the fallback is the Cloudflare REST API, which costs a
`CLOUDFLARE_API_TOKEN` this repository deliberately does not currently need.

## Coverage the doctor does not have

A green doctor is necessary but not sufficient. It does not check R2 reachability
or queue-consumer health. The real proof is a wine going end to end — see the
pilot CSV phase's Track 3.

## Rollback

Nothing here is destructive, and none of it needs undoing on failure — a
half-configured runtime leaves drafts falling back to `retry_required`, which is
the same state as before you started.

To roll back a bad Worker deploy, redeploy the previous build:

```bash
pnpm --filter @wukong/worker exec wrangler deployments list --name wukong-runtime-production
pnpm --filter @wukong/worker exec wrangler rollback --name wukong-runtime-production
```

Do not delete the queues. They hold in-flight work, `runtime:provision` never
deletes by design, and recreating them does not restore anything.

## Escalation

- **Queues unavailable / plan errors** — Cloudflare billing. No tooling helps.
- **Hyperdrive connects but queries fail** — check the Neon role is the runtime
  role, not the admin one.
- **The first real end-to-end run** — treat SHOPLINE Tracks 1 and 3 in
  `docs/superpowers/specs/2026-07-30-pilot-end-to-end-csv-design.md` as the next
  step, not part of this runbook.
