# Opak UC30 synthetic cloud performance —2026-10-04

Actual protected staging HTTP completed504samples across500/5,000/20,000dedicated synthetic workspaces: one first-observed response plus20warm responses per operation, warm concurrency2. There were0HTTP/cardinality/blocked-row errors; 20/21configured warm targets passed. Quality has no configured p95 target. UC30 advances from blocked to partial: legacy20k deep p95 misses its target and human20-item minutes/acceptance remain unmeasured. Cloud matrix is15PASS/3PARTIAL/12BLOCKED/all30; no full-release or production500 closure is claimed.

Full-population cardinality, normal authorization, current cursor identity and retained-domain behavior are already-fixed within this measured scope. Finding F09 performance is changed/reproduced at cloud scope: legacy20k deep p95 remains827.78ms against800ms, with cause unconfirmed. It remains an open release gate; no speculative index/code rewrite or blind rerun replaces the failed measurement. This batch adds evidence and a [human timing procedure](./opak-human-efficiency.md)/[blank20-row template](./opak-human-efficiency-template.csv); it changes no application code, schema, env, credential or runtime deployment. [Safe JSON receipt](./opak-uc30-cloud-performance-2026-10-04.json) retains sample summaries, ordered cursor digests, preparation costs and domain fingerprints.

## Exact runtime and fixture scope

Web2b8d77be01ee1c9ae1a2e1bba1d1f41fcecd07b5 / dpl_J3hvtmygPraTyp2XakUM9k2TXXH6 / iad1 / standard Fluid; application source5f9eddbae1f394234dbfc2f2793a8eddde5685dc. Reviewed Workerfcf96cda-1054-4fdb-8ba0-0e002294c466 remains held, source593c5283bac242fc171850ee6358f2e9ccc77a1b. Neon small-fire-41282929 / br-fragrant-sky-b8p8ns7a / ep-hidden-meadow-b8gvbtoo / opak_stage, max0.25CU. Normal password login, server operator identity and normal workspace selection200 were verified in every HTTP window; no session/role bypass.

Preparation8/8 in280.370seconds created25,500products in three new isolated workspaces, using the same synthetic field generator as the retained local benchmark. Physical product/draft/input counts equal each exact full scale; app role is non-superuser/non-bypass. Only controlled workspace/membership fixture setup uses the staging provisioner. Product rows use app-role workspace transactions. No real import/merchant origin, approval, generation, queue, provider or delivery is claimed by seeding.

The original staging workspace's ten listed domain-table fingerprints—including UC24 AI runs/pipeline/reservations/batches—are identical before/after every executed window. Simulated knownUS$0.05 and unknownUS$0.05 hold remain protected. Each target cohort's source/products/drafts/input/AI/reservation/batch fingerprints are unchanged by measured reads. Quality projections/cost snapshots legitimately advance outside these domain hashes; this is not a whole-database/no-auth-change claim.

## Actual deployed HTTP warm p95 milliseconds

| Operation              |    500 |  5,000 | 20,000 |    Target ms |
| ---------------------- | -----: | -----: | -----: | -----------: |
| catalog-1              | 718.23 | 714.05 | 772.60 |          800 |
| catalog-25             | 686.32 | 698.84 | 722.56 |          800 |
| catalog-deep-25        | 705.10 | 715.65 | 827.78 |          800 |
| search-sku             | 725.31 | 780.60 | 882.97 |         1000 |
| search-name            | 669.11 | 718.52 | 893.12 |         1000 |
| detail                 | 692.02 | 732.76 | 711.28 |         1500 |
| quality                | 669.55 | 749.17 | 753.58 | unconfigured |
| catalog-cursor-deep-25 | 688.04 | 671.63 | 750.51 |          800 |

Each operation has21actual responses; expected page cardinality/totalMatching and zero blocked rows were checked for every catalog/search sample. Detail returns the exact owned listing. Each deep cursor is the actual server token, with25ordered sourceType/id tuples equal to the legacy deep page at each scale, including the20,000population. No recent5,000-only fallback or implicit reseed is used.

Quality first requires a complete ready population, pending0/failed0 and separate owned cost0/unknown0 in these new workspaces. Actual normal API reconciliation is bounded25per request and runs outside steady-state measurements.500/5,000 bootstrap takes15.732/162.617seconds for20/200requests.20,000uses two retained320-request chunks plus160final requests; partial progress is retained, never labelled ready. Their actual elapsed/progress checkpoints are in the receipt. The slow initial preparation is not hidden in warm p95.

First-observed HTTP timings are reported separately in JSON. They do not prove cold server/pool/cache or a flushed database: login/preparation and shared provider caches may already warm services. This Windows/HK→iad1 measurement includes network/session/server/body transport. It does not infer pure DB time, query counts, EXPLAIN, CPU or field INP. Existing [local before/after query/EXPLAIN/cold-pool evidence](./opak-performance-quality.md), including v2's cursor miss and three local regressions, remains separate. Different fixture IDs/cloud host mean no matched cloud before/after improvement claim.

## Separate read-only cloud SQL diagnosis

A single diagnostic sample per catalog mode uses the same current route factory and existing20k cohort under the non-superuser/non-bypass app role. It injects a synthetic operator session port and connects directly from Windows/HK; it is not deployed HTTP/auth proof. Explicit probe-session and factory-transaction READ ONLY guards prevent business writes. Complete25/20k cardinality and cursor identity, plus original/target ten-table fingerprints, stayed unchanged.

| Mode           | Application queries | Client wait ms | Later unique-plan server sum ms | Unique captured plans |
| -------------- | ------------------: | -------------: | ------------------------------: | --------------------: |
| catalog-25     |                   5 |        2917.88 |                           82.93 |                     4 |
| legacy-deep-25 |                   5 |        3079.78 |                           96.92 |                     4 |
| cursor-deep-25 |                   5 |        3677.68 |                           70.57 |                     4 |

All three modes use five application queries and four unique captured fingerprints; there is no per-row query growth in this probe. Each later EXPLAIN executes one unique fingerprint once; its summed server time excludes repeated fingerprint executions and is not total route server time. Transaction controls, including the additional diagnostic READ ONLY statement, are separately counted. Client wait includes remote network/pool/decoding. The12actual EXPLAIN ANALYZE records are post-operation measurements under workspace/RLS and15-second statement limits; only fingerprints/node aggregates/times/counts are retained, without SQL parameters/full plans/row contents. These one-sample measurements do not uniquely explain the deployed827.78ms tail, prove a missing-index cause, show a matched improvement or satisfy its800ms gate. The original miss remains unchanged; next attribution needs controlled server-stage timings on the same candidate.

## Commands, failures and finite stops

Private harnesses stay outside Git/customer data. Commands: node uc30-prepare-v2/run.mjs; node uc30-quality-20000-v1/run.mjs 20000; node uc30-quality-20000-v2/run.mjs 20000; node uc30-http-500-v1/run.mjs 500; node uc30-http-5000-v1/run.mjs 5000; node uc30-http-20000-v2/run.mjs 20000; separate node uc30-sql-diagnosis-v2/run.mjs. Each uses the existing exact staging identity/URL guards, a390-second work deadline,30-second sampled request ceiling,1MiB response ceiling, finite preparation/sample counts and independent8-minute Worker-hold watchdog. The20k HTTP and SQL diagnostic use authenticated connector orchestration with independent430/240-second compute stops and a final disabled readback; no credential file/key is created, read or changed by those controllers. Native login/server selection/revocation, cardinality, cursor equality, domain hashes and normal stop are actual checks. Existing node --test tests/benchmark-opak-maintenance.test.mjs passed23/23 with0skip/0provider calls.

All successful windows acknowledge logout200/account401, both queue holds, closed ingress/cron and disabled-idle0.25CU compute; watchdogs stop normally with no emergency. Queue pause/cron state remains command-acknowledgement-only because independent provider readback is unavailable. Final candidate/compute readback, exact new CI/PR checks and archive are separate terminal receipts.

Retained failures: initial private snapshot helper used the nonexistent pipeline_runs table and stopped before creating fixture rows, all four holds acknowledged; its table literal was corrected from the current schema. Initial builder ESM/template syntax errors occurred before provider calls. Two Neon CLI query attempts failed on Windows shell quoting; correctly scoped Node CLI then reports consumption history unavailable on Free. Vercel connector404 and CLI JSONL decoding failed; failed intermediate zeros are not billing observations. Documented authenticated directGET succeeded. The original20k HTTPv1 failed Neon CLI DEFAULT authentication before enable/login/sample; the authenticated connector then completedv2 under independent bounded compute control. The CLI login remains expired, not silently replaced. SQL diagnosticv1 refused to run catalog/EXPLAIN because default_transaction_read_only was actually off despite the supplied connection option; v2 verifies explicit SET session on and guards each factory transaction READ ONLY. Both failed windows retain acknowledged holds. None of these helper/provider failures establishes a product500 root cause, passing UAT or zero bill.

## Cloud budget and remaining release gates

Vercel reported Wukong project billedUS$1.419122 at2026-10-04T05:39:32.749Z, for the stated UTC date range; it includes production and other previews, and can lag. This is a conservative shared-project observation, not isolated-deployment attribution or a final all-provider invoice. [FOCUS charges API](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges) exposes project tags; [Neon pricing](https://neon.com/pricing) and [consumption API](https://api-docs.neon.tech/reference/getconsumptionhistoryperprojectv2) explain the observed Free-plan metric limitation. The standing cap remainsUS$5. No new compute size, subscription, paid AI, deployment, R2/queue business operation or email is enabled by these runs. Do not report unmeasured provider totals as zero; refresh before additional spend/deployment.

Production0046/safe-role/cache/effective Web/original authenticated500, exact repair authority/named recovery owner/confirmed recoverable point, paid-human UC09–20, employee20-item evidence and separate first real SHOPLINE/reconciled5→20→100 gates remain open. Conditional main auto-deploy merge remains held. No production mutation, migration, true provider call, merchant result or pilot expansion occurred.

Rollback/hold preserves all synthetic fixtures and projection progress as evidence and retains the reviewed Web/Worker, readonly R2/native POST/mail guard, sources/inputs/versions/approvals/audits/artifacts/cost lineage/queues/DLQs. Stop new admission/advance and hold compute; no reset, purge, destructive downmigration, unknown retry or zero-cost reconciliation. This evidence release needs no new migration/env name. Customer ZIP, workbooks/private mappings/config/auth/share URLs/raw errors/prompts/model outputs are excluded from Git and the public PR.
