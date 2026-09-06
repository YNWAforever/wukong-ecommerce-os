# Operations Workbench verification

Verification: 2026-09-06–2026-09-07 (Asia/Hong_Kong)
Branch: `codex/operations-workbench`
Baseline: `0a25e701e04238f24f3c73bf6761da0b01dcca00`
Status: complete, reviewed and verified locally; no release performed.

## Implemented behavior

The dashboard now shows a read-only, workspace-scoped worklist with all-history counts, bounded pages, attention/progress/completion classification and a separate unavailable-status view. A single SQL snapshot supplies counts and membership. Listings, exact export attempts, retained website scans and successful workbook imports remain distinct task types.

The workbench has localized reasons, role-aware destination links, source and product counts, observed-time/stale labels, retry and focus refresh. URL filters survive navigation and Back. Cross-query responses cannot replace current membership. Exact Jobs and Catalog destinations reset incompatible retained results while preserving unrelated operator form state. Navigation groups the four primary workflows and keeps existing tools/admin gates.

## Reproduced failures

- The old authenticated dashboard did not contain the Workbench heading (one expected browser failure, saved before implementation).
- Destination query changes retained the old import/attempt. Follow-up tests reproduced old attempt A details while B loaded/failed, and old import A rows under import B. Scope/identity corrections now have pending, failed, retry and retained-form coverage.
- The initial UI/nav contract tests failed before implementation. Mobile guidance was initially hidden; review corrected it to an accessible collapsed native disclosure.
- A final root unit run found two stale navigation test fixtures. Updating the route expectation and navigation mock fixed these. Two additional auth failures came from using browser configuration for the unit gate; the normal isolated unit environment passes without changing auth behavior.

## Verification results

All commands run from the isolated worktree through `corepack.cmd pnpm@11.7.0` unless noted. Synthetic local services only; no production environment file loaded.

| Check                                          | Result                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `test`                                         | Exit 0; 68 root Node tests plus 2,068 package tests (2,136 total); 14 Turbo tasks succeeded |
| `test:integration`                             | Exit 0; 252 passed / 3 skipped; 34 files passed / 2 skipped                                 |
| Workbench integration after diagnostic cleanup | Exit 0; 8 passed                                                                            |
| `typecheck`                                    | Exit 0; 14 Turbo tasks succeeded                                                            |
| `lint`                                         | Exit 0; 14 Turbo tasks succeeded; repository lint is TypeScript checking                    |
| `format:runtime:check`                         | Exit 0 after formatting the approved spec/plan; 45 runtime files checked, no debt waiver    |
| `runtime:forbidden:check`                      | Exit 0; zero forbidden dependencies, imports and runtime files/services                     |
| `build`                                        | Exit 0 after final export-evidence correction; 8 Turbo tasks succeeded                      |
| Browser acceptance                             | Exit 0; 7 passed, 0 skipped, 0 retries after final review correction (2.9m)                 |
| Whole-branch review                            | Approved at 2790b43; no Critical/Important findings; all five original findings resolved    |
| Owned-service cleanup                          | Complete; zero listeners on all eight owned test/preview ports                              |

Detailed local logs are in `.superpowers/sdd/workbench-*.log`. The three integration skips are unchanged destructive migration rehearsals: two export-verification cases require FRESH_EXPORT_REHEARSAL_DATABASE_ADMIN_URL plus explicit disposable opt-in; one import-result case requires dedicated TEST_MIGRATION_DATABASE URLs. No new migration is introduced, so these destructive rehearsals were not enabled. Browser evidence is below.

## Evidence and remaining limits

Counts cover retained local records, not current remote SHOPLINE state. A completed export means all included members were operator-reported accepted; that claim remains unverified. Preview completion does not imply saved products or publication. Independent workbook and website products acquire no new approval, source binding or export authority through this workbench. Existing version-bound review, reconciliation and delivery services remain authoritative after navigation.

Synthetic regression evidence does not establish production latency at merchant scale or real SHOPLINE acceptance. No new schema migration, provider call, merchant data seed, real workbook upload, push, merge or deployment is part of this slice. Real SHOPLINE writes remain disabled. Production rollout remains a separate user decision.

## Browser evidence

Command: `corepack.cmd pnpm@11.7.0 exec playwright test tests/e2e/workbench.spec.ts --retries=0 --output=.superpowers/sdd/workbench-evidence/test-results` with `PLAYWRIGHT_E2E=1` and the isolated browser environment.

Each case creates a fresh authenticated workspace. The retained fixture contains 27 listings, a pipeline for an already-counted listing, one ready export, one legacy unknown export and one partial scan. Counts are 28 attention / 0 progress / 1 completed / 1 unavailable, with 25 + 3 attention rows. Another case imports a one-product, in-memory synthetic XLSX through the real preview/save APIs and follows the exact import ID into Catalog. Role changes use real local memberships. Network interception is limited to explicit failure/race cases; browser requests are checked to remain local.

The original six cases verify exact listing content, export details despite a failing Jobs ledger, import context, partial-preview wording, viewer/reviewer controls, local return links, stale/retry/race behavior, keyboard navigation, locale switching and no horizontal overflow at 390px and 1440px. Screenshot review found and corrected seven workbench secondary-text declarations that used a background token. Final secondary-text contrast assertions pass at 4.5:1 or better.

Final local screenshots:

- `.superpowers/sdd/workbench-evidence/test-results/e2e-workbench-responsive-3-aaabd-inese-and-keyboard-controls-chromium/workbench-390-en.png`
- `.superpowers/sdd/workbench-evidence/test-results/e2e-workbench-responsive-3-aaabd-inese-and-keyboard-controls-chromium/workbench-390-zh.png`
- `.superpowers/sdd/workbench-evidence/test-results/e2e-workbench-responsive-1-a2b49-inese-and-keyboard-controls-chromium/workbench-1440-en.png`
- `.superpowers/sdd/workbench-evidence/test-results/e2e-workbench-responsive-1-a2b49-inese-and-keyboard-controls-chromium/workbench-1440-zh.png`

Initial browser failures were fixture/title expectations, corrected before the final run. The existing local Better Auth client-IP warning remains; the Next middleware deprecation and Worker dry-run informational output remain. The browser suite does not download S3 export bytes or submit result receipts; existing unit/integration suites cover those unchanged contracts. It does not exercise a real merchant or provider. The Playwright-owned web listener on 49217 closed after testing.

## Final review correction

Whole-branch review found two export presentation gaps. Completed export rows now explicitly say that results were operator reported and not independently verified, in both locales. Rejected and unreported included members share honest needs-attention wording. Export fallback titles use the attempt identifier, unknown product counts are explicit, and all-sources empty workspaces have different guidance from empty filters.

The correction reproduced seven failing focused assertions before implementation, then passed all 14 focused tests. The final root unit run passed 2,136 tests. A seventh browser case creates separate accepted and rejected receipts in a fresh synthetic workspace, with exact included listing/version identity and complete required provenance. Database guards remain enabled. It verifies completed-export qualifiers, exact inspector navigation, and rejected/unreported attention wording in both languages. The full browser suite passed all seven cases without retries. No remote receipt was submitted and no merchant acceptance was claimed.

A final non-blocking review note corrected the test's locale-cookie URL to use the signed-in page origin rather than a fixed localhost URL. Its targeted bilingual accepted/rejected journey passed (1 test, 0 retries, 34.4s). That rerun exposed an ambiguous test selector matching both exact and history inspectors; the assertion now targets the named selected-export region. No application behavior changed for this test correction. Final-review screenshots are under `.superpowers/sdd/workbench-evidence/final-fix-test-results/`; the earlier contrast screenshots listed above remain available. Review artifacts and logs remain ignored local evidence.

Owned-service cleanup completed on 2026-09-07: Postgres was stopped with pg_ctl against the verified synthetic data directory; verified MinIO, Mailpit and mockup-server processes were stopped. Ports 49217, 49220, 54061, 55445, 9012, 9013, 8026 and 1026 have no remaining listeners. Synthetic data and screenshots remain on disk. The named worktree and branch are preserved. No push, merge or deployment was performed.
