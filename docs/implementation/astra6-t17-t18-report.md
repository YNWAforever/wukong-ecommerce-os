# Astra 6 T17/T18 exact batch integration report

> Integration update: this file records its original implementation slice. Parent wiring, final fixes and combined checks are recorded in [the consolidated delivery evidence](astra6-delivery-evidence.md). Earlier pending sibling-work notes below are historical.

## Implemented

- Migration `0034_enrichment_batch_exact_runs.sql` binds each enrichment batch item to one immutable pipeline run and input revision, records a bounded outcome, and retains its admitted reservation.
- `bindRun` serializes admission on the batch row and compares PostgreSQL `numeric` reservation totals against the batch cap. A rejected reservation rolls back the newly accepted operation and outbox, then the service marks the batch `budget_exhausted`.
- Batch Advance uses `acceptListingOperation`, so every admitted item uses the same immutable input snapshot, provider registry, workspace reservation, and durable outbox path as a single listing operation.
- Reconciliation follows the item's exact pipeline run. A later listing status cannot rewrite a failed item as successful.
- Batch spend uses settled reservation cost, retains held/unknown reservation cost, and falls back to physical calls only for a run without a reservation.
- Physical invocation start metadata now retains the exact prompt version. Reservation settlement is idempotent for duplicate terminal delivery and keeps unknown holds.

## Local evidence

Disposable database:

`T01_REHEARSAL_DATABASE_ADMIN_URL=postgres://wukong:wukong@localhost:54329/t01_compatibility`

No database was dropped and no paid provider call was made.

- `pnpm --filter @wukong/db exec vitest run src/repositories/ai-runs.integration.test.ts src/repositories/enrichment-batch-exact-runs.integration.test.ts`: 2 files, 8 tests passed.
- The database scenarios cover invocation claim conflict, finalize idempotency, prompt-version persistence, duplicate terminal settlement, unknown reservation retention, migration replay preserving pending nullable cost, concurrent batch cap admission, and concurrent double Advance with a stale failed listing status.
- `pnpm --filter @wukong/web exec vitest run lib/enrichment-batch-service.test.ts`: 1 file, 34 tests passed.
- `pnpm --filter @wukong/db typecheck` passed before a concurrent core export refactor; the final rerun was temporarily blocked by missing `WorkspacePolicy` from `@wukong/core` while that refactor was in progress.
- `pnpm --filter @wukong/web typecheck` was temporarily blocked by missing `LISTING_PROMPT_VERSIONS` during the same concurrent core refactor.

## Remaining release gates

- Rerun repository typechecks and the full suite after the core export refactor settles.
- Rehearse the final 0034 migration from a fresh database as part of the combined migration sequence. The existing disposable database had already recorded an earlier development copy of 0034, so the focused test adds the final additive column when reusing that fixture.
- Keep paid providers disabled until the parent runtime pin and live credential gates are explicitly approved.
