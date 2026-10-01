# Opak performance and quality acceptance

Execution evidence uses synthetic products, fake AI, mock SHOPLINE and disabled publishing. This runbook does not authorize production load, paid evaluation, migration or merchant writes.

## Measured baseline

Baseline source: `96e612e06a6faa0b8b54e9b1220a852c2469a4fb`. The private report and its source manifest remain in ignored local evidence storage. All 507 captured runtime/dependency file hashes were unchanged during measurement. Dedicated loopback database: `opak_fixes_perf_20261001`; application role was non-superuser and non-bypass `wukong_app`.

Configuration: Windows x64, Node 24.18.0, Intel i5-12500, 12 logical CPUs, 34,033,348,608 host memory bytes; PostgreSQL 17.10, 128MB shared buffers, 100 maximum connections, JIT on. Each application pool allowed two connections. Each operation used one cold sample and 20 warm samples with concurrency two. Cold means a new application pool; PostgreSQL and OS caches were not flushed. The driver wait includes pooling, transport and decoding; sampled EXPLAIN ANALYZE measures server execution separately.

These are actual in-process route factories and RLS repositories, without HTTP transport. Owned browser, build and test processes were stopped first; unrelated host workloads remained. One aggregate dedicated-DB activity probe ruled out a sustained lock wait and is recorded as diagnostic noise. These measurements do not establish browser typing latency or field INP.

| Products | Operation             | Warm p95 ms | App queries per response | JSON bytes p95 |
| -------: | --------------------- | ----------: | -----------------------: | -------------: |
|      500 | Catalog, 25 rows      |         862 |                       78 |         24,272 |
|      500 | Deep catalog, 25 rows |         522 |                       78 |         24,256 |
|      500 | Exact SKU search      |         204 |                        6 |          1,379 |
|      500 | Name search           |         320 |                       78 |         24,406 |
|      500 | Detail                |          40 |                       19 |          2,950 |
|      500 | Quality               |         179 |                       13 |          1,254 |
|    5,000 | Catalog, 25 rows      |         185 |                       78 |         24,274 |
|    5,000 | Deep catalog, 25 rows |         236 |                       78 |         24,278 |
|    5,000 | Exact SKU search      |          51 |                        6 |          1,383 |
|    5,000 | Name search           |         228 |                       78 |         24,438 |
|    5,000 | Detail                |         222 |                       19 |          2,950 |
|    5,000 | Quality               |       1,405 |                      103 |          1,260 |
|   20,000 | Catalog, 25 rows      |       8,680 |                       78 |         24,315 |
|   20,000 | Deep catalog, 25 rows |      92,310 |                       78 |         24,317 |
|   20,000 | Exact SKU search      |       9,170 |                        6 |          1,387 |
|   20,000 | Name search           |      35,629 |                       78 |         24,452 |
|   20,000 | Detail                |         129 |                       19 |          2,950 |
|   20,000 | Quality               |       9,091 |                      403 |          1,265 |

All 441 route samples returned without HTTP errors, blocked rows or cardinality failures. There were 126 sampled EXPLAIN records covering every operation. One-row catalog used six app queries versus 78 for 25 rows, reproducing per-row readiness growth. Quality used 13/103/403 queries as the cohort grew, reproducing per-request content scanning. The 20,000-row first catalog sample took 407,082ms. Sampled custom EXPLAIN catalog executions were only 268–369ms while route waits were much longer; N+1 alone does not establish the cause of every tail. The actual client uses `prepare:false`, disproving the prepared-plan hypothesis. Subsequent read-only diagnostic plans showed current-title hydration and legacy sorting costs, without demonstrating a missing-index bottleneck. They ran under shared host load and are not the controlled post-change result.

Targets remain warm catalog p95 <800ms, detail <1,500ms and search <1,000ms; 300ms client debounce and HTTP/browser overhead are separate. No target pass is claimed for an unmeasured post-change build. Use the exact existing fixture IDs through `--reuse` for the comparison; implicit reseeding or changed sample counts cannot substitute for the recorded cohort.

## Quality semantics

Copy-gap signals, factual source evidence, current human confirmation and live delivery readiness are separate. Equal bilingual proper names are advisory wording checks. Absence of copy-gap signals does not establish factual correctness, approval, export eligibility or a store update.

Revision-aware quality counts exclude pending, failed and outdated contributions. The response exposes its assessment version, update time and incomplete work. Bounded reconciliation hydrates at most 25 current listings; it does not loop over all content on every GET. Tenant projection tables are derived observations and never authorize approval or delivery.

Known AI cost and unknown-cost references use the same current owned-run snapshot across retained listing history. A null cost remains unknown for started, failed and successful runs. Displayed references are bounded while the total remains complete; an exact batch binding links to batch reconciliation. A legacy run without that binding retains its real run ID and listing link for support. The listing may have a newer version. Batch archive does not erase historical costs.

Backfill, migration replay, real app-role isolation, concurrency, malformed rows, whole DB/permission failures and the same-dataset post-change measurements remain acceptance gates until explicitly recorded in the fix ledger. Rollback retains projection metadata, audit, source/version history, accepted work and cost reservations.

See [AI acceptance](opak-ai-acceptance.md) for the explicit `audit-fixtures-v1` adapter and controlled human grading. Dry mode makes zero provider requests and reports `not_evaluated`; it is not AI accuracy evidence. Live AI, low-resolution image acceptance and real merchant comparison remain separately authorized gates.
