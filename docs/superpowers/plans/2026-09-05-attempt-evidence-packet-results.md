# Attempt evidence packet verification

Approved on 2026-09-05; verified on 2026-09-06. This local slice is stacked on `88c3b0b26866a62d8425c968283b8d5b236c9879` in `codex/attempt-evidence-packet`. GitHub main was verified at `c409056d0c066b05908aa1275910e5157d6cd687` before implementation. The prior phase remains separate and local.

## Behavior and regression evidence

The packet combines one explicitly selected comparison with its ready export and complete applicable operator receipt revisions from one database snapshot. It includes source, version and approval references, normalized comparison evidence and explicit unreported members. Stored artifact bytes are checked against the delivered digest. Original supplied XLSX bytes are unavailable and are not claimed to be revalidated.

Tests first failed because the packet builder, repository, service and route did not exist. They now cover canonical hashes, older comparison selection, receipt corrections, incomplete or corrupt evidence, concurrent snapshot consistency, overflow, authorization, stale previews and audit failure. This phase adds a review packet; it does not reopen the merged export eligibility work.

GET previews the chosen comparison and its snapshot hash. POST requires that comparison ID and the preview hash. Changed evidence returns HTTP 409 without a download audit; a new as-of time alone does not invalidate a preview. The JSON envelope is `{payload,payloadSha256}`. Its declared `sorted-json-v1` canonicalization sorts object keys and preserves deterministic array order. The payload hash includes `asOf`; the preview hash excludes only that field. Packets exceeding 3 MiB or 1,000 receipt revisions are refused, never truncated. A successful content-free audit records response preparation, not browser receipt.

The browser scenario selected an older matching comparison while a newer comparison existed, appended a fourth receipt correction after preview, observed HTTP 409 without an audit, explicitly refreshed the preview, recovered from a simulated HTTP 503, and downloaded the actual attachment. It independently canonicalized and hashed the envelope, checked the selected attempt/comparison and all four receipt revisions, and verified two reported members with none unreported. Comparison/report state and other audits were unchanged; no publish job was created. Selection changes required another preview.

## Exact checks

Commands ran in this worktree with `corepack.cmd pnpm@11.7.0`. Database/browser commands used ignored task-local environment scripts targeting synthetic loopback services. The task-local pnpm launcher was first on PATH for final typecheck and lint.

| Command or check                                                                                                                                                         | Result                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `test`                                                                                                                                                                   | 1,741 tests passed: 67 root and 1,674 package tests, including 1,072 web tests; 14 Turbo tasks passed |
| `--filter @wukong/web exec vitest run lib/export-evidence-packet.test.ts lib/export-evidence-service.test.ts app/api/listings/export/[id]/evidence-packet/route.test.ts` | 44 tests passed                                                                                       |
| Focused packet, fresh-export and reconciliation component suites                                                                                                         | 31 tests passed                                                                                       |
| `exec vitest run packages/db/src/repositories/export-evidence.integration.test.ts`                                                                                       | 4 tests passed                                                                                        |
| `test:integration`                                                                                                                                                       | 204 tests passed in 29 files; 3 explicitly opt-in destructive cases skipped in 2 files                |
| `typecheck`                                                                                                                                                              | 14 Turbo tasks passed                                                                                 |
| `lint`                                                                                                                                                                   | 14 Turbo tasks passed                                                                                 |
| `build`                                                                                                                                                                  | 8 Turbo tasks passed; worker dry run only                                                             |
| `format:runtime:check`                                                                                                                                                   | 45 files passed, zero waived debt                                                                     |
| `runtime:forbidden:check`                                                                                                                                                | 9 manifests and 249 sources checked; zero forbidden dependencies, imports or services                 |
| Managed Playwright, Chromium, 1 worker, 0 retries, line reporter                                                                                                         | 11 passed, 2 intentional skips; both locales at 375 and 1440 pixels                                   |
| `--filter @wukong/db audit:verify --workspace ws_opak --draft 0397bfc7-19cf-4ee9-9013-8f0e7b98f75f`                                                                      | Zero missing actions and zero accessible foreign records                                              |

The integration concurrency test used a test-only SQL advisory barrier around the intact production statement. A concurrent receipt append could not mix count and receipt snapshots. Overflow fixtures respected existing receipt predecessor constraints; no production hooks or disabled triggers were added. Existing migrations ran only against new `task9_integration` and `task9_operational` databases on loopback port 55445. This slice adds no schema, migration or dependency.

A formatting omission in the backend service was caught and corrected in `c4ebfd8` before the runtime gate passed. The initial full browser run had an enrollment timing failure; the unchanged managed rerun passed all 11 enabled scenarios. Initial full typecheck failed in the Windows fallback pnpm launcher with `XT:;.JS;=;`, without a TypeScript diagnostic; the task-local launcher rerun passed typecheck and lint. These initial logs are preserved alongside passing evidence.

Backend and UI task reviews approved the implementation with no critical or important findings. The UI review identified a minor test omission: audit metadata keys were checked without their exact values. The assertion was strengthened to compare the audit against the selected attempt/comparison, downloaded payload hash, refreshed preview hash and schema version.

## Remaining source-binding and operational limits

The packet is supplied-snapshot review evidence. Store identity and export time remain operator-attested. Retained normalized cells do not prove original workbook bytes, authenticated live SHOPLINE state, causality or stock neutrality. SHA-256 detects payload changes but does not authenticate the publisher. The packet neither signs off UAT nor grants merchant-write authority. Source, approval, comparison, report and publish state retain their existing meanings.

Only fake AI, mock SHOPLINE, local PostgreSQL/MinIO/Mailpit and synthetic fixtures were used. Real SHOPLINE writes remained disabled. No paid provider, real workbook upload, merchant seed, production migration, deployment, push or merge was performed. Detailed logs, browser screenshots and review notes remain ignored under `.superpowers/sdd/task9-*` and `node_modules/.task9-evidence`.

## Final review and cleanup

The follow-up browser command was `corepack.cmd pnpm@11.7.0 exec playwright test tests/e2e/bulk-update-pilot.spec.ts --project=chromium --workers=1 --retries=0 --reporter=line --output=node_modules/.task9-evidence/browser-review --grep "reviewer completes attended Bulk Update and reconciles mixed operator reports"`. It passed 1/1 in 2.0 minutes with the exact audit-value assertions committed in `87d6e1f`. Full browser command: `corepack.cmd pnpm@11.7.0 exec playwright test --project=chromium --workers=1 --retries=0 --reporter=line --output=node_modules/.task9-evidence/browser`.

Independent final review of `88c3b0b..87d6e1f` and the pending documentation found no critical, important or minor issues. It verified the source and regression assertions; it did not rerun the reported full test gates.

Task-owned PostgreSQL, MinIO and Mailpit were stopped. Managed browser servers also stopped. Ports 55445, 9012, 9013, 8026, 1026, 49217 and 8787 were verified closed. Synthetic data and logs were retained; generated test-results were moved into ignored evidence storage. The branch remains local for review, with the original checkout and prior worktrees preserved.
