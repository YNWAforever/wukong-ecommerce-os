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

**`deploy:production` cannot create a Worker that does not exist yet.** The
rendered config declares a `secrets` block, and wrangler refuses to create a new
Worker unless every declared secret is supplied _at deploy time_:

```
The following required secrets have not been set: QUEUE_INGRESS_SECRET,
OPENAI_API_KEY, SHOPLINE_TOKEN_ENCRYPTION_KEY, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY

This Worker does not exist yet, so secrets cannot be set in advance with
`wrangler secret put`.
```

So `wrangler secret put` is not available before the first deploy, and there is
no deploy-then-set-secrets ordering. All five values go in together, once, via a
secrets file. Every deploy after that uses the ordinary gated command.

Export the render inputs first — the deploy script sets `CLOUDFLARE_ENV` itself,
so do not pass it:

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

1. Render the config:

   ```bash
   CLOUDFLARE_ENV=production node scripts/render-cloudflare-config.mjs
   ```

2. Write a secrets file **outside the repository** — never inside it, and delete
   it when the deploy finishes. One `NAME=value` per line:

   ```
   QUEUE_INGRESS_SECRET=<generate a long random string; Vercel must hold the same value>
   OPENAI_API_KEY=<your OpenAI key>
   SHOPLINE_TOKEN_ENCRYPTION_KEY=<generated placeholder; inert under CSV-only operation>
   S3_ACCESS_KEY_ID=<R2 access key id>
   S3_SECRET_ACCESS_KEY=<R2 secret access key>
   ```

   `SHOPLINE_TOKEN_ENCRYPTION_KEY` is required by the config but **inert** under
   CSV-only operation — a generated placeholder is the correct value, not a real
   key. The two shopline queues are inert for the same reason.

3. Create the Worker:

   ```bash
   pnpm --filter @wukong/worker exec wrangler deploy src/cloudflare.ts \
     --config ../../.wrangler/wrangler.generated.jsonc \
     --secrets-file <path-outside-the-repo>
   ```

   Then delete the secrets file.

4. Every deploy after this one uses the ordinary gated command, which now works
   because the Worker exists:

   ```bash
   pnpm --filter @wukong/worker deploy:production
   ```

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
