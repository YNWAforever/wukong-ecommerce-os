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

## Blocking issue: the deploy pipeline cannot perform a first deploy

`pnpm --filter @wukong/worker deploy:production` runs, in order:

```
runtime-doctor --pre-deploy  →  render-cloudflare-config  →  verify-cloudflare-secrets  →  wrangler deploy
```

`verify-cloudflare-secrets.mjs` runs `wrangler secret list --name <worker>` and
aborts on any non-zero exit. On a Worker that does not exist yet, that call always
fails. So:

- you cannot set secrets, because there is no Worker to attach them to; and
- you cannot deploy the Worker, because the preflight demands the secrets first.

**The supported deploy path is for redeploys and cannot bootstrap a new
environment.** Break the cycle once, by hand, then never again:

1. Render the config and deploy directly, skipping the preflight, to create the
   Worker. Supply the eight render inputs (`CLOUDFLARE_ENV` is set by the script,
   so do not pass it here — render it explicitly instead):

   ```bash
   CLOUDFLARE_ENV=production \
   CLOUDFLARE_HYPERDRIVE_ID="<id from wrangler hyperdrive list>" \
   BUILD_SHA="$(git rev-parse HEAD)" \
   AI_PROVIDER=openai \
   OPENAI_LISTING_MODEL=gpt-5-mini \
   S3_BUCKET=wukong-opak-prod-assets \
   S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
   S3_REGION=auto \
   S3_FORCE_PATH_STYLE=false \
   node scripts/render-cloudflare-config.mjs

   pnpm --filter @wukong/worker exec wrangler deploy src/cloudflare.ts \
     --config ../../.wrangler/wrangler.generated.jsonc
   ```

2. Set the five secrets now that the Worker exists. The exact commands are in
   `docs/runbooks/production-ai-runtime.md`; use
   `--name wukong-runtime-production`.

   `SHOPLINE_TOKEN_ENCRYPTION_KEY` is required by the preflight but **inert** under
   CSV-only operation. A generated placeholder is the correct value, not a real
   key. The two shopline queues are inert for the same reason.

3. From here on, always use the gated path, which now works:

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

## Known defects in the doctor

**`queues` and `hyperdrive` always report `unknown`.** They shell out with
`--json`, which `wrangler queues list` and `wrangler hyperdrive list` do not
support — the only option either accepts is `--page`. The flag was inferred from
documentation rather than observed, and the unit-test fixtures were written to
match the inference, so the suite passes while the checks cannot work.

Until this is fixed, verify queues and Hyperdrive by eye with the read-only
commands above. The checks report `unknown` rather than `failed`, so they will not
send you to create resources that already exist — but they are not doing useful
work either.

**`worker-secrets` reports `unknown` when the Worker does not exist.** The more
useful message would name the missing Worker, since that is a different and more
fundamental problem than unset secrets.

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
