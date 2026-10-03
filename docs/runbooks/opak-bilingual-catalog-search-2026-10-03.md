# Opak bilingual catalog search — 2026-10-03

## Finding and behavior

ST26 / T03–T07 / UC05: reproduced → fixed locally. On the isolated733 Web candidate, a bilingual synthetic workbook product appears by its leading-zero SKU but not by its English multiword name. Browser v27 fails the English search assertion. A separate actual repository query also returns zero for the full owned English phrase and its short substring. This is a product defect, not a timing or pagination diagnosis.

The catalog union exposes only a Chinese-first display title; its substring predicate therefore never examines the current English name when Chinese is present. Add an internal English search projection to each union arm. Platform and draft projections reuse the existing current revision, active version and operator/lock-aware title authority. Workbook references use their frozen bilingual product. Website title behavior is unchanged. Keep Chinese display, literal substring semantics, workspace joins, source SKU/IDs, readonly canExport=false, exact counts/cursors and the empty-query identity-only population/page hydration. Strip the internal projection from every response mapping.

## Executed source verification

Base source:674e6bd93b4d084690b3aed079b06f4e9433f407. Dedicated synthetic loopback database opak_fixes_bilingual_20261003 on127.0.0.1:54339; app role is non-superuser/non-BYPASSRLS. No cloud/production connection used for these tests.

| Command                                                                                                                                                                                            | Actual result                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| pnpm exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/workspace-reads.integration.test.ts --maxWorkers=1 -t 'projects active AI titles                           | current English name                                         | bilingual workbook', original SQL | Corrected RED:3 assertion failures/11 skipped; draft, bound product and workbook English names absent |
| pnpm exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/workspace-reads.integration.test.ts packages/db/src/repositories/cursor.integration.test.ts --maxWorkers=1 | GREEN:18/18, two files                                       |
| pnpm test                                                                                                                                                                                          | exit0;14/14 successful Turbo tasks, Web2283/2283             |
| pnpm lint; pnpm typecheck                                                                                                                                                                          | exit0 each,14/14 tasks each                                  |
| pnpm build                                                                                                                                                                                         | exit0,8/8 successful tasks, synthetic loopback auth settings |

Regression coverage includes current operator-owned and locked English names with Chinese display, stale AI/source names excluded, preserved source SKU and leading zeros, deliberately cleared current SKU, both workbook languages, foreign import exclusion, literal percent search, no internal field exposure, readonly authority, >5000 exact pagination, responsibility and cursor boundaries.

Initial tooling/fixture errors remain outside Git: one syntax-only patch failure and a CRLF anchor mismatch did not write application SQL; early test expectations incorrectly preferred generated English over an existing operator value and attempted a second connection in one workspace. Correct expectations preserve the existing ownership and one-connection contracts. The corrected tests were then run against the original SQL and failed for the intended assertion before the same minimal repair passed. No ownership/permission rule was changed to fit the fixtures.

Independent read-only two-file review:0 Critical/0 Important/0 Minor. Full unit execution is the implementer's separate gate. Final ruling: the unchanged listingPage/API search was considered outside this catalogPage repair; the catalog product center uses its own API, and no claim of verifying every legacy search endpoint follows. Cost if wrong: a bounded catalog fix could be promoted to a complete API search audit. Final ruling: production performance/deployed behavior requires its separate actual evidence; local PostgreSQL and compile passes are not deployment acceptance.

## Cloud and release boundaries

New exact-head CI and a guarded isolated preview of this change remain pending at this source checkpoint. Cloud733/v27 is the original failed candidate, not a successful deployment of this repair. v27's fallback logout lacked JSON media type; its failed session-stop and emergency watchdog receipts remain unchanged. A separate exact owned-fixture cleanup revoked2 sessions, leaves0 for those three actors, alters0 other users and confirms disabled/idle staging compute. No product logout endpoint was relaxed.

No migration, new environment variable, dependency, provider key, paid AI, real SHOPLINE write, Worker deployment or production mutation. Keep the native POST fix, existing mail simulator guard and corrected Object Read-only Worker credentials on compatible rollback. Reverting only the search delta restores the search defect and does not change stored data; retain versions/sources/audits/ledgers and fresh approval fences.

Conditional merge remains held: production0046 missing, Hyperdrive owner/BYPASSRLS with cache enabled, effective Web/session and original500 unresolved, first-stage authority and recovery ownership pending. Paid/human quality, employee-minute benefit and real merchant first-write/5→20→100 gates remain open. PR120 is an overlapping draft with failed CI. Earlier674 fullCI37119472547 completed SUCCESS; it cannot validate this new delta. Raw fixtures, screenshots, protected browser admission links and credentials remain outside Git.
