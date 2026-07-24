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

After approval, create all four Queues and both DLQs for the selected environment before deploying its Worker. The checked-in generated Wrangler configuration attaches the consumer policies: batch size `1`, maximum retries `3`, retry delay `30`, concurrency `1`, and the matching DLQ.

```powershell
corepack pnpm --filter @wukong/worker exec wrangler queues create <exact-queue-name>
corepack pnpm --filter @wukong/worker exec wrangler r2 bucket create <exact-r2-bucket-name>
corepack pnpm --filter @wukong/worker exec wrangler hyperdrive create <exact-hyperdrive-name> --connection-string="$env:CONTROLLED_NEON_RUNTIME_URL" --caching-disabled
```

Run the Queue command once for each exact Queue and DLQ in the table. The Hyperdrive command must use the environment's runtime Neon role, never the admin URL. Capture its non-secret configuration ID as `CLOUDFLARE_HYPERDRIVE_ID`, render `.wrangler/wrangler.generated.jsonc`, inspect the exact bindings, then deploy the selected environment:

```powershell
$env:CLOUDFLARE_ENV = "<preview-or-production>"
$env:CLOUDFLARE_HYPERDRIVE_ID = "<configuration-id>"
node scripts/render-cloudflare-config.mjs
corepack pnpm --filter @wukong/worker deploy:<preview-or-production>
```

Hyperdrive caching is disabled because tenant RLS, leases, and read-after-write state require fresh reads. The Worker database client has a maximum of five database connections and closes after every Queue batch. The Worker must never run migrations at startup.

Create an R2 Object Read & Write credential restricted to the one environment bucket. Apply CORS only for that environment's Vercel origin plus the required `PUT` and `HEAD` methods and `Content-Type` header. Keep the bucket private.

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
| `apps/web/app/api/listings/route.create.test.ts`                | `175f467561747ea218d165278e1e57eb4023b50761f81898b3a0f4dc0461cbc0` |
| `apps/web/lib/listing-queue-runtime.ts`                         | `0140cf7c13dbc3dddd78e32fec238ff548e31b4a25b94558fd6d61c5f967ad68` |
| `apps/worker/src/listing-consumer.test.ts`                      | `e1b487bd64cfe877d416cdd270e731b42ad2a3dba17b2c52a89161c10e7d1035` |
| `apps/worker/src/pipeline-test-support.ts`                      | `f02b9b9d618c3d9d74ab50acc393d832f3f4ed1614f5c250568a91f36662b90b` |
| `packages/db/src/index.ts`                                      | `314a726462f7407f4a608104634e1a3e6945a63a0bb9ac18c85077d2f6a1dc2d` |
| `packages/db/src/publish-jobs-schema.test.ts`                   | `8c0609853aa150a6d7fd532e41f387fb152462758d35f4d860a80685f932c5d8` |
| `packages/db/src/repositories/publish-jobs.integration.test.ts` | `60f109af4c944409f7cfe348c697299a3f34a83a008b1c3478581d43f6e36c7c` |
| `packages/db/src/schema.ts`                                     | `21c8b510142bf891215df98175e1a168df6016a6a325b7a3b7a45457599034ee` |
| `packages/jobs/src/cloudflare-queue.ts`                         | `1f17ed387564268afbdf82c4354a04d7e27b0525d0d2a5dfc613c925796f1b43` |

## Rollback

1. Set production to `SHOPLINE_ADAPTER=disabled` and `SHOPLINE_PUBLISH_ENABLED=false`.
2. Pause both production Queues; do not purge them.
3. Roll back `wukong-runtime-production` to the last compatible Worker deployment.
4. Roll back Vercel if the ingress contract changed.
5. Retain the primary queues, DLQs, private R2 buckets and objects, Neon ledgers, listings, audits, publish jobs, and pipeline runs.
6. Resume only after the accepted Worker/Vercel pair passes a synthetic request and ledger verification.

Never delete Queues, DLQs, R2, or Neon ledgers during rollback or incident response. Prefer pausing consumption over reversing an additive migration.
