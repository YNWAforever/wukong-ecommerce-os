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

## Delivery record (2026-11-16)

PR #230 shipped the server batch and read model: `STUDIO_REVIEW_BATCH_LIMIT = 5`, strict
`{ listingIds }` body, operator floor plus the existing guided-skill gate, sequential per-listing
thread + deterministic audit turn + gap turn pinned to the recorded audit, per-item
`complete | partial | failed` with bounded failure codes, one summary audit event, and
`GET /api/studio/reviews?listingIds=` reconstruction from the newest recorded guided versions in one
workspace-scoped query. Head `8f44a65f2b0958fdba4399bf2cc07b089c43ab03`, merge
`38e403b7ca2a78957f49f951cee8c7d9d99f4f30`; PR CI 43751958877 and post-merge main CI 43753867060
passed, including real PostgreSQL/RLS, audit, browser and build gates. The production deployment for
that merge reported success at `https://wukong-ecommerce-fm2pl0d5p-ynwaforevers-projects.vercel.app`;
the production alias served the root-to-sign-in redirect, `/signin` 200, `/api/studio/settings` 401 and
`/api/studio/reviews` 401. No schema migration, queue, scheduler, model call, budget reservation or
canonical listing write is introduced.

PR #231 shipped the operator surface at `/studio/reviews`: searchable/paginated listing selection,
checkboxes capped at five with the cap stated, one explicit **Start review**, per-listing result rows
with bounded failure copy, exact audit/gap links, thread links, failed-item retry and viewer read-only
gating. Reloads and shared `?listingIds=` links rebuild state from the database. Head
`eb9cad9657c2e08a835024b2095ca39dccf9d388`, merge `e46e8ba0199a020f1776b7488f2124797c5b0331`; PR CI
43753901445 and post-merge main CI 43755853846 passed. The production deployment for that merge
(`https://wukong-ecommerce-3jdk96ysg-ynwaforevers-projects.vercel.app`) reported success and the same
alias probes passed. The full local `@wukong/web` unit suite passed (3,239 checks across 315 files),
alongside the Studio-focused batch, page, component, shell and copy checks.

The release PR #232 adds the authenticated browser acceptance and release evidence: the fixture now
seeds a second ordinary listing and a foreign-workspace listing, and the new spec selects both
in-workspace listings, runs one batch, verifies two distinct threads with exact audit/gap
revisions + digests, `model: null` / `reservedUsd: null` for every recorded run, zero message posts
from the page, reload reconstruction, byte-identical canonical listings, foreign/missing ids answered
as unavailable without titles or artifacts, cap/duplicate/extra-key rejections, viewer 403 with a
disabled control, and a readable 390px Traditional Chinese result page. CI run 43755909375 on head
`ba59533639582dc9bc5cf7efc3083a9a6dc4f48d` passed the Studio browser acceptance and uploaded the new
screenshots. The exact-head, merge, post-merge main CI and production evidence for the release merge
itself is recorded in the PR body. A listing that changes after selection but before start is simply
reviewed at the version read when the batch starts (results pin that version); a change during the
batch returns `listing_changed` and keeps the listing's thread, which the PR 1 service tests cover.

## Boundaries

Frozen provider OpenCode Go / `deepseek-v4.1-flash`, USD10 cumulative workspace cap, USD2 run ceiling, 4096 output tokens. No new paid development calls, no production workspace activation, no external MCP or SHOPLINE write activation, no migrations, no scheduling, assignments, notifications, connectors or multi-listing copy generation. Merge only exact green heads after verifying deployed commits.
