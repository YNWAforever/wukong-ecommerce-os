# Isolated staging Worker health — 2026-10-02

This records partial cloud verification under the existing synthetic staging authorization: fake AI, mock SHOPLINE, zero paid AI calls, US$5 maximum cloud cost, production unchanged. It does not release merchant operations. The preceding [staging preparation](./opak-staging-rehearsal-2026-10-02.md) remains a dated receipt.

## Exact candidate and completed behavior

Reviewed application/source ce4cfc9e4888811082b092412444797b1f9fc759 had [full CI36956816510 SUCCESS](https://github.com/YNWAforever/wukong-ecommerce-os/actions/runs/36956816510). Dedicated codex/opak-isolated-staging-20261002 at6d8f8ff54517aa048313faf252abe3d7b154361b differs only in apps/web/vercel.json, disabling automatic Git deployments for that branch. No app, test or migration source changed in this phase. New documentation-head CI is separate.

| Surface            | Observed result                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker             | wukong-runtime-preview, version575c6814-179e-4a5d-816b-5529b2c3e871, deployment0113ccce-35dc-49bd-8f1c-d37b78b14079,100% active                                                    |
| Runtime source     | BUILD_SHA6d8f8ff; fetch/queue/scheduled handlers; Hyperdrive and both Queue bindings                                                                                               |
| Providers          | AI_PROVIDER=fake, SHOPLINE_ADAPTER=mock, SHOPLINE_PUBLISH_ENABLED=false, LISTING_PAID_OPERATIONS_ENABLED=false, PRODUCT_SHOT_PROVIDER=disabled, WINE_ENRICHMENT_ENABLED=false      |
| Exact secret names | OPENAI_API_KEY, QUEUE_INGRESS_SECRET, SHOPLINE_TOKEN_ENCRYPTION_KEY, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY; user values preserved and not read                                    |
| HTTP health        | GET200 matching source/provider/bindings; unsigned POST401; invalid HMAC401; checked-in signer POST200 with authenticated=true, hyperdriveConnects=true, listingRecoveryReady=true |
| DB runtime         | opak_stage/wukong_app; NOSUPERUSER/NOBYPASSRLS; owns0 public tables;69 public tables,59 RLS,all59 FORCE; own-visible1/foreign-visible0                                             |
| Final hold         | Both normal Queue pause commands exit0; empty cron/disabled public triggers apply exit0; fresh public HEAD404; Neon endpoint disabled/idle,min=max0.25CU                           |

## Commands and retained findings

The source was clean, switched to the staging branch and checked against the reviewed app source. The normal gated command ran doctor, renderer and exact-secret checks before upload:

```powershell
pnpm --filter @wukong/worker deploy:preview
node scripts/runtime-doctor.mjs preview --pre-deploy
node scripts/verify-cloudflare-secrets.mjs preview
```

Pre-deploy auth/four Queues/Hyperdrive/five Secrets all passed. The ordinary deployment passed after correcting the private runner. Same-version health checks used the checked-in signHealthProbe function; the direct runtime role/tenant check was read-only. Normal Wrangler deployments status and versions view independently confirmed the active version and safe bindings.

| Finding                         | Classification and action                                                                                                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global CLOUDFLARE_ENV collision | Reproduced private runner error. Wrangler interpreted preview as its environment and sought wukong-runtime-preview-preview. Removed it from CLI child environments; the package renderer still sets preview in its own process. No application change or secret workaround. |
| First request404                | Actual deployment succeeded; immediate request404 is retained. Bounded polling on the same version subsequently returned200 with matching BUILD_SHA. No unique edge propagation mechanism claimed.                                                                          |
| Signed request401               | Private probe incorrectly emitted hex. Reused the checked-in base64url signer; correct HMAC200, invalid/unsigned401. No Worker authorization change.                                                                                                                        |
| Independent read28000           | Direct DB read raced disabled compute. Repeated inside the bounded window passed identity/RLS checks. No password or permission-fault inference.                                                                                                                            |

Failed attempts, raw logs and private synthetic fixtures remain outside Git. No acceptance assertion was removed. Application upload occurred once; later checks only activated the same version ingress briefly. Final successful verification/stop window82seconds.

## Limits and next gates

Health does not access R2 or execute Queue jobs. Worker R2 read-only permission and bucket scope remain unverified; no inference from Secret names. Vercel has15 branch-specific preparation fields; S3_ACCESS_KEY_ID has no modification timestamp, while S3_SECRET_ACCESS_KEY was updated. Values are Sensitive and were not read. Web staging is not deployed.

Safe SMTP mock is unidentified. Final Web auth origin, runtime Web-to-Worker agreement, exact-origin R2 CORS, authenticated upload/detail/queue/current-content/approval/export/reconcile, Queue/DLQ/error metrics and scoped audit are outstanding. No cloud UAT or production500 root cause is claimed. Production migration/role/cache/deployment, paid human AI assessment, first real SHOPLINE write and merchant5→20→100 remain separate gates.

The current normal CLI acknowledges trigger/Queue changes, but has not provided an independent remote cron GET or delivery-paused flag. Queue info confirms attached producer/consumer only; final HEAD404 proves the public entry is closed. Keep these remote readbacks unknown until available through normal provider tooling; do not extract OAuth credentials.

## Stop, resume and rollback

The controlled outside-repo stop config fixes the preview Worker/account with workers_dev=false, preview_urls=false and triggers.crons=[]. Normal operations were:

```powershell
wrangler queues pause-delivery wukong-listing-preview
wrangler queues pause-delivery wukong-shopline-preview
wrangler triggers deploy --config <outside-repo-stop-config>
neonctl api /projects/small-fire-41282929/endpoints/ep-hidden-meadow-b8gvbtoo -X PATCH -F endpoint.disabled=true
```

Fresh endpoint and public-origin readback confirm disabled/idle and404. Preserve Queue/DLQ messages, immutable sources, versions, reservations, receipts, audit and database. No purge, resource deletion or down migration. Resume only within existing authorization after prerequisites and budget/stop checks; any accepted or unknown external result must be reconciled before new admission.

Paid AI calls, Queue submissions, R2 operations, outgoing emails and production changes were0 in this phase. Billing is unmeasured; US$5 is the authorization cap. Safe supplementary evidence contains counts/hashes/metadata and excludes secret values, .env, raw logs, customer content, prompts and model output.
