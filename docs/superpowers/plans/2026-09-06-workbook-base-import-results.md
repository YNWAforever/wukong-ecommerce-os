# Workbook base import verification

Status: implemented and verified locally on 2026-09-06. Source review is approved, and all final gates passed. No production rollout is included.

## Result and reproduced failure

An operator now chooses a supported SHOPLINE XLSX, gets an automatic preview, and clicks **Import N products** to save every eligible row. No SHOPLINE account, connection, store URL, export-time confirmation, catalog name or mapping input is required. The existing connected update flow remains available in a collapsed section.

Source base: GitHub main `49e84a3b21c9d384dd5b6f1019441322931fbb48`, verified against the remote before editing. Work is isolated on `codex/workbook-base-import` in the existing `attempt-evidence-packet` worktree. Runtime implementation was reviewed through `69a44eb`; the final test setup correction is `57f7e0f`.

The original filename-only state came from `BulkImportPanel` disabling submission until `ImportStoreSetupPanel` reported a SHOPLINE connection and import capability. The connected importer independently rejects a missing connection with `409 shopline_connection_missing`, and its route requires a merchant export timestamp. Earlier read-only investigation found no connection in the reported workspace and no matching upload request in the inspected logs. The existing setup/importer suites reproduced those restrictions and passed 26 tests before and after this slice.

## Implemented boundaries

- Reuses the supported 71-column SHOPLINE contract, 4 MiB upload cap and 5,000 data-row cap. The declared Default worksheet is resolved through its internal workbook relationship; missing or ambiguous Default sheets fail safely.
- Preview parses bounded original bytes without persistence writes. It reports complete eligible/excluded counts and at most 20 eligible products. Save reparses the retained file, checks its byte/header digests and imports all eligible rows atomically.
- Identical bytes in one workspace return the original result without duplicate products or audit events. Changed bytes create a separate source; titles, SKUs, filenames and unbound remote IDs never merge sources.
- Migration `0020_workbook_catalog.sql` adds immutable workbook sources/products with FORCE RLS, tenant-composite constraints, locked operator membership checks and product-to-source row digests using canonical PostgreSQL JSONB. Evidence is bounded to 16 MiB per source and 1 MiB per product.
- Excluded rows, including variants, remain in normalized source evidence with visible reasons/counts. Normalized text is not a promise to preserve original XLSX formatting, cell types or bytes. Variants are not newly supported catalog products.
- Filename dates are optional unverified local text with unknown timezone. Missing or malformed dates do not block a valid workbook. Inference never becomes a merchant timestamp or freshness attestation.
- Workbook records have catalog search/filter/pagination and escaped-text detail views. They create no connection, platform link, listing draft or automatic AI job and carry no review/export/publication authority.

The UI retains the selected File across tab switches and recoverable errors, ignores stale responses, and distinguishes preview/save retries. Import and its completion counts/catalog link sit above the sample rows; optional issue details open automatically when no products are eligible. Website remains the initial tab.

Browser inspection reproduced mobile document overflow and compressed table columns. Zero-minimum grid tracks/items fix page sizing, while a bounded, keyboard-accessible horizontal table scroller keeps all six columns readable. Actual cell values, arrow-key scrolling, complete button bounds and center hit targets were checked. A normal small vertical scroll can be needed from the chooser to Import on a phone; users do not need to scroll through the 20 preview rows. At 375 x 1000, one 240px wheel scroll made the action usable in both locales. Desktop needed no extra scroll.

## Verification

All commands use `corepack.cmd pnpm@11.7.0` on Windows. Tests use synthetic files and isolated localhost PostgreSQL, TLS object storage, mail, application and worker services. No supplied merchant workbook was read or uploaded for testing.

| Check                                          | Result                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Original connection/setup and importer suites  | 26 passed                                                                                                                             |
| Projection and complete SHOPLINE suite         | 7 focused / 255 package tests passed                                                                                                  |
| New workbook parser, preview and save routes   | 24 passed, including actual reordered/missing/duplicate Default XLSX and save-source binding                                          |
| Workbook database integration                  | 9 passed: replay, RLS, immutable row binding, rollback and actual JSONB limits                                                        |
| UI and catalog                                 | 94 initial UI/API cases, 7 actual-source integration cases; final import component 22 mounted cases passed                            |
| Final root `pnpm test`                         | **2,048 passed**: 1,980 Vitest tests plus 68 root checks; 14/14 Turbo tasks                                                           |
| Final root `pnpm typecheck` and `pnpm lint`    | Both passed 14/14 Turbo tasks; repository lint is TypeScript checking                                                                 |
| Final root `pnpm build`                        | Passed 8/8 tasks with synthetic local settings                                                                                        |
| Complete `pnpm test:integration`               | **244 passed, 3 existing gated skips**; 33 passed files and 2 skipped files; no workbook tests skipped                                |
| Final workbook browser rerun                   | **6/6 passed** on the corrected worksheet reader; both locales at 375/1440px, source refusal, all-row save, retry and replay          |
| Existing browser regressions                   | **10 passed / 2 intentional skips**, plus **4 connected-import cases passed** in the earlier applicable runtime run                   |
| Independent reviews                            | Projection, storage, UI and whole branch approved; worksheet mismatch finding fixed and re-reviewed; final test setup change approved |
| Runtime formatting and forbidden-runtime gates | Passed: 42 format files, 0 waived debt; 9 manifests / 275 runtime files, 0 forbidden dependencies, imports or files/services          |

The final browser evidence totals **20 passed / 2 intentional skips across separate commands**, not one combined run. The two skips are the separate invited-admin authentication mode while real-stack mode is enabled, and POSIX process-group cleanup on Windows. The listing pilot audit checks passed: no missing actions, no accessible foreign records/tables, extract and generate AI run tasks recorded, and `passed: true`.

The three integration skips require separately configured import-result or fresh-export migration-rehearsal database URLs. No workbook test is skipped. One existing export-verification replay fixture initially failed with `export_verification_binding_mismatch` before replay began; its unchanged isolated suite passed 9/9 and the complete rerun passed 244 tests. The exact transient cause was not conclusively reproduced, and no export chronology or source policy was relaxed.

## Review findings resolved

A regression demonstrated that an extra product could be appended to an immutable source. The final SQL insert guard binds every product to its exact eligible source-row digest. Actual near-limit database tests also exposed JSONB whitespace overhead and constraint names; oversize evidence now returns a safe 413 with complete rollback.

Whole-branch review reproduced a valid workbook with Default pointing to sheet2 and Archive to sheet1 being labelled Default while importing ARCHIVE-PRODUCT. Commit `69a44eb` replaces the new service's two independent legacy readers with the existing relationship-bound Default reader and a matching source name. Three actual-XLSX RED cases proved wrong selection and acceptance of missing/duplicate Default sheets. Final route tests reject ambiguity without saving and prove CURRENT-PRODUCT plus source Default reach persistence together. This is a justified correction to the plan's original reader choice; the connected importer and existing SHOPLINE helpers remain unchanged.

The first full root run of these new regressions timed out while importing production route modules inside a five-second test body. Commit `57f7e0f` moves imports to module setup, matching neighboring route suites. Assertions and the default timeout are unchanged; the complete root rerun passed.

## Exact commands and local evidence

```powershell
corepack.cmd pnpm@11.7.0 test
corepack.cmd pnpm@11.7.0 typecheck
corepack.cmd pnpm@11.7.0 lint

. .superpowers/sdd/workbook-integration-env.ps1
corepack.cmd pnpm@11.7.0 test:integration

. .superpowers/sdd/workbook-browser-env.ps1
corepack.cmd pnpm@11.7.0 build
corepack.cmd pnpm@11.7.0 exec playwright test tests/e2e/workbook-import.spec.ts --workers=1 --retries=0 --output=node_modules/.workbook-evidence/playwright-bound
corepack.cmd pnpm@11.7.0 exec playwright test tests/admin-password-auth.e2e.spec.ts tests/e2e/catalog-usability-checks.spec.ts tests/e2e/catalog-usability.spec.ts tests/e2e/listing-pilot.spec.ts tests/e2e/real-stack-boundary.spec.ts tests/e2e/website-import.spec.ts --workers=1 --retries=0 --output=node_modules/.workbook-evidence/playwright-regressions

$env:RELEASE_BASE_SHA = '49e84a3b21c9d384dd5b6f1019441322931fbb48'
corepack.cmd pnpm@11.7.0 format:runtime:check
corepack.cmd pnpm@11.7.0 runtime:forbidden:check
git diff --check
```

Local ignored logs under `.superpowers/sdd/`:

- `workbook-release-unit.log`, `workbook-release-typecheck.log`, `workbook-release-lint.log`: final root gates at `57f7e0f`.
- `workbook-bound-build.log`: final runtime build; `workbook-final-integration-rerun.log`: complete integration rerun; `workbook-export-replay-recheck.log`: unchanged isolated replay suite.
- `workbook-task-4-browser-bound.log`: final six workbook cases, exit 0; `workbook-task-4-browser-regressions.log`: ten passed/two skipped, exit 0.
- `workbook-task-4-browser-final.log`: four connected cases passed on `eb189bb` in a combined run with the new spec. That command exited 1 because a new-spec copy locator was stale; the corrected new spec subsequently passed. Later changes are confined to the new workbook flow and its tests, so the connected evidence remains applicable. No single twenty-case successful command is claimed.
- `workbook-runtime-format.log` and `workbook-runtime-forbidden.log`: final branch formatting and runtime preservation gates.
- `workbook-task-1-report.md` through `workbook-task-4-report.md`: detailed RED/GREEN and original commands, including the connected run.

Synthetic PNGs and action geometry are retained in ignored `node_modules/.workbook-evidence/`: preview, catalog and detail for `en`/`zh-Hant` at widths `375`/`1440`; separate action, table and horizontally scrolled views; and before/after mobile button/nav bounds. Generated browser reports were moved into `final-playwright-report` and `final-test-results` in that directory.

## Remaining source-binding limits and rollout prerequisite

A workbook does not verify store ownership, remote product identity, merchant-side freshness or publishing permission. Filename timestamps never populate merchant attestations. Base records have no export authority or automatic AI jobs. Changed files remain separate sources and are not reconciled by title, SKU, filename or unbound remote ID. Excluded variants remain evidence until a later explicitly designed feature supports them.

Migration 0020 was applied only to isolated synthetic databases. It must be reviewed and applied before deploying code whose catalog queries reference the new tables. Production migration, deployment, provider activation, real workbook upload and SHOPLINE writes require a later authorized rollout. This branch has not been pushed or merged.

All owned synthetic services were stopped after verification. No listeners remain on PostgreSQL 55445, object storage 9012/9013, mail 8026/1026, web 49217, callback 49219 or worker 8787. Synthetic data and local evidence are preserved. The shared fixture was confirmed byte-for-byte equal after Git normalization and its stat-only change refreshed. Production and unrelated local work remain unchanged.
