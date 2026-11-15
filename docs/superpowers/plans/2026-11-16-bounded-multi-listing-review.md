# Bounded multi-listing review — approved milestone plan

Approved 2026-11-16. Base: main `3b143d777e2ef90ea1b07e272adc79b822e71288` (actionable reviewer inbox shipped and verified).

## Outcome

An operator explicitly selects up to five listings and starts a review. For each selected listing the existing guided journey runs its two deterministic stages — workspace audit, then selected-listing gap review — in that listing's own Studio thread. Results appear per listing with exact artifact pins and honest per-item states; a failed listing never blocks the others. Copy proposals stay a separate explicit action inside each thread.

## Why this shape

The shipped guided journey is one listing per thread with exact source pins. Reusing it keeps that invariant, its UI and its audit trail. The batch is an **aggregation over existing records**, not a new workflow engine: no new tables, no queue, no scheduler, no background fan-out.

- Explicit initiation only: one operator click posts one request. No timers, retries in the background, or automatic runs.
- Deterministic only: audit and gap review make no model call and reserve no budget. Copy generation remains a manual send in the thread and remains the only paid step.
- Bounded: a hard cap of five listings, sequential processing, per-listing timeout/failure isolation.
- Read-only navigation: viewing selection, results or reloads never submits work.
- Privacy: every read and write goes through `db.forWorkspace(session.workspaceId)`; foreign or missing listings answer "unavailable", never existence.

## PR 1 — server batch and read model

- `STUDIO_REVIEW_BATCH_LIMIT = 5`; strict body `{ listingIds: uuid[] }` with unique ids and 1..5 entries; operator+ for start, viewer+ for reads; guided skill availability enforced exactly like the existing guided entry.
- `POST /api/studio/reviews` processes listings **sequentially**: resolve listing evidence, create its guided thread (title from the listing title, bounded), send the deterministic audit turn, then the gap-review turn pinned to the recorded audit revision/digest. Per-item outcome `complete | partial | failed` with a bounded failure code; one failed listing never aborts the batch.
- One summary audit event on the first created thread (bounded metadata: cap, counts, outcome codes). Each thread, message and run keeps its existing audit events.
- `GET /api/studio/reviews?listingIds=a,b` rebuilds per-listing state from existing records: newest recorded audit and gap output with exact revision/digest, so a reload or shared link reflects the database rather than client memory.
- Repository read model selects the newest guided version per listing/stage in one workspace-scoped query; no version payloads.

## PR 2 — operator surface

- `/studio/reviews`: searchable, paginated listing selection (existing listing page reads), explicit checkboxes capped at five with the cap stated, and a single "Start review" action.
- Per-listing result rows: state, exact audit/gap links, thread link, bounded failure reason. Failed items can be retried by selecting only those listings; partial results stay visible.
- Reload/shared-link reconstruction from `?listingIds=`; viewer role sees states read-only; English/Traditional Chinese copy; keyboard and 390px support; no client-side background requests.

## PR 3 — acceptance and release evidence

- Authenticated browser acceptance on the seeded fixture: select two listings, run the batch, assert two completed reviews with exact pins, thread links, reload reconstruction, unchanged canonical listings and zero model/paid activity.
- Failure isolation: a listing changed between selection and start, a foreign listing id, an unavailable listing, and the five-listing cap.
- Role/privacy: viewer cannot start; foreign ids never expose titles or artifacts; existing inbox/outputs behaviour unchanged.
- Release record with exact-head CI, matching production deployment/smoke and post-merge main CI, plus the updated roadmap.

## Boundaries

Frozen provider OpenCode Go / `deepseek-v4.1-flash`, USD10 cumulative workspace cap, USD2 run ceiling, 4096 output tokens. No new paid development calls, no production workspace activation, no external MCP or SHOPLINE write activation, no migrations, no scheduling, assignments, notifications, connectors or multi-listing copy generation. Merge only exact green heads after verifying deployed commits.
