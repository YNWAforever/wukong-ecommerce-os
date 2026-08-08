# Runtime bring-up doctor — design

Date: 2026-08-01
Status: accepted

## Goal

One command tells an operator exactly which step of the production bring-up is
wrong, and one command creates the resources whose names the repository already
declares:

```
pnpm runtime:doctor production      # name the broken step, print its fix
pnpm runtime:provision production   # create the four queues, idempotently
```

The phase is finished when a deliberately broken environment — a queue absent, a
secret mismatched between Vercel and the Worker — produces a report naming that
step and nothing else.

## Why this, and why now

The CSV phase shipped code that has never run against reality. The Worker has
never been deployed, `QUEUE_INGRESS_URL` and `QUEUE_INGRESS_SECRET` are unset in
Vercel, and drafts correctly fall back to `retry_required`. That phase's own
definition of done — a product in SHOPLINE with resolving images — is unmet.

The blocker is not engineering appetite. It is that bring-up is roughly a dozen
manual steps — four queues, a Hyperdrive config, five Worker secrets, nine render
inputs, two Vercel variables, a redeploy — with **no signal telling you which one
you got wrong**. Every step reports success locally and the failure only appears
much later, as a draft that quietly stops moving.

This phase produces no user-visible feature. It exists so the previous phase can
finish. Building further features on an unexercised pipeline compounds the risk
that the first real run fails in several places at once, with nothing to
attribute the failure to.

## What already exists

More than expected, which shrinks this phase considerably.

- `scripts/render-cloudflare-config.mjs` renders the Wrangler config from
  `cloudflare-runtime.config.json` and **already validates its inputs strictly**:
  the bucket must match the selected environment, the endpoint must be an R2 S3
  API root, the region must be `auto`, path-style must be false.
- `scripts/verify-cloudflare-secrets.mjs` preflights the five secret names and
  exports `compareSecretNames` / `verifyExactSecretNames` as pure functions —
  reusable here, and the model for how these scripts are structured.
- `GET /health` exists on the Worker. `workerHealth()` in
  `apps/worker/src/cloudflare-runtime.ts:164` already reports `buildSha`,
  `adapterMode`, and binding booleans for `hyperdrive`, `listingQueue`,
  `shoplineQueue`, and `ingressSecret`.
- `cloudflare-runtime.config.json` already names every queue, worker, and bucket
  per environment. Provisioning has a single source of truth to work from and
  invents no names of its own.

## The gap the health endpoint cannot close

`workerHealth()` reports presence, not agreement. `ingressSecret: true` means the
Worker holds _a_ secret — not that it holds the _same_ secret Vercel signs with.
That mismatch is the defining failure of this system: both sides report healthy,
every check passes, and drafts still fall back to `retry_required`. Likewise
`hyperdrive: true` means a connection string is bound, not that Postgres answers.

**A static check cannot detect a mismatch between two systems.** Only a signed
round trip can.

So `/health` learns to accept a **signed `POST`**, authenticated with the existing
`verifyQueueRequest`. `GET` is unchanged — unauthenticated, booleans only, no new
disclosure. The signed `POST` additionally returns what the unauthenticated form
must never expose: that the HMAC verified, and that Hyperdrive opened a real
connection. The doctor signs that request with the secret **read from Vercel's
environment**, so the two sides are compared rather than inspected separately.

This is a smaller change than adding a route, and it keeps one health surface
rather than two that can drift.

## Components

**`scripts/runtime-doctor.mjs`** — pure exported functions plus a thin `main()`
that shells out, matching `verify-cloudflare-secrets.mjs`. Checks run in
dependency order:

1. wrangler authenticated and the account reachable
2. the four queues exist (`wrangler queues list --json`)
3. a Hyperdrive config exists and its id matches `CLOUDFLARE_HYPERDRIVE_ID`
4. the five Worker secrets are set (reusing `verifyExactSecretNames`)
5. `GET /health` — Worker deployed, every binding boolean true, `buildSha` as expected
6. Vercel holds `QUEUE_INGRESS_URL` and `QUEUE_INGRESS_SECRET`
7. signed `POST /health` — the HMAC agrees and Hyperdrive connects

**`scripts/provision-queues.mjs`** — creates exactly the four queues named in the
config for the selected environment, treating "already exists" as success. It
creates only what the config declares and never deletes.

**Worker change** — `POST /health` behind `verifyQueueRequest`, with a live
Hyperdrive connection attempt included in the authenticated response only.

**Wiring** — `deploy:preview` and `deploy:production` run checks 1–4 first: the
preconditions that must hold _before_ a deploy can succeed. Checks 5–7 require a
deployed Worker and so are reachable only from `runtime:doctor` itself. The
existing commands gain the guardrail without diagnosis becoming a side effect of
deploying.

Both scripts are registered as root `package.json` scripts (`runtime:doctor`,
`runtime:provision`), alongside the existing `format:runtime:check`.

## Reporting

Each check returns `{ id, ok, detail, fix }`. The report prints the fix command
for anything red. Two rules carry most of the value:

- **A failed check marks its dependents `blocked`, not `failed`.** If the queues
  are absent, the health probe's result is meaningless; reporting it as a second
  failure sends the operator fixing two things when one is broken.
- **`unknown` is distinct from `failed`.** wrangler unauthenticated, or the
  network down, must never render as "your queues are missing". A confidently
  wrong diagnosis is worse than no diagnosis, because it is acted upon.

The doctor prints names and booleans only, never secret values — the `CLAUDE.md`
logging rule applies to it directly. It exits non-zero when any check fails so
the deploy scripts can gate on it.

The report states explicitly that `SHOPLINE_TOKEN_ENCRYPTION_KEY` and the two
shopline queues are required but inert under CSV-only operation. A placeholder
that looks wrong is exactly the kind of thing that stalls a bring-up.

## Testing

Pure functions are unit-tested against fixture JSON, mirroring the existing
secret-verifier tests: queue-list parsing, Hyperdrive id matching, health-response
assertions, and the `blocked`/`unknown`/`failed` propagation — the last of these
being the behaviour most likely to regress into noise.

The Worker gets tests for `POST /health`: rejects unsigned (401), rejects a bad
signature, rejects a stale timestamp, accepts a valid one. One test pins `GET`'s
response body so the unauthenticated surface cannot grow by accident.

No new integration tests. The doctor's subject is live infrastructure, and a
mocked Cloudflare proves nothing about the real one.

## Out of scope

Creating the Hyperdrive config, pushing Worker secrets, and writing Vercel
configuration. All three handle credential values, and a tool that takes secrets
as arguments invites them into shell history and CI logs. These stay manual, and
the doctor names them precisely when they are missing.

Also out of scope: direct SHOPLINE API integration, multi-operator access, batch
export, and making `SHOPLINE_TOKEN_ENCRYPTION_KEY` genuinely optional.

## Risks

- **The doctor passes and the pipeline still fails.** Seven checks are not the
  whole system; R2 reachability and queue _consumer_ health are unverified. The
  signed probe covers the failure that has actually blocked this pilot, not every
  possible one.
- **wrangler output format changes.** Parsing `--json` output couples the doctor
  to Cloudflare's CLI. Mitigated by keeping parsing in small pure functions with
  fixture tests, so a format change fails loudly in unit tests rather than
  silently mis-reporting.
- **`POST /health` widens the Worker's authenticated surface.** It performs no
  work, enqueues nothing, and returns booleans — but it is one more
  HMAC-authenticated path to keep correct, which the replay and signature tests
  exist to hold.
