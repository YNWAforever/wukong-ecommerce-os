# Fresh-export comparison verification — 2026-09-05

## Scope and checkout

Local branch: `codex/catalog-fresh-export-verification`, based on verified GitHub main `c409056d0c066b05908aa1275910e5157d6cd687` after Tasks 0–7 and CI fixes were merged. This phase adds supplied-snapshot comparison evidence; it does not redo those packages. The graph was used for discovery and active source verified because the index was stale.

Implementation: exact delivered-artifact SHA/provenance validation, normalized product-ID comparison, immutable tenant-scoped evidence and audit, paged history/detail, bilingual reviewer form and retained retries. Original supplied XLSX bytes are not retained. No runtime or dependency changes.

## Reproductions and corrections

- Comparator/service/route tests initially failed for missing implementations. Behavioral cases cover all 71 field categories, leading-zero IDs, reordering, protected changes, missing/duplicate/variant targets, unrelated rows and bounds.
- Independent review found repeated whole-attempt validation: a 150-member regression observed 302 provenance traversals. Validation now runs once per boundary and indexes evidence; a 5,000-member regression verifies the final member and duplicate evidence still fail closed.
- The complete integration run found the new table missing from the expected composite-FK inventory. The inventory was corrected and the complete suite passed.
- A role regression caught the broader operator-report capability being used for comparison. The panel now uses reviewer/admin/owner capability, matching the server.
- UI review found collapse/reopen could hide an internally retained file selection. Follow-up validation is recorded below before final handoff.

## Executed gates

Commands run from this worktree using `corepack.cmd pnpm@11.7.0` and only local synthetic settings. Combined source checks through `42dd904`:

| Command                                                                                                                         | Result                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `test`                                                                                                                          | 1,659 tests: 67 root + 1,592 package tests; 14 Turbo tasks passed, including 1,010 web tests |
| `test:integration`                                                                                                              | 200 tests, 28 files passed; 3 explicitly opt-in destructive cases skipped in 2 files         |
| `--filter @wukong/db exec vitest run src/export-verifications-migration.integration.test.ts`                                    | 2 passed with explicit disposable rehearsal opt-in                                           |
| `typecheck`                                                                                                                     | 14 tasks passed                                                                              |
| `lint`                                                                                                                          | 14 tasks passed                                                                              |
| `build`                                                                                                                         | 8 tasks passed; synthetic auth/environment only                                              |
| `format:runtime:check`                                                                                                          | 20 files passed; zero format debt waived                                                     |
| `runtime:forbidden:check`                                                                                                       | 9 manifests / 242 source files; zero forbidden dependencies, imports or services             |
| `exec playwright test --project=chromium --workers=1 --retries=0 --reporter=line --output=node_modules/.task8-evidence/browser` | Managed production server and Wrangler: 11 passed, 2 intentional skips                       |
| `--filter @wukong/db audit:verify --workspace ws_opak --draft <synthetic draft>`                                                | Zero missing actions, zero accessible foreign records                                        |

Real PostgreSQL tests cover exact-retry concurrency (one evidence row/audit), new snapshots, deterministic history, workspace/attempt detail isolation, RLS, same-workspace FK, append-only behavior after privilege regrant, transactional audit rollback and migration replay. Fresh/upgrade rehearsal uses separately guarded `task8_migration`; runtime tests use `task8_integration`, and browser fixtures use `task8_operational`, all on loopback port 55445.

The attended browser journey downloaded and hashed the real generated artifact, submitted a reordered matching snapshot (201), then a protected-SKU change with one missing product. The second response was deliberately lost after commit; retry returned 200, `replayed=true`, and the same ID. Reload retained exactly two records and two comparison audit events. Operator reports retained their counts and `unverified` status. Both en/zh-Hant and 1440/375 layouts were exercised.

An initial browser launch exceeded the existing 120-second build startup limit; a standalone prebuild passed and the unchanged managed gate then ran. The first executed browser extension failed in its synthetic null-to-string workbook fixture before any comparison POST; correcting that fixture yielded the full passing run. Known Next middleware deprecation and local BetterAuth client-IP warnings remained; no page errors were observed.

## Evidence and remaining operational boundaries

Aggregate logs are local under `.superpowers/sdd/task8-*` and `node_modules/.task8-evidence/`; synthetic browser images are retained there. No merchant content or workbook is included in this record.

A matching result establishes only normalized fields in a supplied snapshot. Store identity and export time remain operator-attested; the system does not authenticate SHOPLINE origin, prove causal application, establish stock neutrality or verify current live state. Original Excel types/styles and original supplied XLSX bytes are not retained. Exact current Default headers and bounded normalized evidence are required; oversized evidence is rejected rather than truncated.

Migration 0018 has been exercised only in local disposable databases. No production migration, deployment, paid provider call, real workbook upload, merchant seed or real SHOPLINE write was performed. The branch remains local for review.

## UI review follow-up

Commit `a367f4f` fixes the retained-file collapse/reopen mismatch by keeping controls mounted while hidden. It also gives safe bilingual correction instructions for known permanent workbook/evidence validation errors. Twenty-five focused tests passed. The full managed browser suite passed again (11 passed, 2 intentional skips), including real invalid-header 400 and oversized-evidence 413 responses, preserved native file/time/attestation before initial submission and after response loss, and unchanged evidence/audit totals. Production prebuild passed. Independent UI re-review found no remaining issues.

Final unit rerun at `a367f4f`: `test` passed 1,666 tests (67 root + 1,599 package, including 1,017 web), 14 Turbo tasks. Final `typecheck` passed 14 tasks. Backend integration and migration source was unchanged after its complete passing run. Subsequent whole-branch review and cleanup are recorded below.

## Whole-branch review correction

The whole-branch review reproduced a false match with a valid synthetic workbook: its Default tab pointed to sheet2 with a changed SKU while Archive pointed to sheet1 with the original SKU. The old independent name/lowest-numbered-sheet reads compared Archive. Commit `e46baf0` adds a comparison-only reader that resolves the actual Default worksheet through package and workbook relationships. Both delivered and supplied workbooks use it. Legacy import selection is unchanged. Missing, duplicate, external, unsafe and unsupported bindings fail before persistence.

The actual service regression now records `differences_found` and the changed SKU; invalid relationship cases assert no persistence call. Shared Shopline tests passed 248 cases, including 20 new relationship cases; service/route tests passed 42. Independent whole-branch re-review found the issue resolved with no additional findings. No database or UI behavior changed in this correction.

At final source commit `e46baf0`, the complete `test` gate passed 1,691 tests (67 root + 1,624 package, including 1,022 web), 14 Turbo tasks. The complete `build` gate passed 8 tasks. Final web typecheck and explicit formatting/diff checks also passed. The unchanged database implementation retains its 200-test integration and two-case migration rehearsal evidence.

## Final handoff

After `e46baf0`, `exec playwright test tests/e2e/bulk-update-pilot.spec.ts --grep "reviewer completes attended" --project=chromium --workers=1 --retries=0 --reporter=line --output=node_modules/.task8-evidence/reader-browser` passed (one attended journey, 1.8 minutes, exit 0). This exercised the final reader through real local export/comparison, invalid-header and oversized-evidence rejection, history, exact retry and unchanged report/audit assertions. The full 11-pass/2-skip browser run preceded the reader-only correction; shared-reader and full-unit regressions plus this final attended rerun cover that correction. The existing Wrangler teardown diagnostic appeared; health, ingress and queues completed, and Playwright exited successfully.

All independent review findings are resolved. Synthetic PostgreSQL, MinIO, Mailpit, Next and Wrangler were stopped; final port checks cover 55445, 9012, 9013, 8026, 1026, 49217 and 8787. Synthetic evidence is retained in ignored local directories. Previous phase reports and other worktrees are preserved. The branch is committed locally for review, with no push or deployment.
