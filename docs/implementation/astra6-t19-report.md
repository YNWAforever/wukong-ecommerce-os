# T19 batch lifecycle and recovery evidence

Date: 2026-09-16. Branch: `codex/astra6-recovery`; uncommitted implementation on audit base `63a6f762` plus the preceding recovery work. No deployment or paid/provider/SHOPLINE call.

## Implemented contracts

- Migration 0036 adds batch `control_revision`, durable idempotent command receipts, retry item parent IDs and current-membership flags. Older items/runs/reservations remain immutable history. A partial unique index retains one current item per batch/listing. Migration 0034 accepts the additive cancelled outcome because this repository replays every SQL migration on each migrate call.
- Advance requires a UUID idempotency key and expected control revision at the HTTP boundary; response is 202 with accepted run IDs and revision. Admission, run acceptance, reservation, outbox and command receipt share a transaction/row lock. Replaying a lost response does not claim the next wave. Immediate dispatch failure retains the accepted identities and reports `dispatchPending`; the existing outbox/sweeper recovers them.
- Operator-only `POST /api/enrichment-batches/:id/control` implements pause, resume, cancel and retry_selected. Workspace/actor always come from the session. Controls are audited and use compare-and-swap; a competing stale command returns 409.
- Pause stops new admission and suppresses pending outbox recovery for that batch. Already accepted/sent work may finish. Resume preserves run identity and membership. Cancellation locks the same listing rows as adoption, marks only the batch's active bound runs cancelled, and stops pending items. Another manual run on the listing is not cancelled. A message already racing the cancellation can reach the queue, but the worker terminal fence prevents a new call/adoption. Physical invocation admission now takes the same listing lock before checking the run and recording its call identity, serializing that decision with cancellation.
- Cancellation retains uncertain holds as unknown; it does not infer a refund from an unsent timestamp or missing acknowledgement. Late candidates are retained and cannot replace current content. Settled and held cost remains attributable across retry history.
- Retry-selected accepts at most five unique current terminal items with bound runs. It creates new item and run lineage against the current saved input/base revision, reserves new spend and writes the same durable outbox. Invalid selection, concurrent manual processing, revision changes or budget rejection roll back the entire retry selection.
- Detail UI displays exact outcomes/run IDs and historical attempts, pause/resume/cancel, bounded retry selection, cost/holds and a support action for dispatch exhaustion. Running item counts refresh every three seconds while the document is visible. Network retry of a control preserves its idempotency key.

## Local verification

Disposable database: `localhost:54329/t01_compatibility`; fixtures use unique `batch-controls-<uuid>` workspace IDs. No truncate/drop or merchant data was used.

| Evidence                                   | Result                                                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB exact-run + 50-item control integration | 2 files, 4 tests passed                                                                                                                                                                       |
| 50-item outcome accounting                 | 5 this-run successes, 5 needs_input, 15 failed, 5 source/input superseded, 20 cancelled                                                                                                       |
| Admission/control races                    | One of two same-revision pause commands succeeds; duplicate Advance replays the original five IDs; paused Advance admits zero                                                                 |
| Recovery                                   | Synthetic immediate dispatch failure retains five accepted outbox records; resume dispatches them; abandoned running attempts and exhausted dispatch attempts become explicit failed outcomes |
| Cancellation                               | Bound queued/running attempts fenced; a newer independent manual operation remains queued; late candidate retained, terminal state cannot become succeeded                                    |
| Retry/cost                                 | New item/run uses revised input revision 2, old attempt remains; 50 current members / 51 total attempts; USD 1.00 of unknown holds remains attributed                                         |
| Web affected regression suite              | 8 files / 70 tests passed                                                                                                                                                                     |
| Worker immutable operation suite           | 2 files / 14 tests passed, including terminal cancelled no-provider-call, late cancelled candidate/no-adoption, and physical-call admission observing cancellation under the listing lock     |
| Typechecks                                 | DB and web passed after the final lifecycle changes (parent performs combined full checks)                                                                                                    |

## Evidence boundaries and release status

| Requirement                        | Specified | Implemented      | Locally verified                                         | Preview verified | Production verified | Merchant accepted |
| ---------------------------------- | --------- | ---------------- | -------------------------------------------------------- | ---------------- | ------------------- | ----------------- |
| Pause/resume/cancel/retry selected | Yes       | Yes              | DB/API/component/worker tests                            | No               | No                  | No                |
| Exact membership and spend lineage | Yes       | Yes              | Isolated 50-item DB cohort                               | No               | No                  | No                |
| A33 / G4 full operational cohort   | Yes       | Partial evidence | Controlled DB outcomes and selected worker failure tests | No               | No                  | No                |

The 50-item test deliberately changes persisted run states to exercise reconciliation/recovery; it is not 50 full fake-provider queue executions. It does not prove a process kill during a provider call, stolen/stale lease with a late external response, DLQ delivery/alert transport, real image/source semantics, provider billing, throughput, browser end-to-end lifecycle usability or elapsed merchant operation. **G4 remains unpassed** until those operational scenarios are run with the real local/preview worker/queue harness and evidence recorded. The source change case edits persisted input facts, not an uploaded image asset. Notes-only and empty-input fixtures establish membership and revision wiring, not AI extraction quality.

## Rollback/recovery

Keep 0036 and its additive data when rolling back application code; do not delete retry history or recreate the old unconditional membership uniqueness constraint after retries exist. Pause admission before changing web/worker versions. New web Advance clients require revision/idempotency payloads, so deploy compatible UI/API together. Cancelled runs remain terminal and may retain unknown costs requiring finance/provider reconciliation. Recovery of accepted unsent work must reuse its existing outbox/run; explicit retry creates a new attempt and new spend.

## Additional real-consumer cohort

The parent subsequently added `tests/integration/recovery-cohort.integration.test.ts`: 50 accepted batch operations execute through the actual consumer and PostgreSQL repositories with controlled fake-provider callbacks. All 50 duplicate messages make no extra AI calls. Outcomes are 10 usable versions, 10 partial needs-input results, 10 terminal provider failures, 10 superseded results after saved corrections, and 10 cancellations during generation. Completed candidates remain inspectable and stale results never become current. All terminal operations have no running steps. The complete isolated integration suite subsequently passed 376 tests, including this cohort.

Exact IDs, call counts and capture time are in `evidence/astra6/t19-consumer-cohort.json`. This adds consumer execution evidence to the earlier controlled-state DB cohort. Queue transport is still in-memory; physical process-kill, remote DLQ and alert transport acceptance remain unverified. G4 is not declared passed.
