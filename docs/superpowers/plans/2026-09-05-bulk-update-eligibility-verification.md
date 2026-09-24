# Bulk Update export eligibility — Task 0/1 verification

Date: 2026-09-05 (Asia/Hong_Kong). Scope: first corrective slice only; stop for review.

## Baseline and preservation

- GitHub main was verified by git ls-remote and fetch before editing and refreshed before handoff: 2acdd2c350116e2d5c1029a616c8199f67b0e5ea, exactly the continuation plan's pinned SHA. No newer changes needed reconciliation.
- Branch: codex/catalog-ops-export-eligibility. Worktree: worktrees/catalog-ops-export-eligibility, created directly from origin/main.
- Read current CLAUDE.md, CONTEXT.md, continuation Tasks 0/1, workspace/package/CI configuration, and accepted Bulk Form Export/Freshness specs. Used codebase-memory-mcp for discovery; verified material source in this worktree because indexed snippets were stale.
- Root checkout, existing worktrees, untracked continuation plan and unrelated directories were preserved. No dependency or lockfile changes. No merged August/September packages were restarted.
- Node v24.18.0. Initial pnpm.cmd resolved to 11.19.0; pinned pnpm 11.7.0 was available through corepack.cmd pnpm@11.7.0 and used for final focused/build/unit checks.

## Reproduced failures

The unchanged baseline export suites passed 29/29 tests after building workspace library prerequisites. New behavioral tests then failed against the existing implementation:

1. An in_review listing with valid synthetic imported source exported one XLSX row instead of zero.
2. Approved content with an open blocking flag exported one row instead of zero.
3. Approved content with no confirmation ledger exported one row instead of zero.

All three reproduced through the real POST /api/listings/export handler with injected synthetic repositories and an in-memory object store. Single-item Bulk Update also returned a workbook without confirmations or explicit freshness attestation; both new tests failed before its implementation changed.

Review additionally found and reproduced final-read races: the freshness helper observed changed status/flags/link identity but discarded parts of those values; confirmations could be revoked during freshness reads. Four policy regressions failed before those gaps were closed.

## Change

- One shared Bulk Update eligibility policy requires approved/published status, the same active version, no open blocking flags, all eight field and seven negative confirmations belonging to that listing/version, valid import origin, matching confirmation/source metadata, explicit attestation, and the existing source/digest/header checks.
- Both single-item Bulk Update and multi-export use the existing workbook builder through the shared service. Create CSV/API policy and approval routes remain unchanged.
- The production adapter reads all authorization inputs through workspace-scoped repositories. It rejects inconsistent draft/active-version snapshots rather than pairing an older status with newer content.
- Request-local evidence captures version, confirmation revision, source import/digest and remote product/connection identity. Multi-export prepares bytes, then rechecks evidence in a fresh workspace transaction before ensure/audit. Object upload remains after commit, preserving the existing audit-failure rollback behavior. Single export rechecks before its audit/response boundary.
- Mixed requests retain every exclusion and write only eligible changed rows. All-excluded/all-no-op requests return rowCount 0 and exportAttemptId null, without an attempt, object or successful export event. An eligibility change at the final boundary rejects the request with a typed 409.
- Manifest outcomes participate in request identity so later blocked selections do not collide with earlier included selections. JSON manifest TypeScript unions were extended; no SQL schema change or migration is needed.
- Single bulk_form API callers must explicitly send freshnessAttested: true. Missing listings preserve 404; existing listings without an active version require approval. UI delivery wiring is outside this slice.

## Checks

All commands run from this worktree. Fake AI/mock SHOPLINE and SHOPLINE_PUBLISH_ENABLED=false were explicitly set for full unit/build runs. Tests use synthetic data and injected services; no merchant workbook was read or uploaded.

| Command                                                                                                                                                                                                                                                                                                                                             | Result                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| pnpm.cmd --filter @wukong/web exec vitest run lib/bulk-export-service.test.ts app/api/listings/export/route.test.ts (baseline)                                                                                                                                                                                                                      | 29 passed before new regressions                                               |
| Same export route suite with the three new refusal tests before implementation                                                                                                                                                                                                                                                                      | 3 expected failures: received rowCount 1 instead of 0                          |
| corepack.cmd pnpm@11.7.0 --filter @wukong/web exec vitest run lib/bulk-update-eligibility.test.ts lib/bulk-export-service.test.ts app/api/listings/export/route.test.ts lib/delivery-service.review-fix.test.ts app/api/listings/[id]/deliver/route.test.ts app/api/listings/[id]/approve/route.test.ts app/api/listings/bulk-approve/route.test.ts | 146 passed on the final code                                                   |
| pnpm.cmd lint                                                                                                                                                                                                                                                                                                                                       | Passed, 14/14 Turbo tasks                                                      |
| pnpm.cmd typecheck                                                                                                                                                                                                                                                                                                                                  | Passed, 14/14 Turbo tasks                                                      |
| corepack.cmd pnpm@11.7.0 test                                                                                                                                                                                                                                                                                                                       | Passed: 67 root checks and 14/14 Turbo tasks; web 97 files / 730 tests         |
| corepack.cmd pnpm@11.7.0 build                                                                                                                                                                                                                                                                                                                      | Passed: 8/8 Turbo tasks; final Next.js compilation and TypeScript check passed |
| corepack.cmd pnpm@11.7.0 format:runtime:check, RELEASE_BASE_SHA set to pinned main                                                                                                                                                                                                                                                                  | Passed against pinned main: 14 changed files checked, zero waivers             |
| corepack.cmd pnpm@11.7.0 runtime:forbidden:check                                                                                                                                                                                                                                                                                                    | Passed: 9 manifests, zero forbidden dependencies/imports/runtime files         |
| git diff --cached --check                                                                                                                                                                                                                                                                                                                           | Passed                                                                         |

Coverage includes actual XLSX membership, every required confirmation key, warnings/resolved flags, changed active version/status/flags, revoked or revised ledger, source/digest/remote/connection/origin/header drift at the final transaction, repeat export bytes, changed selection membership, zero-row requests, and preservation of single approval/create delivery behavior.

A separate final code/spec reviewer found no actionable Task 0/1 defects and rechecked the last missing/no-version adjustment. Review did not independently rerun the supplied test evidence.

## Environment and unexecuted checks

- The Windows sandbox helper failed before launching the initial shell (apply deny-read ACLs); approved elevated shell operations were used for this authorized local work.
- Docker CLI exists but the Docker Desktop Linux engine pipe is absent. Postgres/MinIO/TLS/Mailpit and the isolated real-stack fixture were not started.
- pnpm.cmd test:integration, full-stack Playwright/Worker Queue acceptance, browser journey verification and stage-level audit:verify were **not run**. Unit tests with synthetic repositories do not establish database RLS or live transaction isolation behavior.
- Next.js build reports the existing middleware-to-proxy deprecation warning. No runtime/framework migration was attempted.

## Remaining source-binding and rollout risks

1. There is no durable approved-version/source/confirmation receipt. Current approved/published status plus active version and current confirmations are checked; this cannot prove which source or ledger revision was approved. Reconfirming a changed import cannot manufacture that missing receipt. Task 3 remains a pilot release gate.
2. The policy trusts stored source digests and row associations. Source snapshots remain mutable; source-changing retries are not bound to an immutable source digest/artifact hash in persisted export identity. A repeat may overwrite the same object with different source bytes despite unchanged version/membership. Only identical synthetic retry bytes were verified here.
3. Boundary rechecks do not make Postgres and object storage atomic. Existing attempt/audit commit precedes upload; a failed upload may leave a successful creation audit and an unavailable object. Changes after the last database checks and previously downloaded artifacts are not revoked atomically. Readiness/hash/recovery/download semantics remain Task 3 work.
4. Parser round-trip and membership tests are not independent typed-workbook fidelity or SHOPLINE acceptance. Protected-field fidelity and merchant validation remain later gates.
5. Bulk approval parity (Task 2), durable receipts (Task 3), import metadata/UI delivery actions and attended acceptance were not implemented. Production schema/Worker/deployment alignment and merchant UAT remain unverified.

No deployment, production migration, merchant seeding, paid-provider use, real workbook upload or real SHOPLINE write occurred. This slice is ready for code review, not merchant rollout. Continue later tasks only on request.
