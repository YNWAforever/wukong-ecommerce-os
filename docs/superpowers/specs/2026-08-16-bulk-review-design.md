# Bulk Review Design

**Date:** 2026-08-16
**Status:** Approved for implementation planning; source implementation has not started.

## Context

The roadmap named this follow-on "Bulk review UX (1c): batch-approve low-risk
field classes, keep per-item review for claims-bearing copy." Investigation
for this spec found that premise doesn't hold: **approval has no field-level
granularity anywhere in the domain model.** `approveListing`
(`packages/core/src/review.ts:6-40`) takes one `versionId` and flips one
listing's status; there is no schema, workflow, or API concept of "these
fields are approved, these are still pending" within a listing.
`review_events`/`editReview` record *which* fields an edit changed, but that's
a different concept from partial approval.

Building true field-level partial approval would mean new domain state
touching the schema, the workflow, and every review route — and there's
limited signal to build it on: of the four compliance rules the type system
declares (`health_claim | guarantee | rating_without_evidence | superlative`),
only two are actually detected (`compliance.ts:20-23`), every detected flag is
`blocking` severity (no `warning` flag is ever produced in practice), and
compliance scanning only ever runs over eight free-text fields
(`listing-pipeline.ts:208-221`) — everything else in `CanonicalListing` is
structurally exempt, not because it was graded low-risk, but because nothing
scans it.

This spec targets the narrower, buildable interpretation instead: **batch-
approve whole listings**, reusing the existing all-or-nothing `approve()`
unchanged. A reviewer selects several `in_review` listings with no open
blocking flags from the queue and approves them in one action. This is not a
new domain concept — it's the existing single-listing approval, called once
per selected listing, with new UI to select many and a bulk endpoint to avoid
one round trip per listing.

The domain term **bulk approve** will be recorded in `CONTEXT.md`.

## Goals

- Let a reviewer approve many eligible listings in one action instead of
  opening each one individually.
- Reuse `approveListing`/`repositories.listings.approve` exactly as built —
  no change to single-listing approval logic, no new domain state.
- Make eligibility visible before the reviewer commits to a selection: the
  queue must show which listings have an open blocking flag, since those are
  never bulk-approvable.
- Report partial success honestly. A batch of 20 where 3 have flags added
  since the queue last loaded must approve the other 17 and say exactly which
  3 failed and why — never silently skip, never abort the whole batch for one
  bad item.

## Non-goals

- No field-level or partial-within-a-listing approval. That's a separate,
  much larger feature — this spec explicitly does not build toward it.
- No change to the single-listing review screen (`/listings/[id]`) or its
  save/approve/flag-resolution logic.
- No change to which fields the review UI shows or edits. SEO/tags fields
  are absent from the review screen today; that gap is unrelated to this
  feature and out of scope here.
- No bulk *delivery* (CSV/publish). This is approval only — delivering many
  listings at once is a plausible, separate follow-on.
- No new compliance-flag severity tiers or detection rules. "Eligible for
  bulk approve" is defined by the flag data that already exists (`open` +
  `blocking`), not a new risk grading.

## Chosen design

### Eligibility: a listing qualifies when it has zero open blocking flags

An `in_review` listing is bulk-approvable exactly when
`complianceFlags` has no row for its active version with
`status = 'open' AND severity = 'blocking'` — the identical condition
`approveListing` already enforces one listing at a time
(`review.ts:12-20`). No new eligibility concept; this spec surfaces an
existing one that today is invisible until a reviewer opens the listing.

### Surfacing flag status in the queue

`GET /api/listings` (`createListListingsHandler`,
`apps/web/app/api/listings/route.ts`) calls
`repositories.listings.listRecent(100)`, which returns `ListingSummary`
(`Listing & { activeVersion: {id, content} | null }`) — no flag data.
Fetching flags per listing individually would be N+1; instead,
`listRecent` gains one additional joined query, batched across every
returned listing's active version:

```ts
const openBlockingCounts = await transaction
  .select({
    versionId: complianceFlags.listingVersionId,
    count: sql<number>`count(*)::int`,
  })
  .from(complianceFlags)
  .where(
    and(
      eq(complianceFlags.workspaceId, workspaceId),
      inArray(complianceFlags.listingVersionId, activeVersionIds),
      eq(complianceFlags.status, "open"),
      eq(complianceFlags.severity, "blocking"),
    ),
  )
  .groupBy(complianceFlags.listingVersionId);
```

`ListingSummary` gains `openBlockingFlagCount: number`. The queue API
response (`items[]` in `createListListingsHandler`) gains
`openBlockingFlagCount` per item; a listing is bulk-selectable exactly when
`status === "in_review" && openBlockingFlagCount === 0`.

### The bulk-approve endpoint

`POST /api/listings/bulk-approve`, body `{ listingIds: string[] }` (1–50
UUIDs — the plan will justify and enforce this bound). Same role gate as
single approval (`reviewer`/`admin`/`owner`).

**Each listing is approved in its own transaction, not one transaction for
the whole batch.** A batch is inherently a best-effort operation over
independent items; wrapping all of them in one transaction would mean one
listing's stale flag rolls back seventeen legitimate approvals. This mirrors
`createApproveListingHandler`'s own per-listing `forWorkspace` call exactly —
the bulk handler loops that same logic, one call per ID:

```ts
const results: BulkApproveItemResult[] = [];
for (const id of listingIds) {
  try {
    const result = await deps.getDatabase().forWorkspace(
      session.workspaceId,
      (repositories) => approveOne(id, session, repositories),
    );
    results.push({ listingId: id, ok: true, versionId: result.versionId });
  } catch (error) {
    results.push({
      listingId: id,
      ok: false,
      code: codeFor(error),
      message: messageFor(error),
    });
  }
}
```

`approveOne` is `createApproveListingHandler`'s existing inner logic (lines
38–62 of `approve/route.ts` today), extracted into a shared function both
routes call — not duplicated. This is the one real refactor this spec makes
to existing code, and it's mechanical: lift the closure body out, parameterize
on `id`, keep every check (`requireForPublish`, target/activeVersion check,
`approveListing`, `repositories.listings.approve`, the `blocking_flags`
error mapping) byte-identical.

Response: `200` with
`{ results: BulkApproveItemResult[], approved: number, failed: number }`.
Never a single failure status for the whole request — a client that sent 20
IDs and got 17 approvals and 3 failures gets a `200` describing exactly that,
not a `4xx`/`5xx` that would misrepresent 17 real successes as a failed
request.

**Sequential, not concurrent.** Each `forWorkspace` call opens its own
Postgres connection from the pool; running them concurrently for a
20–50-item batch would briefly hold that many connections at once for no
real benefit (a single-listing approval is a handful of small queries, not
an AI call — the sequential loop for 50 listings is expected to complete in
low hundreds of milliseconds). Sequential also keeps the audit trail's
`created_at` ordering meaningful or the batch's provenance, unlike the
transaction-frozen-`now()` problem the audit-verify fix documented — that
issue was about ONE transaction giving many rows the same timestamp, and
sequential separate transactions here avoid it the same way.

No new audit action. Each successful item already writes its own
`listing.approved` event via the reused `approveOne` — that's the correct,
existing per-listing audit record. This spec does not add a
`listing.bulk_approved` batch-level event: the batch is a UI/API convenience
over N real, individually-audited approvals, not a new kind of domain
mutation in its own right.

### Multi-select UI

`ListingQueue` (`apps/web/components/listing-queue.tsx`) gains a checkbox
per listing row, shown only for `in_review` items, disabled with a tooltip
(`"3 個未解決的合規標記" / "3 unresolved compliance flags"`) when
`openBlockingFlagCount > 0`. A "select all eligible" control at the top of
the `in_review` group selects every checkbox-enabled row in that group only
— it never reaches into other status groups.

A bulk action bar appears when the selection is non-empty: selected count,
"Approve N listings" button, "Clear selection." Confirming calls
`POST /api/listings/bulk-approve`; the response renders as a per-item
result list (checkmarks for `ok: true`, the failure code/message for
`ok: false`), and the queue refetches afterward so approved listings move
out of the `in_review` group without a page reload.

This is new UI infrastructure — the codebase's only other "batch" concept
(enrichment batches) is criteria-based batch creation with no UI at all, not
a select-many-act-once pattern. Nothing existing to extend; this is the
queue's first checkbox.

## Consequences

- A reviewer clearing a backlog of flag-free listings does it in one action
  instead of N page loads, N button clicks.
- The queue becomes the first place flag status is visible without opening a
  listing — a smaller, standalone improvement independent of bulk-approve
  itself.
- `approveOne`'s extraction is the only touch to existing single-listing
  approval code, and it's refactor-only: behavior for `POST
  /api/listings/[id]/approve` must be identical before and after, which the
  plan verifies by running that route's existing tests unchanged against the
  extracted function.

## Follow-ups

1. Field-level partial approval (the roadmap note's literal reading) — a
   separate, larger spec, informed by whichever compliance rules end up
   actually implemented by then.
2. Bulk delivery (CSV/publish many approved listings at once).
3. Surfacing flag *reasons*, not just counts, in the queue — an operator
   deciding whether to open a flagged listing today only sees "0 vs
   nonzero"; the rule/field a flag concerns is only visible after opening it.

## Open questions

1. Is 50 the right per-request cap on `listingIds`? Chosen to keep a
   worst-case sequential loop comfortably sub-second; the real pilot catalog
   size (500 products) may argue for a higher cap or a client-side chunking
   pattern that calls the endpoint multiple times. The plan should not treat
   50 as load-bearing beyond "a reasonable starting bound," and the runbook
   should say so.
2. Should "select all eligible" have an upper bound distinct from the API
   cap, so a reviewer clicking it on a 300-item `in_review` group gets a
   clear "select the first 50" message rather than a silently-truncated
   selection? Not designed here; the plan should pick one.
