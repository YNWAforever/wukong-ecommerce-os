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
