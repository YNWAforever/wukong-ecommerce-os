# Opak catalog stage attribution — 2026-10-04

T10/F09 remains open: the retained deployed 20k legacy deep warm p95 is **827.78ms against 800ms**. This change adds successful-route attribution so the next controlled synthetic staging measurement can locate the delay. It does not establish a cause or a performance improvement, replace the original miss, or authorize production deployment.

## Behavior and privacy

`GET /api/catalog` attaches `Server-Timing` only after the normal server session and authorized workspace read succeed with HTTP 200. Every request has its own monotonic clock and measurements. The header contains fixed stage names and bounded numeric milliseconds only; it contains no query, SQL, workspace/actor/product identity, content, error, prompt, model output or credential. No successful-request log is added. Existing request ID, `no-store`, response fields, cursor scope, row isolation and whole-database failure behavior are preserved.

| Metric    | Meaning                                                                                 |
| --------- | --------------------------------------------------------------------------------------- |
| session   | Existing server session resolution and authorization context                            |
| workspace | Entire workspace transaction, including its nested stages and pool/transaction overhead |
| catalog   | Existing scoped catalog repository read; includes driver wait/decoding                  |
| products  | Existing bounded platform hydration                                                     |
| sources   | Existing batched source-readiness load                                                  |
| rows      | Existing row resolution and classified row isolation                                    |
| serialize | Response fields, cursor encoding and JSON serialization                                 |
| total     | Route work through header attachment                                                    |

Workspace is inclusive: **do not add it to catalog/products/sources/rows** or report any of these as pure Postgres execution time. Total excludes framework/edge work before the route and response transport afterward. HTTP minus total is time outside the measured handler, not an isolated network or cold-start measurement. Each p95 stage may belong to a different request; preserve the stages of the actual HTTP p95 sample when attributing a tail.

## Verification checkpoint

- Existing route regression first failed because the authorized response lacked the header (1 failed, 14 passed); it is the behavioral RED evidence. The new helper test initially could not import the not-yet-created module, which is an import/setup failure, not a second behavioral reproduction.
- `pnpm --filter @wukong/web exec vitest run lib/catalog-performance.test.ts app/api/catalog/route.test.ts lib/route-support.test.ts`: 30/30 passed. Covers nested measurements, simultaneous request isolation, original error propagation, invalid duration/label rejection, authorized header privacy, unauthorized and global-error suppression.
- `pnpm test`: root 142/142, 0 skipped; 14/14 Turbo tasks, Web 2,290/2,290. Thirteen tasks reused valid cache; Web executed.
- `pnpm typecheck`: 14/14 tasks, Web executed.
- `pnpm build`: 8/8 tasks in239.109seconds; Web executed, seven tasks reused valid cache. Existing middleware deprecation warning retained.
- Four-file Prettier check and `git diff --check`: passed. Static release gate: 6 automated pass/14 human pending; forbidden-runtime checks: 0.
- Independent read-only four-file review: no Critical/Important/Minor findings. It declined deployed p95/root cause, live RLS, executor suite/build and framework/network latency. These remain separate verification obligations, not waived requirements.

Current source base is `c8fccd995e40e5389436409403150c885ee430d3`; this delta touches catalog instrumentation and tests only. Source24ff5f68 full CI37189358010 completed SUCCESS with43successful steps and one conditional failure-artifact upload skipped. Protected candidatefba82ee4 / dpl_3oiUCZboohZqaQ5s9kvSVnjEtUAD is READY in iad1, and the dedicated staging alias is verified. The only source-tree difference from reviewed24ff is the existing automatic-deployment guard. Earlier CI37182283003 validates only the base. UAT stays 15PASS/3PARTIAL/12BLOCKED/all30.

## Release and rollback

No migration, environment name/value, provider credential, Worker change, queue admission, paid AI or SHOPLINE write is needed. Revert the timing helper/route delta or retain the preceding compatible Web candidate; preserve sources, current inputs, versions, approvals, audit, artifacts, queues and positive/unknown reservations. Controlled staging must retain bounded independent compute/Worker stops; the expired Neon CLI login cannot act as the sole stop controller.

Production repair authority/recovery owner/recoverable point, 0046/safe-role/cache/effective Web/original 500, paid-human quality, matched employee minutes and first real SHOPLINE/reconciled 5→20→100 remain open. Conditional main auto-deploy merge stays held.

## Executed server and browser observations

Two completed immutable windows add105actual successful responses on the same20k population:63server-stage samples and42API/native-browser samples. Each group has one first-observed and20warm responses, concurrency2. All105passed body/cardinality/blocked-row/header-schema checks. Both windows pass13/13scope/domain/role checks in198.231/202.543seconds; their independent430-second compute controllers finish in221.549/230.684seconds without deadline stops. Normal password login, server operator, workspace selection and restoration are actual checks.

| Window / mode                                | Warm outer HTTP p95 ms | Handler in that exact p95 sample ms | Outside handler in that sample ms | 800ms outer target       |
| -------------------------------------------- | ---------------------: | ----------------------------------: | --------------------------------: | ------------------------ |
| Stage / catalog25                            |                 759.92 |                               175.6 |                            584.32 | pass                     |
| Stage / legacy deep25                        |                1045.56 |                               118.2 |                            927.36 | fail                     |
| Stage / cursor deep25                        |                 774.86 |                               154.5 |                            620.36 | pass                     |
| Transport / API legacy deep25                |                 799.09 |                               117.3 |                            681.79 | pass in this observation |
| Transport / native-fetch outer legacy deep25 |                 805.70 |                               118.9 |                            686.80 | fail                     |

The native browser reports h2. Its warm ResourceTiming p95 is732.90ms; reported DNS/connect/TLS durations are0for all warm samples, request-to-headers p95 is661.30ms and body p95 is55.90ms. The actual outer p95 sample has resource732.90ms, request-to-headers658.70ms, body69.10ms, encoded3,551/decoded24,681bytes and handler118.9ms. The outer805.70ms includes72.80ms beyond this browser resource duration. These are measured boundaries, not a unique network/framework/edge/automation diagnosis. Separate stage p95 values are not added; stages above come from the exact HTTP tail sample.

Installed primary Playwright1.51.1 code uses a keepAlive:true HTTPS agent; the simple hypothesis that its configured agent disables keep-alive is unsupported. Both client observations still contain substantial time outside the handler. This is evidence to investigate the request path and actual employee environment; it does not justify a speculative index, permission/cache relaxation, region/DB rewrite or declaring the original827.78ms/800ms miss fixed. The two observational groups are sequential, not a randomized causal experiment. First-observed is not proven cold, and automated fetch is not field INP or measured employee benefit. All misses and max/tail samples remain in the [safe JSON](./opak-catalog-stage-attribution-2026-10-04.json).

Each completed window retains exact25ordered deep cursor/legacy identities at total20,000. Original UC24 and target ten-domain fingerprints are unchanged; auth and entire-database equality are not inferred. Current DB is17.11/69public/59RLS/59FORCE, app non-superuser/non-bypass/owns0. Each window acknowledges owned logout200/account401, two paused queues, closed ingress/cron and disabled-idle0.25CUcompute; independent Worker watchdogs stop normally. Fresh terminal readback confirms reviewed Workerfcf100%, source593, five secret names/no probe bindings and public HEAD404. Queue/cron provider flags remain independently unavailable; command acknowledgements are explicit.

## Retained failures and current release boundary

The first diagnostic window fails before login/sampling: four checks pass, samples0, all five stops acknowledge, controller deadline does not fire. The old temporary access lands on Vercel /login; visually reviewed blank-login screenshot and safe locator counts establish why the Wukong Magic link click times out. Owner-authorized temporary access is regenerated only for the same protected staging alias; with compute disabled, /signin200and the expected Wukong methods are verified. The failed window remains failed; the valid-access windows reuse the exact candidate/cohort. No permanent protection bypass, application auth/provider credential change or false500 claim.

One deployment create succeeds before its CLI response parser fails on a mixed notice/JSON output. Its exact ID/SHA is recovered and independently READY-checked; no repeated POST. Separate V8 URL availability and pnpm direct-root module-resolution failures remain helper failures, corrected without product edits or gate relaxation. Raw errors, private access URLs, cookies/passwords and HTML stay outside Git.

Commands: node run.mjs20000 in the separate private attribution-v1/v2/v3 directories; node inspect-signin.mjs; node read-final-budget.mjs; node final-hold.mjs. Finite30-second/1MiB sampled request ceilings,390-second work ceiling,8-minute Worker watchdog and independent430-second connector compute stop remain in force. Expired Neon CLI login is neither replaced nor used as the sole stop controller.

Reported owned Wukong project charge isUS$1.4595415531509197at2026-10-04T09:14:26.315Z, including production/other previews and possible reporting lag. This is not an isolated or final all-provider bill. Standing cap remainsUS$5; paidAI0/realSHOPLINE0/newQueue0/outgoingEmail0and no subscription/compute-size upgrade.

UAT remains15PASS/3PARTIAL/12BLOCKED/all30. Production0046/safe role/cache/effective Web/original500/exact approval and recovery ownership, paid-human UC09–20, actual matched20-item employee timing and first realSHOPLINE/reconciled5→20→100 are open. No migration/env/secret/Worker source or production mutation. Source24ffCI is green; this documentation-only head still needs its own exact CI. Immutable release-pack/PR readback evidence is recorded outside Git to avoid self-referential evidence commits.
