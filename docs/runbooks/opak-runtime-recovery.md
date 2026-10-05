# Opak listing read recovery: evidence and release gate

Observed 2026-10-01. This pack covers T00-T02. It does not certify production recovery or authorize a migration, release, or SHOPLINE write.

## Confirmed failure mechanism

The current `getReviewSnapshot` projection reads `listing_versions.source_import_id` and `source_row_digest`. Detail GET calls it directly; queue GET calls it through source readiness for each row. Production catalog inspection found both columns and their workspace/source foreign key absent. A read-only, zero-row projection (`WHERE false`) fails with SQLSTATE `42703` before any customer content is returned. The two originally observed records exist and have existing active versions; no customer content or record IDs are included here.

On a task-owned synthetic Postgres 17 database, removing just these two columns reproduces both GET failures. Diagnostic stages are `listing` for detail and `sources` for queue, with safe code `schema_unavailable`. Applying the repository's existing `0046_listing_version_source_binding.sql` restores both healthy GETs to 200. Version counts and sorted content digests remain unchanged. Older versions retain null source binding and still require a fresh review before source confirmation. No guessed digest or backfill was written.

This establishes a reproducible schema failure mechanism. Historical production errors had only minified call sites, and a fresh authenticated production GET has not been captured. Additional production issues may remain. PR #120 is open and does not by itself repair this missing schema.

## Safe read-only preflight

Run against an already authorized environment with its existing runtime database URL; do not paste credentials into a command or logs:

```powershell
pnpm --filter @wukong/db db:listing-read-preflight
```

The CLI reads PostgreSQL catalog/privilege metadata only. `ready:true` requires the two nullable, no-default columns, the validated workspace/source foreign key, forced RLS, application SELECT privilege, a non-superuser/non-bypass `wukong_app` role, and that safe role as the effective connection user. A missing capability or failed catalog read exits nonzero. It performs no migration, data read, provider call, or write. Production metadata inspection reports the three source-binding capabilities missing; the three named-role/RLS capabilities pass. Actual web connection identity still needs the runtime-credential preflight at release; connector admin metadata is not that proof.

Every instrumented read returns a generated UUID in `x-request-id`; failures also include `requestId` in the response. Server diagnostics contain only that ID, an allowlisted stage/code, and validated deployment metadata. Logs never contain original messages, SQL, tenant values, prompts or provider output. Staff copy the displayed support ID and record the action/time, then retry once after support confirms recovery.

## Local acceptance

- Disposable DB `opak_fixes_20261001`: actual runtime role and forced RLS; three healthy rows, one malformed row, and one manual draft without a version. Seven integration cases cover malformed isolation, manual editability, foreign-workspace rejection, whole-request permission errors, rejection of actual admin credentials by preflight, and actual missing-column repair without content changes. The suite requires explicit `WUKONG_OPAK_INTEGRATION=1` and guarded loopback URLs pointing at an `opak_fixes_` database. Normal integration skips this destructive suite; CI provisions and tests its dedicated `opak_fixes_ci` database in a separate step.
- Separate disposable browser DB `opak_fixes_browser_20261001`: production build, Better Auth, operator/reviewer, fake AI and mock SHOPLINE. Two browser cases cover queue, healthy/malformed/no-version detail, disabled blocked actions, support IDs, no listing writes, no page errors, and 375px overflow checks.
- Classified activity data failures preserve saved content with an explicit unavailable section. Signed image-preview failures preserve source identity with an explicit preview warning. DB failures in those stages remain 500. Unknown critical source readiness blocks approval/delivery.
- Screenshots contain synthetic values only and stay in ignored `node_modules/.opak-evidence/`. The merchant evidence archive remains outside the repository.

Development-mode browser startup exposed a pre-existing Turbopack package-resolution failure; browser acceptance therefore uses the compiled production server. No assertion was removed to obtain a pass.

## Concrete production gate

1. Obtain explicit authorization for the reviewed DB repair and release; confirm target database/branch and current preflight again. Keep real SHOPLINE publishing disabled. Do not apply every unapplied migration speculatively.
2. Apply the existing additive `0046_listing_version_source_binding.sql` with the authorized migration mechanism and admin role. First verify its referenced source table/unique key and inspect any conflicting constraint. Use a bounded transaction/lock timeout. Record aggregate before/after counts and digests privately; no customer IDs/content in public evidence.
3. Require the catalog preflight to pass. Recheck RLS and runtime role without widening grants or policies. Do not populate old versions with invented bindings.
4. Release the compatible web artifact and verify its commit/deployment. Record worker deployment/version separately using `deployments status`, not the first chronological history entry. The 2026-10-02 provider refresh identifies current `BUILD_SHA` and failed configured runtime-role/cache gates; see [cloud read-only refresh](./opak-cloud-readonly-refresh-2026-10-02.md). Runtime `BUILD_SHA` or Vercel commit metadata may supply validated diagnostics; no new provider secret is required.
5. Through authorized operator/reviewer sessions, read the two original affected details and queue once; record HTTP status, support ID, stage, and any new failure. Check manual save/review with approved test records. A clean unit/build result cannot replace this gate.
6. Only then record production read recovery. Independent maintenance and first real SHOPLINE write gates remain in force.

## Configuration and rollback

No new migration was authored. Existing repair: `0046_listing_version_source_binding.sql`. Existing runtime names: `DATABASE_URL`, `BUILD_SHA`, `VERCEL_GIT_COMMIT_SHA`, `VERCEL_DEPLOYMENT_ID`; the runtime manifest now declares the diagnostic metadata (Vercel-provided names must not be set by hand). Local integration uses `TEST_DATABASE_ADMIN_URL`, `TEST_DATABASE_URL`, `DATABASE_MIGRATIONS_DIR`, and opt-in `WUKONG_OPAK_INTEGRATION`. Browser acceptance additionally uses `PLAYWRIGHT_BASE_URL` and opt-in `WUKONG_OPAK_E2E`. All local provider adapters remain fake/mock with publishing disabled.

Rollback code or approved feature gates if necessary; retain additive columns/index/foreign key and all immutable sources, versions, audits, queue/DLQ records, cost reservations and completed external results. Stop new enqueue only through approved controls and reconcile work already accepted. Never down-migrate by dropping these columns in production. The missing-column regression performs destructive DDL solely inside its explicitly guarded, task-owned local test DB.
