# Production Cloudflare runtime

This is an operator runbook, not authorization to provision or deploy. Obtain explicit approval before creating paid or production resources, changing secrets, or deploying. Preview is synthetic and `SHOPLINE_ADAPTER=mock`. Production starts with `SHOPLINE_ADAPTER=disabled` and `SHOPLINE_PUBLISH_ENABLED=false`. A separate final confirmation is mandatory immediately before the first real SHOPLINE write.

Never record secret values in Git, tickets, logs, deployment notes, or chat. Record only names, IDs, timestamps, commit SHAs, safe counts, and safe outcome codes.

## Exact isolated resources

| Environment | Resource          | Exact name                       |
| ----------- | ----------------- | -------------------------------- |
| Preview     | Worker            | `wukong-runtime-preview`         |
| Production  | Worker            | `wukong-runtime-production`      |
| Preview     | AI Queue          | `wukong-listing-preview`         |
| Production  | AI Queue          | `wukong-listing-production`      |
| Preview     | AI DLQ            | `wukong-listing-dlq-preview`     |
| Production  | AI DLQ            | `wukong-listing-dlq-production`  |
| Preview     | SHOPLINE Queue    | `wukong-shopline-preview`        |
| Production  | SHOPLINE Queue    | `wukong-shopline-production`     |
| Preview     | SHOPLINE DLQ      | `wukong-shopline-dlq-preview`    |
| Production  | SHOPLINE DLQ      | `wukong-shopline-dlq-production` |
| Preview     | Hyperdrive        | `wukong-neon-preview`            |
| Production  | Hyperdrive        | `wukong-neon-production`         |
| Preview     | private R2 bucket | `wukong-opak-preview-assets`     |
| Production  | private R2 bucket | `wukong-opak-prod-assets`        |

Preview and production use different Workers, Queues, DLQs, Hyperdrive configurations, R2 buckets, Neon branches/databases, ingress secrets, object credentials, and Vercel environment scopes. Every R2 object remains under its `ws/<workspaceId>/...` prefix. Public bucket access and wildcard CORS are forbidden.

## Provisioning

After approval, create exactly two primary Queues and their two matching DLQs for the selected environment before deploying its Worker. The checked-in generated Wrangler configuration attaches the consumer policies: batch size `1`, maximum retries `3`, retry delay `30`, concurrency `1`, and the matching DLQ.

```powershell
corepack pnpm --filter @wukong/worker exec wrangler queues create <exact-queue-name>
corepack pnpm --filter @wukong/worker exec wrangler r2 bucket create <exact-r2-bucket-name>
corepack pnpm --filter @wukong/worker exec wrangler hyperdrive create <exact-hyperdrive-name> --connection-string="$env:CONTROLLED_NEON_RUNTIME_URL" --caching-disabled
```

Run the Queue command once for each exact Queue and DLQ in the table. The Hyperdrive command must use the environment's runtime Neon role, never the admin URL. Capture its non-secret configuration ID as `CLOUDFLARE_HYPERDRIVE_ID`.

Set every explicit non-secret renderer input. `S3_BUCKET` must be the exact bucket from the table. `S3_ENDPOINT` must be the standard Cloudflare R2 S3 API root `https://<32-hex-account-id>.r2.cloudflarestorage.com`; credentials, ports, non-root paths, queries, and fragments are rejected. Managed R2 uses region `auto` and no path-style addressing. Preview may use `AI_PROVIDER=fake`; production uses `AI_PROVIDER=openai`. The renderer always forces preview to `SHOPLINE_ADAPTER=mock`, production to `SHOPLINE_ADAPTER=disabled`, and both to `SHOPLINE_PUBLISH_ENABLED=false`; caller-supplied SHOPLINE values cannot override that lock.

```powershell
$env:CLOUDFLARE_ENV = "<preview-or-production>"
$env:CLOUDFLARE_HYPERDRIVE_ID = "<configuration-id>"
$env:BUILD_SHA = "<accepted-commit-sha>"
$env:AI_PROVIDER = "<fake-or-openai>"
$env:OPENAI_LISTING_MODEL = "<approved-model>"
$env:S3_BUCKET = "<exact-environment-bucket>"
$env:S3_ENDPOINT = "https://<32-hex-account-id>.r2.cloudflarestorage.com"
$env:S3_REGION = "auto"
$env:S3_FORCE_PATH_STYLE = "false"
node scripts/render-cloudflare-config.mjs
$deploymentEnvironment = $env:CLOUDFLARE_ENV
Remove-Item Env:CLOUDFLARE_ENV
corepack pnpm --filter @wukong/worker types
```

Install each required Worker secret interactively. These commands read the value from the Wrangler prompt; never put a value on the command line and never capture prompt input or secret values in logs:

```powershell
corepack pnpm --filter @wukong/worker exec wrangler secret put QUEUE_INGRESS_SECRET --name <exact-worker-name>
corepack pnpm --filter @wukong/worker exec wrangler secret put OPENAI_API_KEY --name <exact-worker-name>
corepack pnpm --filter @wukong/worker exec wrangler secret put SHOPLINE_TOKEN_ENCRYPTION_KEY --name <exact-worker-name>
corepack pnpm --filter @wukong/worker exec wrangler secret put S3_ACCESS_KEY_ID --name <exact-worker-name>
corepack pnpm --filter @wukong/worker exec wrangler secret put S3_SECRET_ACCESS_KEY --name <exact-worker-name>
corepack pnpm --filter @wukong/worker exec wrangler secret list --name <exact-worker-name> --format json
node scripts/verify-cloudflare-secrets.mjs $deploymentEnvironment
corepack pnpm --filter @wukong/worker deploy:<preview-or-production>
```

The generated configuration omits Wrangler `keep_vars`. Each deployment replaces all approved plaintext variables and deletes arbitrary stale dashboard plaintext variables that are not rendered. The exact-name secret preflight protects the five encrypted secrets independently: checked-in metadata and generated Wrangler `secrets.required` list exactly those five names and no values. The verifier compares only names from `wrangler secret list --format json`; if any required name is missing or any unexpected secret name exists, abort the deployment. It never reads or prints values. The deploy script repeats this fail-closed verifier immediately before `wrangler deploy`.

Hyperdrive caching is disabled because tenant RLS, leases, and read-after-write state require fresh reads. The Worker database client has a maximum of five database connections and closes after every Queue batch. The Worker must never run migrations at startup.

Create two distinct bucket-scoped R2 credentials per environment and record only their names and scopes:

1. Vercel web upload/finalize credential: Object Read & Write for that environment's one private bucket. Store its `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` only in the matching Vercel environment scope.
2. Worker signed-read credential: Object Read-only for that same one bucket. Store its different `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` only as secrets on the matching Worker.

The credential values must never be reused or shared between Vercel and the Worker, and preview credentials must differ from production credentials. Using the same environment variable names in separate platform scopes is intentional; the underlying access keys remain distinct. Apply CORS only for the Vercel origin, required `PUT` and `HEAD` methods, and `Content-Type` header. Worker read-only S3 access is server-side and requires no CORS permission. Keep every bucket private and forbid wildcard CORS.

## Configuration boundaries

### Vercel variable allowlist

The Vercel preview or production scope may contain only the variables required by the web runtime:

- `DATABASE_URL`
- `AUTH_SECRET`
- `AUTH_SMTP_URL`
- `AUTH_EMAIL_FROM`
- `BETTER_AUTH_URL`
- `QUEUE_INGRESS_URL`
- `QUEUE_INGRESS_SECRET`
- `S3_BUCKET`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE`

Platform-provided `VERCEL_URL` and `VERCEL_PROJECT_PRODUCTION_URL` are allowed. Vercel must not receive a Cloudflare account token, `OPENAI_API_KEY`, `SHOPLINE_TOKEN_ENCRYPTION_KEY`, a raw SHOPLINE credential, a Hyperdrive connection string, `DATABASE_ADMIN_URL`, or any legacy queue variable.

### Worker variable allowlist

Bindings: `HYPERDRIVE`, `LISTING_QUEUE`, and `SHOPLINE_QUEUE`.

Secrets: `QUEUE_INGRESS_SECRET`, `OPENAI_API_KEY`, `SHOPLINE_TOKEN_ENCRYPTION_KEY`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`.

Non-secret variables: `BUILD_SHA`, `AI_PROVIDER`, `OPENAI_LISTING_MODEL`, `SHOPLINE_ADAPTER`, `SHOPLINE_PUBLISH_ENABLED`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, and `S3_FORCE_PATH_STYLE`.

The Worker must not receive `DATABASE_ADMIN_URL`, Better Auth or mail values, a raw SHOPLINE token, or a Cloudflare account API token as a runtime variable. Queue payloads contain database IDs only.

## Ingress-secret rotation

Because the current HMAC verifier accepts one key, rotate in a controlled window:

1. Confirm both Queues and DLQs are healthy and record their metrics.
2. Pause new web publishing without deleting already queued messages.
3. Generate the replacement in the approved secret manager; do not print it.
4. Replace the Worker `QUEUE_INGRESS_SECRET`, deploy, then replace the matching Vercel environment value and deploy the same accepted commit.
5. Send one synthetic signed request and verify enqueue plus consumption.
6. Verify a request signed with the retired key is rejected.
7. Resume publishing and revoke the retired value.

If either deployment fails, keep publishing paused, restore the previous matching value on both sides, and redeploy. Secret rotation never requires deleting Queue messages.

## Controlled migration and Opak seed

Use a controlled release environment that temporarily receives `DATABASE_ADMIN_URL`; neither Vercel nor the Worker receives it.

```powershell
corepack pnpm --filter @wukong/db... build
corepack pnpm --filter @wukong/db db:migrate
$env:OPAK_OPERATOR_EMAIL = "<approved-opak-admin-email>"
corepack pnpm --filter @wukong/db exec tsx src/seed-opak.ts
corepack pnpm --filter @wukong/db seed:shopline-connection
```

The controlled command runs `packages/db/src/seed-shopline-connection.ts`. The SHOPLINE seed reads one token line from stdin and prints only safe IDs/domain fields. Never pass the token as an argument or environment variable. Confirm the Opak seed is idempotent and record only safe output.

### Admin access is invite-only and single-operator

`auth_get_eligible_user` returns a user only when both a `users` row and a `workspace_invites` row with status `pending` or `accepted` exist for the address. This seed is the only thing that creates that pair; there is no runtime path to request access, despite what the `/register` heading suggests.

The seed is idempotent for the same address, but re-running it with a different `OPAK_OPERATOR_EMAIL` **renames the existing operator rather than adding one**. `upsertUser` conflicts on the fixed `OPAK_OPERATOR_ID` and overwrites the email, and `users.email` is `UNIQUE`. The previous address then fails the eligibility check, its `workspace_invites` row is left behind, and the existing credential and verified state stay attached to the renamed user. Treat a change of operator address as a replacement, not an addition.

Every rejection along these flows is deliberately generic, so an address that was never seeded is indistinguishable on the wire from one that succeeded. When sign-in appears to do nothing, read `auth_audit_events` before suspecting mail or configuration: `magic_link_rejected` and `password_enrollment_rejected` mean the address is not eligible, and the flow stopped before mail was ever attempted.

## Preview and production sequence

1. Require a clean-checkout gate for the exact commit.
2. Provision and configure the isolated preview resources.
3. Deploy Vercel preview and `wukong-runtime-preview` from the same commit with `SHOPLINE_ADAPTER=mock`.
4. Run the synthetic Opak Playwright story, exact-draft audit, tenant-isolation probe, Queue metrics, DLQ checks, Worker errors, Hyperdrive errors, and log secret scan.
5. Obtain production resource/deployment approval. Run the controlled migration and Opak seed once.
6. Deploy production from the accepted commit with `SHOPLINE_ADAPTER=disabled` and `SHOPLINE_PUBLISH_ENABLED=false`.
7. Repeat synthetic production acceptance without a real SHOPLINE write.
8. Stop. Obtain separate final confirmation before changing to real mode or enabling the first real SHOPLINE write.

Real mode additionally requires the encryption key and `SHOPLINE_PUBLISH_ENABLED=true`. Enable those only after the separate confirmation, start with one approved hidden product, record its safe remote ID, and immediately return to disabled mode if verification fails.

## Monitoring and DLQ replay

For every Queue and DLQ, record Queue backlog (`backlog_count`), backlog bytes, oldest message age derived from `oldest_message_timestamp_ms`, retries, DLQ depth, Worker errors, and Hyperdrive errors. Alert on any production DLQ message, sustained backlog growth, oldest age beyond the agreed processing SLO, Worker error spikes, or Hyperdrive connection errors.

DLQ replay is manual and reviewed:

1. Pause the affected primary Queue and record the DLQ depth.
2. Pull one DLQ message through a short-lived, least-privilege Cloudflare Queue administration session.
3. Validate the strict IDs-only payload against Neon and confirm the ledger state is retryable.
4. Send the same payload to its matching primary Queue.
5. Acknowledge the DLQ message only after the primary Queue accepts it.
6. Verify one lease claim and terminal ledger state, then repeat one message at a time.
7. Resume the primary Queue and revoke the temporary administration credential.

Never bulk-copy, purge, or blindly replay a DLQ. Preserve failed payloads until their Neon ledger state and root cause are understood.

## Hash-pinned formatting debt

The release formatter temporarily waives only the exact canonical LF content below. This is inherited formatter-only debt outside the Cloudflare operations task scope; lint, typecheck, tests, integration, and build still cover these files. A path change, content change, hash mismatch, or new unformatted file fails the gate. Remove each row and its checker entry when that file is deliberately formatted in a separately reviewed change.

| File                                                            | Expected SHA-256                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/web/app/api/assets/finalize/route.test.ts`                | `3abb816c52d65a7223313586b4ee6dd56da80abd43e5598a98ddda3b4d50845b` |
| `apps/web/app/api/assets/finalize/route.ts`                     | `5aaa692c0b800758e6e63012d8aca47bc31b517b4924244763f3256fa1c097b2` |
| `apps/web/app/api/assets/presign/route.ts`                      | `7adbcb02f097f202c849e229d9510f8c3a59059072aa81b55c0ad997c37388ea` |
| `apps/worker/src/listing-consumer.test.ts`                      | `004dcee5a589f459004489c538632cf202a225066922996be1e35b9b00fea41f` |
| `apps/worker/src/pipeline-test-support.ts`                      | `45d5ebc4ea37bf5ac927578e992974a8604068c147cf760d4d376cf6c080d7b1` |
| `packages/db/src/publish-jobs-schema.test.ts`                   | `8c0609853aa150a6d7fd532e41f387fb152462758d35f4d860a80685f932c5d8` |
| `packages/db/src/repositories/publish-jobs.integration.test.ts` | `60f109af4c944409f7cfe348c697299a3f34a83a008b1c3478581d43f6e36c7c` |
| `packages/jobs/src/cloudflare-queue.ts`                         | `1f17ed387564268afbdf82c4354a04d7e27b0525d0d2a5dfc613c925796f1b43` |

## Rollback

1. Set production to `SHOPLINE_ADAPTER=disabled` and `SHOPLINE_PUBLISH_ENABLED=false`.
2. Pause both production Queues; do not purge them.
3. Roll back `wukong-runtime-production` to the last compatible Worker deployment.
4. Roll back Vercel if the ingress contract changed.
5. Retain the primary queues, DLQs, private R2 buckets and objects, Neon ledgers, listings, audits, publish jobs, and pipeline runs.
6. Resume only after the accepted Worker/Vercel pair passes a synthetic request and ledger verification.

Never delete Queues, DLQs, R2, or Neon ledgers during rollback or incident response. Prefer pausing consumption over reversing an additive migration.
