# Production listing intake incident — 2026-09-16

## Confirmed observations (read-only)

- Production Vercel deployment `dpl_FfG3vxf46JF7zhgmmb8JmXikLxhQ` serves merged commit `f309e55b46059d307cd7bc712056a3bce3630fba`. Its source tree matches tested commit `6533647`.
- At 03:32 UTC, `/api/assets/presign` and `/api/assets/finalize` returned 201; `/api/listings` subsequently returned 503. The same sequence occurred at 03:31 UTC.
- The reported message is emitted by `requireListingRecovery` when database recovery compatibility fails. Creation is blocked before dispatch.
- Neon project `weathered-lake-51694428`, branch `br-twilight-meadow-at9qky4q`, database `neondb` contains the listing ID seen in the production request logs. Catalog queries confirm that `listing_input_revisions`, `listing_dispatch_outbox`, and `ai_budget_reservations` are absent. The checked recovery columns on listing drafts and enrichment batches are also absent.
- Production Worker `wukong-runtime-production` still runs version `104d48d8-efbf-4bed-bb3b-c71c4ba750e4` from 2026-09-07, with a pre-recovery BUILD_SHA. Hyperdrive binding: `eef464f2d3c0480b94d22eaca060b209`. Existing provider/model are openai/gpt-5.6-terra; SHOPLINE writes are disabled.

## Diagnosis

The merged frontend/API was automatically deployed without the separately gated database and Worker release. Upload succeeded, but the new API correctly refuses to admit operations into an incompatible schema. Removing the readiness check would replace a controlled 503 with broken writes. The stale consumer also needs upgrading before new immutable operations are admitted.

## Concrete repair scope, pending production authorization

1. Reconfirm the named Neon branch and Hyperdrive target. Rehearse the checked-in migrations through 0040 on an isolated production-like branch; inspect compatibility and retained-record integrity before applying to production. Earlier fresh/drifted local rehearsals passed; production-clone rehearsal has not yet run.
2. Apply the reviewed repository migrations through 0040 using the controlled migration process. The new recovery additions are 0023–0040. The existing runner replays the full ordered migration set in per-file transactions, so review that replay against the production clone; do not perform ad hoc table creation or bypass RLS.
3. Deploy the matching Worker source from merged commit f309e55, preserving existing bindings, provider/model and secrets and keeping SHOPLINE publication disabled. Coordinate this with schema activation so the new producer does not send work to the old consumer. Inspect existing queued/in-flight work; do not blindly replay historical paid operations.
4. Verify all recovery compatibility capabilities as the runtime role, web/Worker version agreement, and signed health. Then verify manual draft save and the uploaded-photo journey with explicitly scoped canary authorization. A paid AI canary and merchant acceptance remain separate from source/health verification.
5. Retain the current uploaded asset. The UI retry message indicates it reuses finalized assets while the page state remains available; no re-upload is needed merely to repair the schema.

## Boundaries and evidence

No production database mutation, Worker deployment, credential change, paid AI request or SHOPLINE write was performed during this investigation. Existing CI passed both browser suites and audit verification on 6533647; that does not certify production rollout.

Automatic approval review rejected exporting all decrypted Vercel production environment variables because the command would unnecessarily expose credentials. No such export ran. Investigation continued using environment-key metadata, Vercel request logs, and read-only Neon catalog queries. Any needed credential use must be narrowly scoped and must not print or persist the entire environment.

## Authorized production repair outcome — 2026-09-16 04:05 UTC

The user explicitly approved production migrations, Worker deployment and one photo AI verification.

- Created isolated Neon rehearsal branch `br-proud-smoke-atewisu1` from production. Full replay exposed a pre-existing ownership issue in migration 0021 (`lookup_published_product_image` is owned by its dedicated lookup role). Applied only the missing, reviewed 0023–0040 migrations; all 18 succeeded. Runtime-role recovery compatibility returned `ready: true`, with no missing capabilities. Counts stayed 10 listings, 0 versions, 14 assets and 10 runs.
- Applied the same 0023–0040 set to production. Runtime-role compatibility again returned `ready: true` with no missing capabilities.
- Deployed Worker version `a2f1df93-a5f7-4adf-80d8-41f66b72b10b`, source SHA `7339a7633614ada75856f16c3162e907e23fb23b`. Public health confirms the SHA, OpenAI provider and resolved bindings. SHOPLINE and product-shot generation remain disabled.
- Existing Hyperdrive binding was preserved. Its older owner-role connection and enabled caching were observed. Automatic review rejected changing it with credentials in a command-line argument; no such change ran. Least-privilege/caching remediation remains outstanding.
- Configured only Opak with the reviewed GPT-4o policy and an initial single-run conservative budget of USD 1.443840. No persistent Vercel paid-operation flag was enabled: automatic review requires separate authorization for ongoing paid traffic; a USD 10 workspace cap was proposed to the user and remains unanswered.
- Used one earlier unclaimed uploaded photo for the authorized canary, preserving the newest uploaded asset. Canary listing: `704fbace-3eff-48e3-ac6f-0a7bd30c3c3d`; immutable run: `b21b20a5-981f-4a1a-8207-34cedac7a7d9`. The bounded maintenance harness used the real database admission service and Cloudflare Queue, not a browser-authenticated HTTP request. Queue acceptance succeeded.
- The provider rejected extraction with HTTP 401, allowlisted provider code `invalid_api_key`, category `missing_configuration`. No successful generation or review version exists. Usage/cost remain unknown in the durable ledger; no automatic retry was attempted.

The original missing-schema condition is repaired. The end-to-end photo-to-review goal is **not complete**: replace the invalid Worker `OPENAI_API_KEY`, settle the ongoing paid-admission authorization, then retry and verify. The key must be entered through the provider/Cloudflare secret interface, never chat, Git or logs. Signed ingress health and browser acceptance also remain unverified; public health and direct Queue acceptance do not substitute for them.
