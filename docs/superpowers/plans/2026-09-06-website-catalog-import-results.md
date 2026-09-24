# Website catalog import execution results

## Task 0 — protected Node document transport

Implemented in the existing `codex/website-catalog-import` worktree from `b651d45`. No merchant URL, production configuration, schema, provider, or deployment was used.

### Baseline

Before production source changes, `corepack.cmd pnpm@11.7.0 test`, `typecheck`, and `build` all exited 0. The test gate reported 67 root tests plus 1,694 package tests (1,761 total); Turbo reused its valid pre-change package cache. Build completed successfully. The current local `main` ref was `792c0ec13a837fed9c426b414674baeedacf2a65`; the implementation worktree remained on the requested base/branch with initially clean status.

A later `--force` follow-up overlapped intentionally missing-module RED tests and then in-progress source typing, so it is not a clean baseline. It reported those expected web failures and a Windows Turbo shim tail error. The final normal test command succeeded. Full raw logs remain under `.superpowers/sdd/website-*.log` locally.

### Verification

- Unit RED: missing `./public-fetch` module before implementation.
- Integration RED: same expected missing module, using the explicit root integration configuration.
- Additional RED: three raw redirect spelling cases; three non-2xx metadata cases; two long Retry-After cases. Each failed on the specific missing behavior before its fix.
- Final focused unit gate: 57 tests passing.
- Isolated actual TLS integration gate: 6 tests passing, including preserved Host/SNI, original-host certificate verification, one-resolution address pinning, ambient proxy independence, and socket cancellation for oversize/deadline/caller abort.
- Full repository test gate: 67 root tests plus 1,749 package tests (1,816 total), 14/14 Turbo tasks successful. This run contained the first 55 transport tests; the subsequent two Retry-After regressions and one-branch fix were verified by the final 57-test focused gate.
- Web typecheck: passing after implementation and the final Retry-After adjustment.
- Browser reproduction of the unchanged import page is owned by the controller and recorded separately. No production deployment compatibility is claimed by these local tests.

Commands use `corepack.cmd pnpm@11.7.0`, with this worktree's `node_modules/.task9-services/bin` prepended to PATH for nested pnpm. Unit tests never source synthetic browser-auth environment values.

### Contract for following tasks

`createPublicFetch()` returns `PublicFetch`. It accepts `url`, `kind` (`robots`, `discovery`, or `product`), `lockedOrigin`, and an AbortSignal. `PublicDocument` returns normalized final URL, status, MIME type, plain response text, capture timestamp, and nullable Retry-After seconds. Non-2xx responses return empty text and status metadata so orchestration can handle robots 404, 429, and 503. Long valid Retry-After values are preserved; orchestration must not shorten them.

The request factory supports injected resolver, request adapter, TLS dialer, and clock for deterministic tests. Default production requests use direct fresh Node HTTPS agents and explicit TLS certificate verification against the original hostname. There is no production private-network switch. The synthetic TLS test alone maps the pinned public address onto a loopback fixture and trusts its generated one-day certificate.

The user agent is `WukongCatalogPreview/1.0`. Identity encoding is requested; other successful-response encodings are rejected. HTML/XHTML is limited to 2 MiB, robots and XML/plain discovery documents to 1 MiB. Every document has one 10-second deadline covering DNS, redirects, connection, and body; redirects are limited to three. Fragment removal preserves query parameters. Only initial apex/www canonicalization can change origin; a supplied locked origin and product redirects cannot change it.

The durable scan layer owns the one-second interval, five discovery-document budget, 20-product limit, robots policy, workspace authorization, leases, persistence, and auditing. This transport only fetches one bounded document. A timed-out OS DNS lookup may finish in the background, but its result cannot initiate a connection after cancellation.

Errors are bounded to `invalid_url`, `unsafe_address`, `origin_mismatch`, `too_many_redirects`, `invalid_redirect`, `unsupported_content_type`, `unsupported_encoding`, `body_too_large`, `deadline_exceeded`, `aborted`, and `transport_failed`; raw network details are not returned.

The root integration config now includes only `apps/web/lib/website/**/*.integration.test.ts` in addition to its existing patterns. The web unit script already excludes all `*.integration.test.ts`. TLS integration tests require local OpenSSL to create ephemeral synthetic certificates; Git for Windows OpenSSL and Linux `openssl` are supported.

## Controller baseline browser reproduction

The unchanged import UI was exercised with an isolated synthetic signed-in operator and no connection. Import submission was disabled, administrator guidance was visible, and both Website URL and Preview products controls were absent. The reproduction test passed (1/1) and retained a screenshot under node_modules/.website-evidence/baseline. No merchant workbook or storefront was fetched.

The synthetic web production build passed six tasks (five cached). An earlier build overlapped in-progress transport typing and failed on the subsequently fixed ProxyEnv type. The first scratch browser configuration resolved its server path relative to .superpowers/sdd and failed before tests; setting its explicit repository cwd resolved that harness issue. The unchanged reproduction then passed without assertion relaxation.

A single read-only public robots-policy request through the protected Node transport returned HTTP 200/text/plain for https://www.opakcellar.com/robots.txt. This establishes local transport compatibility for that endpoint only; product extraction and full policy evaluation remain pending. No public product records were stored.

## Additional pre-storage baseline and bounded live structure check

The isolated integration baseline passed 210 tests (30 files), with three intentional skipped cases across two files; duration 232.53 seconds. Output was buffered until completion. A subsequently started focused source-import diagnostic also passed 2/2. This precedes the website schema change.

The public robots policy returned a wildcard Crawl-delay of five seconds and a same-origin sitemap URL. After observing that delay, the homepage returned HTTP 200 with 1,645,681 bytes and two JSON-LD blocks; unresolved template product links were present alongside real links. One real linked product page returned HTTP 200 with 700,773 bytes and a Product JSON-LD block containing name, brand, description, image and offers (price, currency, availability), preceded by unrelated schema blocks. These structural observations informed synthetic parser fixtures. Product HTML and catalog records were not persisted; automatic extraction/save remains pending.

The completed parser was then checked against the same single public product after evaluating robots and waiting its five-second delay. HTTP 200 yielded a product with a 30-character title, 1,216-character description, two image references, HKD price and in-stock availability. These fields came from JSON-LD and no extraction warnings were returned. This is one-page local compatibility evidence, not complete-store coverage, stock-quantity verification or a saved merchant catalog. The probe retained field-presence metadata only.

## Task 1 — deterministic extraction and robots policy

Shared website observation contracts, deterministic JSON-LD/limited SHOPLINE HTML extraction and serializable robots policy are implemented. Website observations carry no inferred platform identity. The normalized preview is capped at 20 unique products and 1 MiB; the storage task separately enforces the complete persisted checkpoint limit.

Initial verification passed 63 core tests, 28 extraction/robots tests, all 1,177 web tests, and core/web typechecks. Independent review reproduced quadratic candidate serialization, a conflict missed after the 30-attribute cap, and incorrect handling of repeated long attribute values. The fixes use one fingerprint per candidate, explicit traversal/serialization work limits and original normalized attribute comparisons. Resource exhaustion returns a warning and no partially selected product. The final focused command, `corepack.cmd pnpm@11.7.0 --filter @wukong/web exec vitest run lib/website/extract-document.test.ts lib/website/robots-policy.test.ts`, passed 35/35, including a 2 MiB fixture and deep nested data. Web typecheck and scoped formatting passed. Independent re-review found no remaining issues in this task.

The remaining cross-task requirements are durable checkpoint bounds, request scheduling and retries, redirect-origin robots approval, authorization and safe UI rendering. Parser tests alone do not establish those guarantees.

## Task 2 — durable scans and selected observations

Migration 0019 adds workspace-scoped scans, fenced document steps and immutable saved website observations. The repository enforces a 15-minute deadline, request budgets including retries, crawl-delay spacing, matching-lease completion/replay and idempotent selection. Saved observations are validated against terminal server previews; website tables have FORCE RLS and composite tenant relationships. The bounded recovery query returns scan identities only.

The final website integration suite passed 17 tests and database unit tests passed 70. The broader database run reported 219 passed, one schema-inventory failure and three intentional skips. The inventory was updated for the new relationships and a missing child foreign-key lookup index was added. The affected listing, website and audit suites then passed 44/44. Database typecheck and scoped formatting passed. Migration verification ran only against the explicit synthetic database at 127.0.0.1:55445/website_integration. Independent storage review passed. Its minor recovery-test robustness finding was reproduced with eleven older scans and fixed; all 17 website integration tests and a repeated recovery case passed, and focused re-review was clean.

## Task 3 — queue orchestration and public API

The existing listing queue now accepts a strict website-scan variant. Signed Node callbacks claim one persisted document fetch, commit before network I/O, and cache completion; public create/read/save routes derive identity from the session and return no-store responses. Missing or failed dispatch remains recoverable through the existing sweeper.

A redirect regression proved that a permitted product URL could lead to a disallowed path before final-page checks. Transport now evaluates a server-owned URL approval hook before every hop. Initial apex/www canonicalization returns an unfetched redirect target separately from the actual response URL, allowing robots reapproval before the new host's page is fetched. The storage handoff rejects unrelated targets, locked-origin changes and premature evidence.

Verification passed: jobs 4/4; Worker 136/136; affected web/transport 116/116; website storage plus real-database signed orchestration 21/21; runtime configuration 11/11. All four affected package typechecks and the Worker dry run passed. Final API/service adjustments passed 47/47 and web typecheck. Save requests accept up to 20 keys within a 96 KiB body; internal callbacks and scan creation retain 4 KiB caps. Independent review found three integration defects: lost canonical redirect path/query, canonical-tag identity conflicting with actual fetched URL, and unpaced redirect hops. All were reproduced and fixed. Canonical hints now receive their own robots-approved bounded fetch; redirect waits honor policy within the existing deadline. Verification passed 87 transport/TLS/planner tests, 23 database integration tests, a final 17-test planner run, and web typecheck. Focused re-review was clean. No deployment occurred.

## Task 4 — mixed-source catalog and export exclusion

The catalog now uses one workspace-scoped SQL union for platform and website records, with shared filtering, deterministic sorting, counts and pagination. The reproduced 51-row fixture originally returned page sizes 25/5/0; the corrected result is 25/25/1. Website details expose the immutable normalized observation and safe source links, with no platform identity or listing actions.

Verification passed 147 focused web tests, seven real-database workspace-read tests, web/database typechecks and formatting. Direct website-ID export and delivery requests are rejected; the real-database bulk export test creates no artifact or successful export attempt. Existing eligible platform cases remain passing. Independent catalog review was clean. Task 5 adds rendered detail fetch-failure/retry coverage for its minor test suggestion.

## Task 5 — URL-first import and full synthetic acceptance

Catalog import now defaults to Website with localized URL, preview, progress and save controls. Operator-or-higher can scan without a SHOPLINE connection or credential key; viewer guidance remains explicit. Abort/latest-response guards stop stale requests, a scan ID survives reload in the URL, creation retries retain their idempotency key after a lost response, and replacement scans retain a clearly disabled prior preview. Workbook is an explicit choice and keeps its file/time state mounted; existing supporting-evidence and new-product safeguards remain. Product descriptions render as text. Source evidence uses a native keyboard-accessible disclosure with localized known field/provenance/availability labels; partial-scan warnings use localized explanations and a generic fallback.

The synthetic browser harness runs the real Worker, queue, signed Node route factory and database. A local test-only ESM callback adapter injects deterministic public documents at the factory; production transport defaults and public-address protections are unchanged. Actual Workerd acceptance exposed unsupported `redirect: "error"`. The consumer now uses `manual` and rejects all redirect statuses through its existing response allowlist. Six focused failures reproduced the defect before the fix; 16 consumer tests then passed, including 301/302/303/307/308 refusal. Managed callback HTTP 200 and Queue 1/1 completion proved the real runtime correction. Temporary diagnostics were removed.

Full verification passed: 68 root and 1,904 package unit tests, typecheck, lint, all eight build tasks, runtime formatting and forbidden-runtime gates. Isolated integration passed 235 tests with three intentional skips. The final complete Chromium command (`exec playwright test --project=chromium --workers=1 --retries=0`) passed 14 tests with two intentional skips in 1.8 minutes, covering the existing Workbook, inline store setup, Bulk Update, catalog, mock delivery and website paths. A prior full browser run caught only a legacy locale-reload assumption about Workbook being the default; the test now explicitly selects Workbook, retaining its setup and data assertions. The already-formatted Task 3 queue file's obsolete hash waiver was retired without changing other waivers.

Website acceptance verified a real reviewer session without a connection, queued/running progress, persisted scan reload, English/Traditional Chinese at 375px/1440px, keyboard navigation, no overflow, selection/save and read-only catalog detail. Stored observation equals the server preview; the retained synthetic evidence has SHA-256 `9ce8c4b6c197b0856d8bde8587146e0ad887e8362eedce402dc78fcdf0e4a55e`. The website audit verifier reports zero missing actions and zero accessible foreign records. Partial retry keeps the previous preview visible and unselectable until a distinct scan completes. Root visual review accepted the compact locale/viewport screenshots; the final localized-warning follow-up passed 15 affected UI tests and web typecheck, with all eight build tasks passing again. The affected partial-preview browser case then passed 1/1 in 20.1 seconds; root accepted the refreshed partial/retry screenshots.

Synthetic screenshots and evidence are retained under `node_modules/.website-evidence/task5/` in the assigned worktree; exact commands, intermediate failures, final follow-up and cleanup evidence are recorded in `.superpowers/sdd/website-task5-report.md`. No real workbook, merchant seed, additional public probe, production migration/environment/deployment, provider action, push or SHOPLINE write occurred. Production migration 0019, trusted HTTPS callback configuration and deployed-host compatibility remain a separately authorized rollout. Task 5 independent review and whole-branch finishing remain controller work.

## Final independent review and handoff

All Tasks 0-5 are complete. Task 5 review reproduced overlapping same-generation polling retries and stale responses replacing a ready preview. Commit `a8e7764` serializes polling, fences each response, and aborts pending reads on cancellation/unmount. The 19 affected panel/detail/tab tests and web typecheck passed; independent re-review was clean.

Whole-branch review covered pinned GitHub main `adeeae01d1f34d727baee4716f36560ea6e93a29` through the feature. It found one additional defect: a product/discovery HTTP 503 with Retry-After could schedule another request after one second despite requesting a longer pause. Eight cases reproduced this for both document kinds, short/deadline-exceeding waits and empty/retained previews. Commit `2fcb0926b620a95265a5084c7ec40995c4fdf1fc` terminates that scan without another request, retaining existing products as partial results. The 96 service/transport tests, including isolated actual TLS cases, and web typecheck passed. Final independent re-review approved the branch with no remaining actionable findings.

### Exact final verification commands

Commands ran from the assigned worktree with `node_modules/.task9-services/bin` prepended to PATH. Each command below uses `corepack.cmd pnpm@11.7.0` as its prefix.

| Command suffix                                                                                                                                                     | Result                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `test`                                                                                                                                                             | 1,972 tests passed (68 root + 1,904 package); full run before the two final focused fixes |
| `typecheck`                                                                                                                                                        | 14/14 tasks passed                                                                        |
| `lint`                                                                                                                                                             | 14/14 tasks passed                                                                        |
| `build`                                                                                                                                                            | 8/8 tasks passed; Worker dry run only                                                     |
| `format:runtime:check`                                                                                                                                             | Passed; 85 tracked changed runtime paths in post-Task-5 gate                              |
| `runtime:forbidden:check`                                                                                                                                          | Passed; 9 manifests and 267 sources, zero forbidden findings                              |
| `test:integration`                                                                                                                                                 | 235 passed, 3 intentional skips; explicit local website_integration environment           |
| `exec playwright test --project=chromium --workers=1 --retries=0`                                                                                                  | 14 passed, 2 intentional skips; isolated synthetic browser environment                    |
| `--filter @wukong/web exec vitest run components/website-import-panel.test.tsx components/website-product-detail.test.tsx components/listing-intake-tabs.test.tsx` | 19 passed after polling fix                                                               |
| `--filter @wukong/web exec vitest run lib/website/scan-service.test.ts lib/website/public-fetch.test.ts lib/website/public-fetch.integration.test.ts`              | 96 passed after backoff fix                                                               |
| `--filter @wukong/web typecheck`                                                                                                                                   | Passed after each final source fix                                                        |

Final source fixes also passed scoped formatting and whitespace checks. The full suites were not redundantly repeated after these focused changes; their directly affected regressions were run as recorded above. Stored synthetic evidence was independently rehashed and matched the recorded digest; audit verification reported zero missing actions and zero accessible foreign records.

All owned synthetic services were stopped. Ports 55445, 9012, 9013, 8026, 1026, 49217, 49219 and 8787 were verified closed. Service data, screenshots and unrelated worktrees are preserved. The implementation branch is `codex/website-catalog-import`; no push, merge or deployment has occurred.

Website observations remain public-page evidence, not proof of store ownership, complete catalog coverage, stock quantity, verified remote product identity or export source binding. They remain excluded from platform export/delivery. Workbook reconciliation requires a separate explicit design. Production migration 0019, trusted HTTPS callback configuration and deployed-host verification remain outstanding rollout prerequisites; no production readiness claim is made from synthetic acceptance alone.
