# Bulk approval parity - Task 2 verification

Date: 2026-09-05 (Asia/Hong_Kong). Scope: Task 2 following the user's continuation; stop again for review. Task 3 is not implemented.

## Baseline and preservation

- GitHub main was verified through fetch and git ls-remote before work and refreshed during verification: 2acdd2c350116e2d5c1029a616c8199f67b0e5ea, matching the continuation plan's pinned SHA.
- Task 0/1 remains intact at 8a7a806e7658bca899fd31e4e4175df491427696 on codex/catalog-ops-export-eligibility. This follow-up is a separate stacked worktree, worktrees/catalog-ops-bulk-approval, branch codex/catalog-ops-bulk-approval, based on that commit. No push, merge or deployment was requested or performed.
- Read current CLAUDE.md, CONTEXT.md and continuation Task 2. Used codebase-memory-mcp for discovery and checked active-checkout source, including the shared approval boundary, both routes, queue collection/UI and source-link repository/worker behavior.
- Root checkout, prior review branch, existing worktrees and unrelated untracked files remain preserved. No package, lockfile, SQL migration, runtime or provider configuration changes.
- Node v24.18.0 and pinned pnpm 11.7.0 through corepack.cmd. Dependencies installed with --frozen-lockfile --prefer-offline in this worktree. Workspace library prerequisites built locally (6/6 cached tasks).

## Reproduced failures

- Unchanged approval baseline: 23 tests passed across bulk and single approval routes.
- Three new legacy-request regressions failed: ID-only approval returned HTTP 200 for missing confirmations, changed confirmations and refreshed imported source. The route intentionally omitted all shared-service version/checklist/source opt-ins.
- UI/read-model regressions failed before implementation: 21 failures / 14 passes. The queue sent only IDs, cleared failed selections after mixed results, exposed selection without review context, and collection responses lacked observed review context.
- Review found UUID duplicate comparison was case-sensitive. A mixed-case UUID regression returned 200 instead of 400 before normalization.
- Four source-origin regressions reproduced two approvals instead of one valid neighbor: missing link, overwritten import origin, ledger-only import binding and request-only import binding. Four collection regressions likewise exposed created-origin context after losing an imported link.

## Change

- Bulk requests now carry items with listingId, expectedVersionId, confirmationLedgerRevision and import-only expectedSourceImportId/expectedRowDigest. Legacy ID-only clients receive a typed review_context_required error before opening transactions. Empty/oversized batches, malformed context and duplicate UUIDs are rejected.
- approveOne requires the observed version and ledger revision at its type and runtime boundary. It verifies the active/draft version pairing, complete field/negative confirmations, exact revision, applicable current source and source binding on the checklist. It never fills missing client values from the newest server state.
- Source applicability is checked for every caller. Request or ledger import binding cannot be discarded merely because the current link is missing or now created-origin. The existing publisher can restore an earlier link snapshot after concurrent import; this slice refuses approval of that inconsistent review state without changing the worker.
- Single approval keeps its request shape and asset workflow. Matching source/origin checks run during its early read before product-shot I/O and again inside the shared approval transaction. Valid created-origin approval and product-shot version promotion remain covered.
- Each bulk item retains its own server-session workspace transaction and existing domain/state-machine/audit path. A failed item rolls back independently and cannot undo a successful neighbor. Unexpected errors return a safe public message without internal diagnostics.
- Collection GET emits nullable review context only for eligible, fully confirmed rows. Import values come from the ledger and must match the current link; missing/stale/misbound context stays unavailable. Revision zero is preserved as valid.
- Queue selections retain the context captured at selection. Successful IDs clear; failures stay selected through automatic reload with their original version/revision/source. Explicit reselection may adopt refreshed context. Existing request-level/network error feedback and malformed-response fallback remain covered.

## Executed checks

All commands below ran from this worktree with pinned corepack.cmd pnpm@11.7.0. Full unit/build runs explicitly used AI_PROVIDER=fake, SHOPLINE_ADAPTER=mock and SHOPLINE_PUBLISH_ENABLED=false. Approval/collection tests inject synthetic repositories and transaction fakes; UI tests use synthetic fetch responses.

- Focused command: corepack.cmd pnpm@11.7.0 --filter @wukong/web exec vitest run app/api/listings/bulk-approve/route.test.ts app/api/listings/[id]/approve/route.test.ts components/queue-client.test.tsx app/api/listings/route.list.test.ts components/listing-queue.test.tsx components/dashboard-listings-client.test.ts. Result: 6 files, 113 tests passed.
- corepack.cmd pnpm@11.7.0 test: passed, 67 root checks and 14/14 Turbo tasks; web 97 files / 789 tests. Unchanged package task results were reused by Turbo; web tests ran on the final code.
- corepack.cmd pnpm@11.7.0 lint: passed, 14/14 Turbo tasks.
- corepack.cmd pnpm@11.7.0 typecheck: passed, 14/14 Turbo tasks.
- corepack.cmd pnpm@11.7.0 build: passed, 8/8 Turbo tasks, including final Next.js compile and TypeScript validation. Existing middleware-to-proxy deprecation remains unchanged.
- corepack.cmd pnpm@11.7.0 runtime:forbidden:check: passed, 9 manifests / 216 source files, zero forbidden dependencies/imports/runtime files.
- corepack.cmd pnpm@11.7.0 exec prettier --check on all 15 changed files: passed.
- corepack.cmd pnpm@11.7.0 format:runtime:check with RELEASE_BASE_SHA=8a7a806e7658bca899fd31e4e4175df491427696: passed, 15 files checked, zero format-debt waivers.
- git diff --check and git diff --cached --check: passed.

A separate backend review found no unresolved actionable findings after the duplicate and source-origin fixes. The UI/read-model slice received its own scoped regression verification. Reviewers did not establish real database transaction behavior.

## Remaining risks and unexecuted gates

1. No durable approved-version/source/confirmation receipt exists. The current checklist/source match is checked at approval, but later confirmation or source changes are not bound to an immutable approval receipt. Task 3 remains a release gate, including the source/artifact-binding risks recorded for Task 0/1.
2. Source/checklist rows use ordinary transaction reads, with no lock or predicate through the final approval update for those rows. Same-version edits after the checks can still race approval. Synthetic transaction tests establish orchestration and partial failure behavior, not PostgreSQL isolation or RLS.
3. The publisher/import concurrency path can overwrite imported link origin using an older publisher snapshot. Approval now refuses contradictory import context; the underlying worker race is not fixed here.
4. Collection enrichment adds at most two reads per eligible row under the existing 100-row cap. Batched repository reads and real database latency have not been evaluated in this slice.
5. Docker Desktop's Linux engine pipe is unavailable. No Postgres/MinIO/Mailpit stack was started. test:integration, full-stack Playwright/Worker acceptance, browser journey checks and stage-level audit:verify were not run. These remain separate environment/release gates.
6. Tests used no merchant workbook or merchant data. No paid provider, real SHOPLINE write, production migration, seed, upload or deployment occurred. This is a local review slice, not merchant rollout readiness.
