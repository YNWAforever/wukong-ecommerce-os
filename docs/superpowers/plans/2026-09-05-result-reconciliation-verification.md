# Task 5: Bulk Update delivery and operator result reconciliation

## Scope and base

Branch: codex/catalog-ops-result-reconciliation, isolated worktree worktrees/catalog-ops-result-reconciliation.
Verified GitHub main before editing: 8ac82cb4402ad7ac2af4313a20e0181710f04dc6, merged PR #73. The continuation plan pin 2acdd2c350116e2d5c1029a616c8199f67b0e5ea is an ancestor. Tasks 1–4 were reused; Task 6 onward is excluded. No push or deployment is part of this slice.

## Reproduced failures

- The old result contract accepted an attempt reference without an explicit reporting mode, exact exported version or idempotency key. Its same-workspace check did not establish included-manifest membership. The legacy request regression returned 201 before the change and now rejects the malformed contract; real PostgreSQL tests cover nonmembership, wrong version and foreign attempts separately.
- The jobs ledger treated an operator's acceptance report as SHOPLINE acceptance. Reports are now explicitly operator-reported and independently unverified.
- Real Chromium reproduced the existing batch helpers' native-fetch receiver error: dependency-object invocation threw Illegal invocation, while a standalone call succeeded. Both helper regressions failed before the focused fix and passed afterward.
- The initial Task 5 migration failed on replay with column mode already exists. Earlier migrations had regranted mutation privileges. Replay-safe DDL, revoked privileges and a persistent mutation guard now protect receipt history, including during a transient regrant.
- The existing tenant-FK integration invariant exposed a missing export-version FK index. The index and declared schema now agree.
- The synthetic browser completed import, attended Queue enrichment, editing, all confirmations and approval for two products, then failed at the missing catalog Bulk Update selector before UI implementation. A later browser regression reproduced the missing saved rejection explanation on Jobs reload; the final rerun passes.

- Final review reproduced failed or malformed no-attempt responses being presented as completed zero-row exports, and missing stable zero-row counts/version context. Five focused cases failed before the correction; all nine component tests pass afterward. HTTP errors remain errors, valid zero-row summaries retain the submitted manifest, and persisted attempt recovery remains intact.

## Implementation

Result recording binds to an included manifest listing and its immutable export version, with ready artifact and complete provenance requirements. Corrections append receipts linked to the observed predecessor. Exact retries replay the existing receipt without another audit event; conflicting payloads and stale corrections fail. Totals use included members and their complete relevant history, independently of the recent activity cap.

Explicit historical/manual reports remain unlinked and never contribute to export reconciliation. Listing reads expose their ordered manual correction history; legacy records are not promoted into trusted export or manual correction chains.

Reviewer selection persists across catalog pages. Freshness confirmation is tied to the selected IDs. Generation shows a stable attempt reference even if detail refresh fails, offers detail-only retry, and downloads only ready artifacts through the existing authorized endpoint. Imported products expose Bulk Update XLSX; unlinked Create CSV/API and created-link API update actions are labeled separately, while unknown link origins fail closed. Rejection and correction reasons remain visible after reload.

## Verification

All commands ran in the isolated Task 5 worktree with Node 24.18.0 and pinned pnpm 11.7.0. Prefix each pnpm command below with corepack.cmd pnpm@11.7.0.

| Command                                                                                                                         | Result                                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| test                                                                                                                            | 67 root Node tests plus 1,369 package tests passed; 14/14 Turbo tasks |
| test:integration                                                                                                                | 182 passed; one dedicated-migration placeholder skipped               |
| exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/import-result-migrations.integration.test.ts | 2/2 passed separately with dedicated migration URLs                   |
| build                                                                                                                           | 8/8 tasks passed, including local Worker dry-run bundling             |
| lint                                                                                                                            | 14/14 tasks passed                                                    |
| typecheck                                                                                                                       | 14/14 tasks passed                                                    |
| format:runtime:check                                                                                                            | Passed, no format-debt waiver                                         |
| runtime:forbidden:check                                                                                                         | Passed; zero forbidden dependencies, imports or services              |
| exec playwright test tests/e2e/bulk-update-pilot.spec.ts --workers=1 --output=node_modules/.task5-evidence/browser-acceptance   | 3/3 Chromium tests passed, 14.8 seconds                               |

The normal integration gate uses explicit TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for task5_integration on 127.0.0.1:55445. The destructive migration rehearsal uses separate TEST_MIGRATION_DATABASE_ADMIN_URL and TEST_MIGRATION_DATABASE_URL, requires loopback hosts and database task5_migration_review, and is intentionally skipped by the normal integration command. It proves fresh application, two full replays, retained receipts and append-only protection even during a simulated earlier privilege regrant.

Browser settings: PLAYWRIGHT_E2E=1, PLAYWRIGHT_BASE_URL=http://127.0.0.1:49245, explicit test URLs for task5_operational, local TLS S3 endpoint/bucket, and the generated local CA via NODE_EXTRA_CA_CERTS. The existing real-stack-server.mjs starts actual local Wrangler Queues and the built Next.js application.

The browser suite covers import time/retry and real viewer rejection; then two generated products go through import, attended batch and completion, fake AI Queue consumption, editing, all eight field and seven negative confirmations, approval, multi-product export and authorized download. It verifies downloaded SHA-256, leading-zero SKUs, changed Chinese names and neutral +0 quantity deltas. It records one accepted and one rejected operator outcome, reloads Jobs, and verifies exact counts and the rejection explanation. A correction is committed while its response is deliberately lost; retry returns the same receipt with replayed=true, two history revisions and no duplicate audit. All-accepted after correction still remains unverified. The workspace has four zero-cost fake AI runs and zero publish jobs.

Desktop and 375px mobile screenshots were inspected, with no horizontal document overflow. Local artifacts are under node_modules/.task5-evidence/browser-acceptance; logs are under node_modules/.task5-evidence. These generated artifacts and internal agent reports remain local.

Backend and UI scoped reviews are approved. The final whole-branch review found one UI P2; focused re-review approved its correction at c10db24. The full unit suite, build, lint, typecheck and three browser cases were rerun after that correction.

## Remaining source-binding limits

- Operator reports are assertions, not independent evidence of SHOPLINE application. Even all accepted rows remain unverified against a fresh SHOPLINE export.
- Merchant-side freshness/protected-field drift is still based on explicit attestation and the imported immutable snapshot. This slice does not independently inspect current merchant state.
- The historical manual mode cannot reconcile any attempt. Missing historical source or approval evidence still requires reimport and renewed approval; no legacy receipt is synthesized.
- Database/object-store publication remains a recoverable lifecycle rather than a cross-store transaction. Existing download hash/readiness checks remain authoritative.
- Migration 0017 has only been exercised in disposable local databases; production migration and operational rollout need a later authorized step.

## Safety and isolation

Only generated synthetic XLSX bytes were uploaded to the local runtime. PostgreSQL 17.11 on loopback port 55445 and native TLS MinIO on 9012 used task-owned data directories. Next.js and Wrangler ran locally on 49245 and 8787 with AI_PROVIDER=fake, SHOPLINE_ADAPTER=mock, SHOPLINE_PUBLISH_ENABLED=false. No real SHOPLINE writes, merchant seed, real workbook, paid provider or deployment was used.

Task-owned Next.js, Wrangler, MinIO and PostgreSQL services were stopped after final acceptance. The branch and local evidence remain available for review.
