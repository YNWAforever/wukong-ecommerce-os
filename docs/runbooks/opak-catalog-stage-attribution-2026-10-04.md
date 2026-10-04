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

Current source base is `c8fccd995e40e5389436409403150c885ee430d3`; this delta touches catalog instrumentation and tests only. Protected staging deployment and server-stage measurements are pending. Earlier CI 37182283003 validates the base, not this change. UAT stays 15PASS/3PARTIAL/12BLOCKED/all30.

## Release and rollback

No migration, environment name/value, provider credential, Worker change, queue admission, paid AI or SHOPLINE write is needed. Revert the timing helper/route delta or retain the preceding compatible Web candidate; preserve sources, current inputs, versions, approvals, audit, artifacts, queues and positive/unknown reservations. Controlled staging must retain bounded independent compute/Worker stops; the expired Neon CLI login cannot act as the sole stop controller.

Production repair authority/recovery owner/recoverable point, 0046/safe-role/cache/effective Web/original 500, paid-human quality, matched employee minutes and first real SHOPLINE/reconciled 5→20→100 remain open. Conditional main auto-deploy merge stays held.
