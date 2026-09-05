# Task 4 - browser import contract verification

Date: 2026-09-05. Scope: continuation Task 4 only; stop for review.

## Baseline and isolation

GitHub main was fetched and checked before editing: 2acdd2c350116e2d5c1029a616c8199f67b0e5ea, exactly the continuation plan's pinned SHA. Branch codex/catalog-ops-import-contract is stacked on the completed local Task 3 commit 07c26e238b5c4c0691548305b15905e0a7b0c564, preserving Tasks 1-3 and the root checkout. Graph results routed discovery; active-checkout source was authoritative because the index describes the older root checkout.

## Reproduced failures

- The unchanged helper from HEAD, called with its original signature and a generated Default workbook with the 71-column header contract, emitted a request without filename or merchantAttestedExportAt. Forwarding that exact URL/body to createBulkFormImportHandler and the real XLSX readers returned HTTP 400 merchant_attested_export_at_missing; the importer was never called. The existing 32 focused tests had passed.
- Real Chromium additionally reproduced a native fetch receiver bug: deps.fetcher(...) throws TypeError, Failed to execute 'fetch' on 'Window': Illegal invocation. The form reported a network error and emitted no import request. A direct browser probe confirmed this independently. Destructuring fetcher before invocation fixes that receiver; the final real browser journey exercises the correction.

## Change

- File selection retains the workbook without uploading. A separate submit action requires the operator to enter SHOPLINE export time.
- The input explicitly labels Hong Kong UTC+08:00. Strict calendar parsing converts that wall time to an ISO UTC instant without consulting the host timezone, current time or file metadata. For example, 2026-01-01T00:15 becomes 2025-12-31T16:15:00.000Z.
- URLSearchParams encodes the exact file name and merchantAttestedExportAt. The body remains the original File, with no JSON or multipart wrapper.
- Missing/invalid time, workbook, connection, role and network failures surface through the existing status UI. File/time remain available for correction and retry. A synchronous in-flight guard blocks duplicate submissions.
- Added a real helper-to-route contract test using the actual workbook readers, plus mounted-component selection/retry/duplicate tests and strict HK calendar cases. Existing route tests remain unchanged and pass.
- Added tests/e2e/bulk-update-pilot.spec.ts using the existing real-stack fixture module, isolated synthetic identities, real password authentication and restricted database access. /listings/new and /listings/import remain separate.

## Checks

Commands used Node 24.18.0 and corepack.cmd pnpm@11.7.0 from this worktree.

| Command                                                                                                                                                                                 | Result                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| corepack.cmd pnpm@11.7.0 --filter @wukong/web exec vitest run components/bulk-import-panel.test.ts components/bulk-import-panel.contract.test.tsx app/api/listings/import/route.test.ts | 3 files, 40 passed                                                       |
| corepack.cmd pnpm@11.7.0 test                                                                                                                                                           | 67 root tests plus 1,327 package tests; 851 web tests; 14/14 Turbo tasks |
| corepack.cmd pnpm@11.7.0 lint                                                                                                                                                           | 14/14 tasks passed                                                       |
| corepack.cmd pnpm@11.7.0 typecheck                                                                                                                                                      | 14/14 tasks passed                                                       |
| corepack.cmd pnpm@11.7.0 build                                                                                                                                                          | 8/8 tasks passed; Next build and Worker dry-run only                     |
| corepack.cmd pnpm@11.7.0 runtime:forbidden:check                                                                                                                                        | Zero forbidden dependencies/imports/files/services                       |
| corepack.cmd pnpm@11.7.0 exec prettier --check on the seven Task 4 files                                                                                                                | Passed                                                                   |
| git diff --check                                                                                                                                                                        | Passed                                                                   |

Actual browser command:

    corepack.cmd pnpm@11.7.0 exec playwright test tests/e2e/bulk-update-pilot.spec.ts --project=chromium --workers=1 --reporter=line --output=node_modules/.task4-evidence/browser-results

Result: 2 passed (5.5s), PLAYWRIGHT_E2E=1. Next ran on 127.0.0.1:49244 against a fresh PostgreSQL 17.11 cluster on 127.0.0.1:55444, database task4_import_e2e. TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL explicitly targeted that cluster; the app used wukong_app, NOSUPERUSER/NOBYPASSRLS. AI_PROVIDER=fake, SHOPLINE_ADAPTER=mock and SHOPLINE_PUBLISH_ENABLED=false. Existing migrations ran only on this synthetic local database.

The operator journey verifies no request on selection/missing time, real 409 connection failure, aborted-network retry with retained inputs, actual 201 success, decoded Unicode/reserved-character filename, exact attested instant, persisted workbook SHA-256 and immutable source-row SKU 0001. Chromium does not expose File bytes through postDataBuffer, so the browser test compares the server-persisted digest against the generated original; the route contract test separately compares raw bytes. The second authenticated journey verifies actual 403 viewer denial. Desktop and 375px screenshots were inspected; no horizontal overflow after layout settles and zero page errors in the import journey. Parser warnings for omitted trailing blank cells and absent category are shown, not suppressed. Only synthetic workbook content was used.

## Verification limits and remaining risks

- The initial default format:runtime:check against main found formatting debt in the Task 3 report, docs/superpowers/plans/2026-09-05-source-binding-verification.md. The scoped Task 4 gate passed for seven files with RELEASE_BASE_SHA=07c26e238b5c4c0691548305b15905e0a7b0c564. After the user authorized publishing Tasks 1-4 as one PR, publication preparation formatted that report without changing its content and rechecked the complete branch against main.
- The local dev bundler failed before import testing because development package exports resolve source .js siblings that are absent. Browser evidence therefore uses a successful production build and next start. No runtime/package configuration was changed to mask that baseline issue.
- Docker's Linux daemon was unavailable. The browser test used a separate native local PostgreSQL cluster with the retained Task 3 binaries. MinIO, Mailpit, Worker/Queue and the full cross-service E2E/integration suites were not exercised by this slice. Combined E2E runs must retain --workers=1 because older fixtures globally reset auth records.
- The timestamp is an operator attestation, not independent proof of when SHOPLINE exported the workbook or that merchant-side protected fields remain current. Existing immutable source/approval/artifact binding remains in force. Cell-type fidelity, stock-delta acceptance, delivery/result reconciliation and actual SHOPLINE acceptance remain later tasks/UAT gates.
- Full localization and broader visual/accessibility work remain Task 7. No Task 5 implementation, production migration, deployment, push, merchant seeding, real workbook upload, paid-provider use or real SHOPLINE write was performed.

The Task 4 branch and worktree remain local for review. Task-owned app/database processes are stopped after verification; ignored synthetic evidence remains local.
