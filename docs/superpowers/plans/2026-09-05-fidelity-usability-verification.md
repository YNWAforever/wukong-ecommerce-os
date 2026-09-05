# Tasks 6 and 7: workbook fidelity and catalog usability

## Baseline and scope

Local branch: codex/catalog-fidelity-usability, preserving Task 5 at 72655a1 on codex/catalog-ops-result-reconciliation. GitHub main was verified as 8ac82cb4402ad7ac2af4313a20e0181710f04dc6 before this slice; the continuation pin 2acdd2c350116e2d5c1029a616c8199f67b0e5ea is an ancestor. The existing linked checkout and dependency/runtime versions were retained. Tasks 6 and 7 are authorized for local development only.

## Task 6 evidence

Commits 617f4fe and 196e05b add an independent output comparison over all 71 fields: eight permitted content changes, ten locked identity fields, 51 pass-through fields and two neutral stock deltas. The synthetic fixture writer and independent ZIP/XML comparison are test-owned; the output oracle does not reuse the production reader.

The tests distinguish normalized string-grid preservation from typed/raw Excel fidelity. Numeric lexical strings and leading zeros are exercised; original numeric cell types/styles and whitespace-only raw cells are not preserved. Missing required identifiers and variants are refused. The extra nonblank English-header regression failed before the narrow matcher correction. Optional Chinese-header recognition also rejects an extra nonblank cell; blank trailing formatting cells remain tolerated. Generated workbooks name their sheet Default.

Blank normalized delta cells remain blank; nonblank deltas become +0. Merchant acceptance of blank versus +0 is still unverified. The updated runbooks retain the pre-change source, exact delivered workbook and digests, and require current protected-field comparison plus explicit authorization before restoration. A stale whole-row reimport is not automatically safe.

Verification: 151 shopline tests and package typecheck passed. The whole unit suite passed with 67 root tests plus 1,387 package tests (1,454 total). After helper consolidation, the focused workbook/fidelity suites passed 37 tests and typecheck/format checks passed. Independent scoped review approved Task 6 after removing a duplicate synthetic ZIP helper. These are synthetic source checks, not real merchant UAT.

## Task 7 reproduced failure

On the pre-Task-7 built UI, a synthetic authenticated catalog search for 0002 received an injected HTTP 503. The application showed its load error and removed the search controls, with no Retry action. The real Chromium regression failed specifically because Retry was absent. Its alert locator is scoped to main content to exclude Next.js's route announcer. On built cf6f1f6, the same Chromium journey passed: Retry returned HTTP 200, cleared the alert, retained search 0002 and showed the matching row (1 test, 4.6 seconds).

## Task 7 coverage evidence

Task 7A (36020e6) adds workspace-scoped count/page queries for catalog, listings and all five Jobs ledger sources. Catalog filtering no longer truncates at 5,000 rows; quality scans active versions in bounded batches instead of stopping at 100. API responses disclose scope, missing/unassessable versions and quality scan start/end times. Jobs separates all-history ledger scope from the 30-day metrics window. Catalog and Jobs counts and page IDs share a SQL statement snapshot. Listings page IDs and totalMatching share a statement snapshot, while workspace status totals are observed by a separate countByStatus query and may reflect concurrent transitions independently. Subsequent detail hydration and advisory readiness may also observe concurrent changes.

Real PostgreSQL boundary tests cover 5,007 catalog products, 137 listings, 274 mixed ledger rows with equal timestamps and cross-kind IDs, 131 assessed plus six missing versions, historical cost and foreign-workspace isolation under the non-superuser RLS role. The full isolated integration gate passed 188 tests across 26 files; one dedicated migration-test placeholder was skipped. No migration was added in Tasks 6/7.

Task 7B adds retry/error clearing and guarded reads, server paging controls, retained selection contexts, complete source provenance and stable export-attempt inspection. The recovery review reproduced six failures before fixes. Complete web tests passed 910 tests at cf6f1f6; the final imperative-refresh race was separately reproduced (false success when a newer poll superseded a failed action refresh) and fixed at 8709870. Its 21 detail tests and typecheck passed, and independent re-review approved all recovery findings.

## Task 7 common-page locale and browser evidence

Task 7C1 (ca5f3a5, 8d5db8f) reuses the existing en/zh-Hant cookie through a shared provider and server page resolution. It adds HK date/number formatting, localized read-page controls/errors/reasons, tenant-neutral metadata, and one implementation-maturity registry. The drawer restores focus and makes surrounding content inert; the skip link targets focusable main content. Independent review corrected Jobs machine/display timestamps and approval-specific error remedies.

The initial common-page matrix passed on empty data. Strengthening it with a synthetic imported product exposed mobile catalog overflow: document width 842px at a 375px viewport, caused by a positioned hidden table-header label escaping its scroll container. The corrected named, keyboard-focusable scroll region contains the document while retaining access to all columns. The populated rerun passed both browser tests in 12.5 seconds: real source import IDs on catalog/dashboard, locale toggle and reload persistence, both locales at 1440px/375px, skip links, drawer focus trap/Escape/return, reduced-motion mode, and keyboard horizontal table scrolling. Synthetic screenshots were inspected; reference parity remains unverified.

C1 checks: 925 web tests, typecheck and 40-file formatting passed; correction regressions reproduced four failures before 33 focused tests passed, with typecheck/format and independent re-review approval. Build passed eight tasks. Nested export/result widgets and detail-page localization are owned by the next slice and were not claimed complete by these common-page checks.

## Task 7 detail and delivery acceptance

Task 7C2 (5f3d9ac, 7f4f173) localizes detail/processing, content fields, source evidence, checklist, compliance, delivery, activity and nested export/manual-result forms. It preserves merchant content, result reasons and exact evidence IDs; API errors use safe localized explanations with associated form controls. Independent review corrected selected-locale success messages, activity machine timestamps and duplicated report wording. Six regressions reproduced those corrections; 48 focused tests, typecheck and formatting passed. The preceding full web gate passed 939 tests.

On built 7f4f173, all five Chromium tests passed in 29.6 seconds. The attended synthetic journey imports, advances fake-AI batches, edits/reviews/approves, downloads the exact two-product XLSX, verifies artifact digest/SKUs/neutral quantity, records mixed operator reports, loses a committed correction response, and retries with the same key. The real handler returns the original correction with exactly two history rows. Database assertions retain three result audit records, zero publish jobs, and four fake AI runs at zero cost. Operator acceptance remains unverified.

The same run checks populated Jobs and approved-detail views in both locales at 1440px/375px, selected-locale correction controls, plus the received/no-active-version detail state. Common-page recovery, source IDs, locale persistence, keyboard navigation, reduced-motion mode and overflow checks pass. Full-page screenshots are local synthetic evidence; mobile result-history layout was inspected.

## Task 7 retained-evidence metric contract

Task 7D (f65f0af) was separately reviewed and approved. The contract is documented in [review-quality-metric-contract](2026-09-05-review-quality-metric-contract.md). A trailing 30-day half-open cohort supplies full SQL version-approval aggregates and creation-to-first-approval elapsed time, using one evidence statement/MVCC snapshot. The separate gap/cost scan retains its observed interval. Approval fraction counts versions, not review decisions, and is right-censored at the request clock; elapsed time is not reviewer effort.

Recorded edit field-change fraction measures NFC-normalized field Hamming distance across exactly eight permitted fields in qualified immutable version pairs. Only complete, nonempty content pairs qualify. Empty/missing/malformed/oversized content and invalid actor/sequence/time joins are excluded and disclosed. Over 1,000 edit events makes the entire edit metric and edit exclusion counts unavailable; no partial sampled fraction is emitted. Missing evidence returns null rather than invented zero values. No AI-output baseline or independently verified human provenance is claimed.

The final attended browser fixture independently verified two approved versions out of four retained versions (0.5), two changed fields out of sixteen measured fields (0.125), and two versions in the elapsed-time denominator. A received draft with no versions/edit evidence returned null values, zero denominators and no_qualified_evidence for all three metrics. Populated quality UI was checked in both locales/sizes, including visual inspection of its Traditional Chinese mobile presentation.

## Combined checks

All commands ran in the active linked checkout with Node 24.18.0 and corepack pnpm 11.7.0. Integration and browser URLs pointed only at the separately named task67 local databases and synthetic artifact bucket.

| Check              | Exact command                                                                                                                     | Result                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Unit regression    | corepack.cmd pnpm@11.7.0 test                                                                                                     | 67 root + 1,459 package = 1,526 tests passed; web 956. Turbo 14 tasks passed.                                                 |
| Integration        | corepack.cmd pnpm@11.7.0 test:integration                                                                                         | 191 passed, one dedicated migration-test placeholder skipped; 27 passing files, 67.41 seconds. No new migration in Tasks 6/7. |
| Build              | corepack.cmd pnpm@11.7.0 build                                                                                                    | 8 tasks passed, 26.622 seconds.                                                                                               |
| Lint/types         | corepack.cmd pnpm@11.7.0 exec turbo run lint typecheck                                                                            | 22 tasks passed, including dependency builds. Repository lint is TypeScript checking.                                         |
| Browser            | corepack.cmd pnpm@11.7.0 exec playwright test tests/e2e/bulk-update-pilot.spec.ts tests/e2e/catalog-usability.spec.ts --workers=1 | 5 Chromium tests passed, 34.0 seconds. Both locales, 1440px/375px; populated and received states; metric assertions.          |
| Runtime formatting | corepack.cmd pnpm@11.7.0 format:runtime:check                                                                                     | 128 files passed; zero waived formatting debt. One earlier readiness type signature required formatting-only cleanup.         |
| Runtime policy     | corepack.cmd pnpm@11.7.0 runtime:forbidden:check                                                                                  | 9 manifests and 238 sources checked; zero forbidden dependencies/imports/files/services.                                      |

Per-slice spec/quality reviews passed after the documented corrections. Whole-range review is pending for this candidate. Local aggregate logs and synthetic screenshots are retained under node_modules/.task67-evidence and are not committed. Root test output includes an intentional workspace-chrome fallback failure event from its error-path test; there were no test failures.

GitHub main was rechecked after combined validation and remains 8ac82cb4402ad7ac2af4313a20e0181710f04dc6. The original checkout and Task 5 branch remain preserved. No push, pull request, merge, migration or deployment was performed against external services.

## Isolation and remaining external gates

Only synthetic data is used. New disposable task67_integration and task67_operational databases run on the task-owned loopback PostgreSQL cluster at port 55445; Task 5 databases are preserved. Object artifacts use a separate task67-artifacts bucket in local TLS MinIO. Next.js/Wrangler use fake AI, mock SHOPLINE and SHOPLINE_PUBLISH_ENABLED=false.

Automatic approval review rejected indexing the active worktree because the MCP operation may transmit repository contents without specific payload-export authorization. Existing graph results were used only for discovery, with targeted active-checkout source verification; no index workaround was used.

The reference Site could not be opened by the web tool (non-retryable safe-open error). Local visuals can be checked, but reference parity cannot be claimed. Real workbook acceptance, merchant-side freshness/protected-field drift, independent post-import verification, production migration/deployment, paid providers and live SHOPLINE writes remain separately authorized gates.
