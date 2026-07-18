# Production AI runtime runbook

This runbook activates the private listing worker without provisioning resources or exposing credentials. Complete preview acceptance before production, keep Neon authoritative, and stop before the first real SHOPLINE write until separately approved.

## Cost decision

Prices were checked against the official pages on 2026-07-19 and must be rechecked immediately before provisioning.

- Use Upstash Fixed 250MB at $10/month. Upstash warns that BullMQ polls Redis while idle, so its pay-as-you-go command billing can create avoidable cost; Fixed has no per-command billing.
- Railway Hobby currently has a $5/month minimum commitment with $5 of included usage. Usage above the included amount is billed separately.
- Cloudflare R2 Standard begins with 10 GB-month of storage, 1 million Class A operations, 10 million Class B operations, and egress within its published monthly free tier.

If a provider displays a materially higher price, stop before creating the resource and obtain approval for the revised spend.

## Resource names

| Owner         | Resource                   | Required name                            |
| ------------- | -------------------------- | ---------------------------------------- |
| Cloudflare R2 | Private Standard bucket    | `wukong-opak-prod-assets`                |
| Upstash       | Fixed 250MB Redis database | `wukong-listing-queue-prod`              |
| Railway       | Project                    | `wukong-ecommerce-os`                    |
| Railway       | Private worker service     | `listing-worker`                         |
| Vercel        | Production application     | `https://wukong-ecommerce-os.vercel.app` |

Keep the R2 bucket private and scope its API token to Object Read & Write on this bucket only. Use the TLS `rediss://` Upstash endpoint. Deploy Railway from the repository root, in Singapore, with one replica and no public domain.

## R2 CORS policy

Apply this policy to `wukong-opak-prod-assets`:

```json
[
  {
    "AllowedOrigins": [
      "https://wukong-ecommerce-os.vercel.app",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Add the one selected Vercel preview deployment origin immediately before preview browser acceptance. Remove that origin after the preview is retired. Do not add wildcard origins, methods, or headers.

## Variable ownership

Enter sensitive values only through provider dashboards or approved CLI stdin flows. Never paste values into Git, tickets, terminal output, deployment notes, or chat.

### Neon

- `DATABASE_URL` is the pooled runtime connection. Vercel retains its existing production copy and Railway receives a worker-runtime copy.
- `DATABASE_ADMIN_URL` is a release-only variable for the controlled migration environment. It must not be stored on the Railway worker or used by worker startup.
- Neon is the system of record. Redis state is transport state and R2 contains source objects; neither replaces persisted listing state.

### Cloudflare R2

R2 owns the values for these six S3 variables. Copy the same scoped values into the Vercel and Railway runtime environments:

- `S3_BUCKET`
- `S3_ENDPOINT`
- `S3_REGION` with the safe fixed value `auto`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE` with the safe fixed value `false`

### Upstash

Upstash owns `REDIS_URL`. Use the TLS endpoint in both Vercel and Railway so the publisher and worker share the `listing-pipeline` queue.

### Vercel

For this AI-runtime increment, add exactly this allowlist to the applicable preview or production scope:

- `REDIS_URL`
- `S3_BUCKET`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE`

Vercel must not receive `OPENAI_API_KEY`. Existing authentication, mail, Neon, encryption, and SHOPLINE configuration remains owned by the web runtime and is not copied to Railway.

### Railway

The `listing-worker` service allowlist is exactly:

- `DATABASE_URL`
- `REDIS_URL`
- `S3_BUCKET`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE`
- `AI_PROVIDER` with the safe fixed value `openai`
- `OPENAI_API_KEY`
- `OPENAI_LISTING_MODEL` with the safe fixed value `gpt-5.6-terra`

Do not store `DATABASE_ADMIN_URL`, `AUTH_SECRET`, `AUTH_SMTP_URL`, Resend/auth-mail variables, or any `SHOPLINE_*` secret on Railway. Missing access to `gpt-5.6-terra` blocks deployment; do not silently substitute a model.

## Migration and deployment order

1. Verify the branch and exact commit passed the repository gate. Record that commit for both Vercel and Railway.
2. Recheck provider prices, resource privacy, the R2 bucket-scoped token, the TLS Redis endpoint, model access, and the variable allowlists. Do not print values.
3. For preview, add the branch-scoped Vercel allowlist and Railway allowlist, deploy the same commit, add the selected preview origin to R2 CORS, and complete synthetic browser acceptance. Remove the origin when that preview is retired.
4. After the accepted commit is merged and required checks are green, add the same allowlists to production. Keep the new Railway worker stopped until the controlled migration succeeds.
5. In the controlled release environment only, provide both Neon runtime and admin URLs, then run:

   ```powershell
   pnpm.cmd --filter @wukong/db build
   pnpm.cmd --filter @wukong/db db:migrate
   ```

6. Confirm the migration succeeds once. Railway startup must not run a migration: `railway.json` intentionally has no pre-deploy command.
7. Deploy Vercel production and the private Railway worker from the same accepted commit. Railway must use the repository root, Railpack, `pnpm --filter @wukong/worker start:production`, restart on failure with at most 10 retries, and 30 seconds of draining.
8. Do not configure a Railway healthcheck path. This is a private, portless worker; startup and deployment-specific logs are its first operational signal.
9. Run the non-destructive Opak workflow through review and CSV export. Do not perform a real SHOPLINE product write without separate confirmation.

Record the commit, Vercel deployment ID, Railway deployment ID, regions, non-secret resource names, migration timestamp, acceptance timestamp, and observed monthly commitments in the handoff.

## Verification

Use the exact deployment IDs and a narrow time range for every check; do not rely on historical grouped logs.

1. Confirm Vercel and Railway show the same accepted source commit. Railway must show configuration sourced from `railway.json`, one private replica, no generated domain, and no pre-deploy migration.
2. In the Vercel deployment logs, find `listing.enqueue_accepted` for the synthetic listing. Record only its deployment ID, workspace ID, draft ID, job ID, and timestamp. `listing.enqueue_failed` is acceptable only during the deliberate outage-recovery exercise and must use `queue_unavailable`.
3. In the Railway deployment logs, find the exact startup line `listing worker started`. Confirm there is no restart loop, missing-variable error, migration command, or public listener.
4. Correlate job consumption using the Vercel job ID, the Railway deployment time window, and Neon transitions `received -> processing -> in_review` or `needs_info`. If the pipeline terminates, only the safe codes `provider_timeout`, `provider_failure`, or `pipeline_failure` may be retained; raw provider errors are forbidden.
5. Confirm Neon contains the expected pipeline run, evidence, AI metadata, active version, and terminal listing state. Confirm one canonical BullMQ job ID exists and R2 objects remain under the expected workspace prefix.
6. Scan the exact Vercel and Railway deployment logs for credential values, `rediss://`, signed R2 query parameters, raw prompts, uploaded content, and full model output. Any match blocks acceptance and requires credential revocation/rotation through the owning provider.
7. Verify the browser upload preflight allows `PUT` with `Content-Type` from production and the selected preview origin only. Verify the bucket remains private.
8. Complete the retry drill: with the deliberate Redis outage, creation remains HTTP 201 and `received` with `processing.state=retry_required`; after restoration, the retry returns HTTP 202, creates exactly one job, and reaches a reviewable state without re-uploading assets.

## Rollback

1. Roll Vercel back to the last known-good deployment.
2. Roll Railway back to the compatible worker deployment, or stop `listing-worker` if continued consumption is unsafe.
3. Retain the Upstash Redis queue and all Neon records. Queued work can resume when a compatible worker returns, and Neon remains authoritative.
4. Never delete `wukong-opak-prod-assets` during incident response. Preserve R2 objects and their Neon metadata for recovery and audit.
5. Do not reverse an additive migration until its compatibility and data-loss impact have been reviewed. A worker stop is safer than an improvised database rollback.
6. Revoke only the affected provider credential when compromise is suspected; do not rotate unrelated secrets. Remove retired preview CORS origins.
7. Record the incident window, deployment IDs, safe error codes, queue depth, affected listing IDs, and recovery evidence without recording secret values or customer content.

## Official references

- [BullMQ with Upstash Redis](https://upstash.com/docs/redis/integrations/bullmq)
- [Upstash Redis pricing](https://upstash.com/pricing/redis)
- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Cloudflare R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Railway pricing](https://docs.railway.com/pricing)
- [Railway config as code](https://docs.railway.com/config-as-code/reference)
- [Railway monorepo deployments](https://docs.railway.com/deployments/monorepo)
- [Vercel environment CLI](https://vercel.com/docs/cli/env)
