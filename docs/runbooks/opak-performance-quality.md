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

Targets are warm catalog p95 <800ms, detail <1,500ms and search <1,000ms; 300ms client debounce and HTTP/browser overhead are separate. The original seven operations meet their applicable targets at every scale in both retained after runs. The separate final 20k cursor operation misses its target, as documented below. This does not establish HTTP/browser latency or field INP.

## Same-cohort post-change result

Measured source: `6ccfd0ecc2b1e09269e7a41abe64f9ffd10d4805`; compiled runtime is from `9b5c7d19bae024d08c58c0e8ce2007ba7e1a0208`, with subsequent commits changing only benchmark/tests. All 425 captured source and 130 compiled hashes remained unchanged from start to end. The original baseline report copy hash was `c3d28877835da4aad7eab843314d32d10823b3a7d22666435b82f84819511bf6`; after report hash was `dba8e484b1b1f8a9c8c9586baa2490da31a49418e47d58a29545644fe67ad656`.

The exact original fixture objects and IDs were reused without seeding or truncation. Hardware, PG configuration, pool limits, one cold sample, 20 warm samples and concurrency two are unchanged. Owned browser/build/test processes and listening runtime services were stopped. The seven original operations produced 441 comparable route samples; a separately labelled deep-cursor operation added 63. All 504 samples had zero errors, blocked rows and cardinality failures. All 135 sampled EXPLAIN records were available. Unrelated host workloads remained; this is a local lab comparison, not a production SLO.

| Products | Operation                    | Cold ms | Warm p95 ms | App queries per response | JSON bytes p95 |
| -------: | ---------------------------- | ------: | ----------: | -----------------------: | -------------: |
|      500 | Catalog, 1 row               |     107 |          26 |                        5 |          1,717 |
|      500 | Catalog, 25 rows             |      85 |          45 |                        5 |         24,597 |
|      500 | Legacy deep catalog, 25 rows |      66 |          33 |                        5 |         24,586 |
|      500 | Exact SKU search             |      71 |          38 |                        4 |          1,419 |
|      500 | Name search                  |      66 |          38 |                        4 |         24,731 |
|      500 | Detail                       |      83 |          60 |                       19 |          2,950 |
|      500 | Ready quality                |     198 |          23 |                        6 |          1,445 |
|      500 | Separate deep cursor         |      57 |          38 |                        5 |         24,586 |
|    5,000 | Catalog, 1 row               |     367 |          57 |                        5 |          1,724 |
|    5,000 | Catalog, 25 rows             |      78 |          47 |                        5 |         24,599 |
|    5,000 | Legacy deep catalog, 25 rows |      77 |          49 |                        5 |         24,608 |
|    5,000 | Exact SKU search             |     339 |          58 |                        4 |          1,423 |
|    5,000 | Name search                  |      90 |          55 |                        4 |         24,763 |
|    5,000 | Detail                       |      64 |          53 |                       19 |          2,950 |
|    5,000 | Ready quality                |     161 |          41 |                        6 |          1,451 |
|    5,000 | Separate deep cursor         |      68 |          46 |                        5 |         24,608 |
|   20,000 | Catalog, 1 row               |     146 |         136 |                        5 |          1,723 |
|   20,000 | Catalog, 25 rows             |     188 |         183 |                        5 |         24,640 |
|   20,000 | Legacy deep catalog, 25 rows |     144 |         270 |                        5 |         24,647 |
|   20,000 | Exact SKU search             |     147 |         157 |                        4 |          1,427 |
|   20,000 | Name search                  |     166 |         137 |                        4 |         24,777 |
|   20,000 | Detail                       |      77 |          36 |                       19 |          2,950 |
|   20,000 | Ready quality                |     220 |          89 |                        6 |          1,456 |
|   20,000 | Separate deep cursor         |     173 |         123 |                        5 |         24,647 |

Catalog query count is now five for both one and 25 rows, versus six/78 before. Searches use four, versus six/78. The separate source-readiness PG contract observes four statements at 1/25/100 rows including BEGIN, workspace set_config, one owned snapshot SELECT and COMMIT; route app-query counts above exclude transaction controls. Cursor results matched the exact 25 ordered legacy-deep identities at every scale; cursor preparation and identity comparison ran outside sampled timings and their actual SQL/wall costs remain in the private report.

Quality cold timing in the table is the actual first response, not a completed whole-population assessment. It assessed 25 and reported 475/4,975/19,975 pending. Before warm sampling, the guarded bounded CLI performed real reconciliation for approximately 1.427s/18.614s/113.956s. The 20,000 cohort required one partial-command resume. Every warm sample subsequently observed the complete 500/5,000/20,000 assessed population with pending=0, failed=0 and unchanged actual known/unknown cost totals (zero in this synthetic cohort). These setup costs are not free, are not hidden in the steady-state p95, and must be budgeted before a production read cutover. Generation changes can create new pending work again. The report distinguishes reported callback batches from durable assessed progress at a cancellation boundary; final complete counters, not callback count alone, prove coverage.

Run command (explicit synthetic loopback app/admin URLs supplied by the private test environment):

```powershell
node scripts/benchmark-opak-maintenance.mjs --run --allow-local-db opak_fixes_perf_20261001 --sizes 500,5000,20000 --samples 20 --concurrency 2 --reuse node_modules/.opak-evidence/t10-baseline-full-for-e-v1.json --output node_modules/.opak-evidence/t10-after-e-v1.json
```

The private report retains query fingerprints, client wait, server EXPLAIN timing/node aggregates, cursor setup and backfill progress. It contains no SQL parameters, response contents or merchant data. Client wait includes pooling/network/decoding and is not pure DB execution time. A detail result at 500 items changed from 40ms to 60ms, still within target; the evidence does not claim every metric improved.

## Final supporting-index candidate: same-cohort v2

The complete remote integration gate found that the new quality table's live-listing composite FK lacked a supporting index. The existing exact inventory regression reproduced the failure; `0053_quality_projection.sql` now adds a full `(workspace_id, live_listing_id)` index. All 84 composite FKs then passed the unchanged index assertion, and actual quality PostgreSQL stayed 20/20. This is a measured integrity/maintenance correction, not a speculative catalog index.

Final measured source is `91e2dc01ec46164d964d912abf776e3b7410e96d`, freshly rebuilt in the isolated E checkout. Normal migration replay preserved all original fixture objects, imports, inputs, products, drafts and assessment generations. Before/after paired read-only child-FK EXPLAIN changed from a sequential scan (7.511ms, 4,010 buffer hits) to the new index (0.116ms, five hits/one read). That paired diagnostic is separate from route timings.

V2 reused the same original 500/5,000/20,000 cohorts, 20 warm samples, concurrency two and two-connection pools. All 504 samples (441 original plus 63 cursor) returned zero errors, blocked rows or cardinality failures; all 135 sampled EXPLAIN records were available. All 1,121 tracked source/config/test files and 711 compiled files stayed unchanged. Private report SHA-256: `4ce4461a8b3c41d09e8138e737d8bb7c6c9609eb400801db25382732c20ead9e`; comparison: `930a1a0cc24b7cd121bf8b0ac41b75b5f1c386f7e1e113cc8e83e4cd1d82b5df`. Earlier baseline/v1 reports remain immutable.

| Operation                    | 500 warm p95 ms | 5,000 warm p95 ms |         20,000 warm p95 ms |
| ---------------------------- | --------------: | ----------------: | -------------------------: |
| Catalog, one row             |          226.73 |            237.71 |                     314.69 |
| Catalog, 25 rows             |          359.30 |            693.41 |                     574.25 |
| Legacy deep catalog, 25 rows |          157.87 |            407.92 |                     547.90 |
| Exact SKU search             |          229.41 |            269.65 |                     280.82 |
| Name search                  |          463.07 |            418.37 |                     862.96 |
| Detail                       |          573.65 |            532.35 |                     707.69 |
| Ready quality                |          117.20 |            516.64 |                     442.11 |
| Separate deep cursor         |          138.58 |            163.02 | **1,272.35 (target miss)** |

All 18 applicable original-operation targets passed. The separate 20k cursor target is unresolved: its p95 request spent 1,229.40ms in summed client SQL waits, with the same five SQL fingerprints, identical ordered 25 rows and 24,647-byte response as v1. Post-group sampled plans totalled 163.82ms (v1 101.19ms), with unchanged node shapes and 5,470 hits/zero reads. The largest aggregate/count-shaped plan was 158.802ms, but post-group EXPLAIN does not identify which SQL caused the request's 1.2-second tail. Driver/pool/network/host/server-tail attribution remains unconfirmed; no speculative fix, assertion relaxation or blind rerun is used to turn this into a pass. Smaller cohorts and detail also regressed relative to v1; improvements at 20k do not imply every metric improved. HTTP/field INP remains unmeasured.

V2 cold quality was already READY at every scale. The unchanged harness's empty bounded preparation/cost snapshot took 150.65/433.30/800.74ms (11 SQL statements/one acknowledged batch each) and made no new assessments. These are not initial-population backfill timings. V1's actual pending cold response and 1.427/18.614/113.956-second initial backfill, including the 20k resume, remain the bootstrap evidence. Final physical checks show complete assessed populations, pending/failed zero, original source/header identities and zero actual AI runs/cost in this synthetic cohort.

The v2 command uses the earlier exact command with output `node_modules/.opak-evidence/t10-after-e-v2.json`. Source/dist manifests, migration/physical preservation proofs, complete cold/warm/query/wait/bytes tables and cursor digest comparisons stay in ignored evidence. Acceptance includes the explicit cursor miss; it must not be summarized as all performance targets passing.

## Quality semantics

Copy-gap signals, factual source evidence, current human confirmation and live delivery readiness are separate. Equal bilingual proper names are advisory wording checks. Absence of copy-gap signals does not establish factual correctness, approval, export eligibility or a store update.

Revision-aware quality counts exclude pending, failed and outdated contributions. The response exposes its assessment version, update time and incomplete work. Bounded reconciliation hydrates at most 25 current listings; it does not loop over all content on every GET. Tenant projection tables are derived observations and never authorize approval or delivery.

Known AI cost and unknown-cost references use the same current owned-run snapshot across retained listing history. A null cost remains unknown for started, failed and successful runs. Displayed references are bounded while the total remains complete; an exact batch binding links to batch reconciliation. A legacy run without that binding retains its real run ID and listing link for support. The listing may have a newer version. Batch archive does not erase historical costs.

Actual quality PG 20/20 and E read PG 25/25 cover bounded backfill/resume/deadline rollback, migration replay, real app-role isolation, generation concurrency, malformed rows and whole DB/permission failure propagation. The same-dataset comparison proves bounded-query improvements and retains the final cursor target miss. Authorized staging/production validation remains separate. Rollback retains projection metadata, audit, source/version history, accepted work and cost reservations.

See [AI acceptance](opak-ai-acceptance.md) for the explicit `audit-fixtures-v1` adapter and controlled human grading. Dry mode makes zero provider requests and reports `not_evaluated`; it is not AI accuracy evidence. Live AI, low-resolution image acceptance and real merchant comparison remain separately authorized gates.
