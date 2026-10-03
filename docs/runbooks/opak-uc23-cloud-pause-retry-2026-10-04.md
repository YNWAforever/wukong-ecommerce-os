# UC23 remote pause and failed-only retry — 2026-10-04 HKT

The original UC23 cloud fault criterion passed on the real isolated Queue and normal Web controls. Four initial durable runs produced three successes and one known failure, with the fifth product still unadmitted. Pause returned202; paused advance admitted zero runs and paused retry returned409 without changing run values. The same batch then resumed, retried exactly its one failed item, and separately admitted the remaining pending item. Final state: five current successes, six total runs including the historical failure, zero pending/queued work. Completion phase passed30/30 in189.058s.

Execution source593c5283 / guarded Webc23e0e4 / Workerfcf96cda is deliberately recorded separately from the later Web-only label fix and evidence head. [Allowlisted receipt](./opak-uc23-cloud-pause-retry-2026-10-04.json) preserves actual phases, failures, watches, checks and hold readback.

## Findings and limits

- The temporary fake-provider fault was restricted to one owned workspace/run/draft/source with an eight-minute deadline; normal consumer/lifecycle/leases/audit/cost machinery handled the failure. Known provider-unavailable is retryable. An earlier invalid-output fault correctly required support; its policy was retained. No natural Cloudflare retry-exhaustion or paid-response-loss acceptance is claimed.
- V5's Resume409 was correct CAS protection: an additional paused advance moved the control revision before the stale UI click. Refreshing that same paused batch made normal Resume202; no control fence was relaxed.
- Initial Web dispatch acknowledgement0 and the helper's incorrect Hyperdrive proxy identity assumption remain failed evidence. Resource-origin preflight and live non-bypass SQL identity stayed mandatory. The isolated proxy-shape helper regression went RED1 to GREEN15; no unique production500 root cause is inferred.
- ST27/T06 is reproduced: the paused screenshot rendered Unknown status / 狀態未明 while Resume remained usable. The shared state dictionary omitted paused. A minimal bilingual label entry and two rendered-detail regressions repair that presentation defect. RED2/11 → GREEN17/17 across three focused files. Full root test14/14 tasks, Web2,285/230 files;13 tasks cached. Lint14/14, typecheck14/14 and build8/8 passed; format329 files, forbidden runtime0 and six automated release checks passed. Fourteen human checks remain separate. A new exact Web preview and candidate CI are pending at this precommit checkpoint.

## Retained behavior

Exactly one attempt2 links to the original failure, frozen input and input revision. Same-idempotency replay creates no duplicate run. The three original successful run values and AI ledger rows remain identical; all earlier workspace runs/AI rows remain identical. The five current versions preserve manual locked/unselected facts and commercial fields; the selected English summary is populated. Original source cells remain immutable. Eleven scoped fake ledger entries have known cost0; no publish job, paid AI, email or real SHOPLINE call. Canonical JSON comparison checks values, not incidental object-key ordering.

Only three distinct five-item synthetic imports were made across preparation trials. Resumes reused existing imports/batches/outbox operation IDs. Earlier invalid-output/support failures and terminal successes remain retained; their unstarted items were cancelled through the normal service. No lifecycle rewrite, purge, customer import or hidden list truncation.

## Verification and recovery

- Local commands: node --test fault-scope.test.mjs15/15; Worker listing-operation/listing-consumer/queue-consumer34/34; Web service/control/batch-controls38/38; Web control/advance/batch-controls7/7 (overlaps prior selection); DB item-recovery1/1. Receipt lists exact commands. These are separate from the30 actual cloud checks.
- Eleven resource windows have normal watchdog stops and all cleanup acknowledgements. Latest21:35:34Z readback: reviewedfcf100%, no temporary probe variables, public HEAD404, staging compute disabled/idle max0.25CU. Queue pause/cron metadata remains command acknowledgements only; normal CLI cannot independently read those flags. Actual billing is not measured.
- No migration, app env, dependency or credential change. Restore the reviewedfcf Worker and guarded compatible Web; retain sources, versions, run lineage, audit, ledger, artifacts and all failed receipts. Do not restore the prior broad R2 credential or older native-GET authentication source; do not purge or reset statuses.

Cloud matrix now13PASS/4PARTIAL/13BLOCKED/all30; only UC23 changes in this checkpoint. UC03/06/24/29 remain partial. Paid/human UC09–20 and cloud load/employee UC30 remain blocked. Production additive0046 authority, safe runtime role/cache, effective Web DB/original authenticated500 and named recovery owner/confirmed recoverable point remain open. Main auto-deploy merge is held; first real SHOPLINE write and5→20→100 merchant pilot need their separate gates.
