# W7 — Approval invalidation visibility

Date: 2026-09-14 · Branch: `codex/listing-grounding-diagnosis` · Closure plan item: W7 (Package G observability)

## Problem

An approval can stop holding in two ways, and neither is visible as such:

1. **Confirmation change.** `invalidateApprovalForConfirmationChange`
   (`packages/db/src/repositories/listings.ts:754`) reopens an approved, published or
   publish-failed listing. The only record is the generic `listing.transition`, shown as
   "Status changed". The queue (`dashboard-queue-shared.ts:27`) and review page
   (`listing-review-client.tsx:212`) then show `reopened` as `in_review`.
2. **Re-import.** Every re-import creates a new `sourceImportId`. The approval receipt binds
   the import it was approved against (`bulk-update-eligibility.ts:210`), and the confirmation
   binds it too (`:190`). So any re-import, even with an unchanged row, makes an approved
   listing ineligible for export. The importer (`apps/web/lib/bulk-form-import.ts`) records no
   event for this and leaves the status at `approved`. Receipts are minted only by the
   `approve` transition, so recovery requires reopen → submit → approve.

/jobs and /quality show neither.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Scope | Both paths become visible events; a re-import records the event at that moment |
| Which re-imports | Every re-import of an affected listing; cause distinguishes changed and unchanged rows |
| Status on re-import | Record only; status is not changed |
| Approach | One audit action, surfaced in activity, /jobs tiles and the import panel; no migration |

## Design

### 1. The event

New audit action `listing.approval_invalidated`, `entityId` = listing id. Metadata is
identifiers only (no digests, no content):

- `cause`: `"confirmation_changed" | "source_reimported_changed" | "source_reimported_unchanged"`
- `fromStatus`: the listing's status when invalidated
- `versionId`: the active version whose approval no longer holds
- `sourceImportId`: the current import (re-import causes only)
- `priorSourceImportId`: the link's previous import (re-import causes only)

### 2. Write sites

**Confirmation change.** `invalidateApprovalForConfirmationChange` writes the event on its
`"reopened"` branch, after the existing `transitionListing` audit record and in the same
transaction. `stale`, `publishing` and `unchanged` outcomes write nothing. Status behaviour is
unchanged.

**Re-import.** Before the row loop, the importer calls a new narrow read,
`listings.approvalStatesByIds(ids)`, which returns `Record<id, { status, activeVersionId }>` and
is workspace-scoped. It sits beside the existing `statusesByIds`, which omits `activeVersionId`
(needed for the event's `versionId`). `getByIds` is not reused because it loads version content.
For each row whose
existing listing's status is `approved`, `published`, `publish_failed` or `publishing`, the
importer writes the event. The cause comes from the existing `isRefresh` flag:
`source_reimported_changed` if true, else `source_reimported_unchanged`. `publishing` is included
because there is no transition to refuse, and a publish running under a stale approval must not
go unseen. Listing status is never written. A linked listing absent from the read (for example
deleted) gets no event and no error.

**Aggregate.** `listing.bulk_form_import_completed` metadata and `BulkFormImportResult` both gain
`invalidatedApprovals: number`.

**Concurrency.** Statuses are read in the import transaction's snapshot. A listing approved
concurrently after that read gets no event. Its receipt binds an older import, so the next
re-import records it. This is accepted and documented, not locked against, to keep per-row
review locks out of bulk import.

### 3. Surfaces

- **Activity panel** (`activity-panel.tsx`):
  - Label `listing.approval_invalidated` → "批准已失效 / Approval invalidated".
  - A cause line:
    - `confirmation_changed` → "確認內容已變更 / Confirmations changed"
    - `source_reimported_changed` → "重新匯入，來源資料已變更 / Re-imported with changed source row"
    - `source_reimported_unchanged` → "重新匯入，來源資料未變 / Re-imported, row unchanged"
  - The `listing.transition` line remains.
- **/jobs** (`app/api/jobs/route.ts`, `jobs-ledger-client.tsx`):
  - One `countByActionAndMetadataKeySince("listing.approval_invalidated", "cause", since)`.
  - The response gains `metrics.approvalInvalidations: { confirmationChanged, reimportChanged, reimportUnchanged }`.
  - Two new 30-day tiles:
    - "Approvals invalidated by confirmation"
    - "Approvals invalidated by re-import" (changed + unchanged)
  - An unknown `cause` is counted in no tile and logged as `jobs.unknown_invalidation_cause` with the value only.
  - The ledger UNION is unchanged.
- **/quality:** unchanged. It measures content quality; invalidation is operational and lives on
  /jobs. The closure plan's Package G wording is amended to match.
- **Import panel** (`bulk-import-panel.tsx`): when `invalidatedApprovals > 0`, the success line
  adds "Approvals invalidated: N" and the guidance that those listings need renewed approval
  before export. The copy is bilingual via `t(...)`.
- **Review page:** `reviewStatus` no longer maps `reopened` → `in_review`.
  `ListingReviewModel["status"]` adds `"reopened"`, and the header's `stateLabel` renders "Reopened".
- **Queue:** `QueueItem` gains an optional `reopened?: boolean`, always set by
  `mapDashboardItems`, which renders a "Reopened" tag. The dashboard teaser shows the same tag.
  Items stay in the "Needs review" group. `QueueStatus`, `queueGroups`, bulk-approve and the
  dashboard counts are unchanged.
- An approved listing invalidated by a re-import keeps status `approved`. The existing catalog
  source-readiness label continues to show its reason.

### 4. Not changed

- `transitionListing` and the state machine
- The eligibility checks
- The approval receipts
- `REQUIRED_AUDIT_SEQUENCE`, which is a required sequence rather than an allowlist
- The DB schema: no migration, so no new deployment constraint

## Error handling

- Import events share the import's `forWorkspace` transaction. Any failure rolls back the source
  import, the mirrors and the events together.
- A confirmation-change event shares the reopen's transaction. The existing concurrent-change
  throw rolls back both.
- No new log carries content.

## Testing

**Unit (Vitest):**
- **Importer:**
  - One event per affected status (approved, published, publish_failed, publishing).
  - None for in_review, reopened or new drafts.
  - Cause follows the digest.
  - `invalidatedApprovals` appears in both the result and the aggregate.
  - Status is never written.
- **Confirmation route:** `listing.approval_invalidated` is written on reopen only.
- **Jobs route:** each cause maps to its tile; an unknown cause is excluded and logged.
- **Components:** the activity label and cause, the import-panel line, the review header
  "Reopened", and the queue tag with grouping unchanged, in both locales.

**Integration (Postgres):**
- `approvalStatesByIds` returns nothing for a foreign workspace's ids.
- Re-importing an approved listing records the event, keeps `approved`, and the catalog shows it
  as not exportable: covered by the real-stack Playwright journey, as no importer integration
  harness exists.
- `audit:verify` passes.

**Acceptance (Playwright, extend the attended journey in `tests/e2e/bulk-update-pilot.spec.ts`):**
1. That journey already imports and approves two listings. At its end, re-import the same workbook.
2. The import panel shows "Approvals invalidated: 2", and neither listing's status becomes `reopened`.
3. /jobs shows the re-import tile at 2.
4. The first listing's activity panel shows the cause.
5. A confirmation change on that listing then shows "Reopened" on its review page and in the queue, and the /jobs confirmation count becomes 1.

## Docs

- `docs/superpowers/plans/2026-09-11-release-gate-closure.md`: mark W7 done when complete; amend the
  /quality clause.

## Corrections found while planning

1. **Read name.** `statusesByIds` already exists on `ListingRepository`, so the new read is
   `approvalStatesByIds`, not `getStatusesByIds`.
2. **Approval must accept `reopened`.** `listing-fields-form.tsx` disabled approval unless the
   review status was `in_review`, which worked for reopened listings only because they were
   masked. Unmasking therefore also changes that condition to accept `reopened`, which the approve
   path already handles (`listings.ts:653`); without it, unmasking would lock every reopened
   listing.
3. **Re-import against the real gate.** No integration harness exists for the bulk-form importer,
   so that check is part of the real-stack Playwright journey.
4. **Acceptance test location.** `tests/e2e/workbook-import.spec.ts` exercises the workbook
   importer, not the SHOPLINE bulk form. The journey extends `tests/e2e/bulk-update-pilot.spec.ts`,
   whose attended test already approves two listings, so the expected counts are 2.
