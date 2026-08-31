# Package H — Multi-Product Changed-Row XLSX and Manifest — Design

**Date:** 2026-08-31
**Status:** Approved (brainstorming), pending implementation plan
**Parent plan:** `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` — Package H (§16), dependent on Package G (already complete on `claude/package-g-seo-confirmation-ledger`, not yet merged).

## 1. What this builds

Today, exporting a reviewed listing back to a SHOPLINE-importable workbook only works one listing at a time (`POST /api/listings/[id]/deliver` with `method: "bulk_form"`, backed by `deliverBulkForm` in `apps/web/lib/delivery-service.ts`). This package adds a **multi-product** export: given a set of listing IDs, produce one combined XLSX containing only the listings whose source data is still fresh and that actually changed, plus a manifest recording what happened to every requested listing (included, excluded-no-op, or excluded-stale, with a reason).

A key finding changes this package's scope versus the master plan's original estimate: `createBulkFormUpdate` (`packages/shopline/src/bulk-form.ts:1072`) already accepts an array of rows/enrichments — it is not single-row-limited. The existing single-row caller just always passes an array of one. So this package needs **no changes** to `createBulkFormUpdate` or `writeBulkFormWorkbook`; the real, new work is wiring `assertExportFreshness` (`packages/core/src/assert-export-freshness.ts`) into a real call site for the first time — it exists today only as a tested-but-unused pure function, since the existing single-row deliver path bypasses freshness checking entirely — plus the new orchestration, storage, and endpoints around it.

## 2. Orchestration

New `apps/web/lib/bulk-export-service.ts`, exporting `createBulkExport(input, deps)`:

- **Input**: `{ workspaceId, requestedBy, listingIds: string[], freshnessAttested: boolean }`. One attestation flag covers the whole request — `assertExportFreshness`'s own design (already shipped in Package E) deliberately requires an explicit human attestation rather than a time-since-import threshold, per the master instruction's bar on hard-coded freshness policy; asking for one attestation per multi-product export request (not per listing) is the natural extension of that same design for a batch action.
- For each `listingId`: look up its `platform_products` link (`sourceImportId`, `contentDigest`, `origin`). If no link, or `origin !== "import"`, exclude with reason `not_import_origin` (mirrors the same origin-gating fix already applied to the approval route in Package G — a create-origin listing has nothing to freshness-check against). Otherwise call `assertExportFreshness` with `expectedSourceImportId`/`expectedRowDigest` from the link, `expectedVersionId` from the listing's current active version, and the request's `freshnessAttested`. A failure excludes that listing with `reason: result.reason`.
- For every surviving listing, build a `BulkFormExportRow` (`{ productId, raw: link.rawRow, rowNumber }`, reusing the same `isBulkFormRawRow` validation `deliverBulkForm` already does — a stored `rawRow` that fails validation excludes that listing with reason `raw_row_invalid`) and a `BulkFormEnrichment` (same content-vs-raw diffing `deliverBulkForm` already performs per listing, applied here per survivor).
- Call `createBulkFormUpdate(rows, enrichments, { include: "changed" })` **once**, unmodified, for the whole survivor set. Its own default already omits no-op rows (zero net column changes) without any new logic in this package — a listing whose enrichment produces no changes is simply absent from `update.changes`/the emitted sheet; the manifest records it as `excluded_no_op` by cross-referencing which survivor listing IDs' rows appear in the output.
- If the survivor set is non-empty but produces zero total rows (every survivor was a no-op) or the survivor set was empty to begin with, this is not an error — the manifest simply shows every requested listing as excluded and `rowCount: 0`; the caller can inspect the manifest instead of getting an opaque failure. (`createBulkFormUpdate` throwing on "zero net changes" is only reachable if the caller explicitly requests `include: "all"`, which this package never does.)
- `writeBulkFormWorkbook(update.sheet)` produces the file bytes.

## 3. Persistence: `export_attempts` table

One row per export request, in `packages/db/src/schema.ts`, following the existing `source_imports`/`review_confirmations` conventions (RLS-enforced, workspace-scoped):

- `id`, `workspaceId` (FK `workspaces`, cascade), `idempotencyKey` (unique per workspace), `requestedBy` (the acting user id), `manifest` (jsonb — array of `{ listingId, versionId, outcome, reason? }`, one entry per requested listing id, in request order), `rowCount` (integer — rows actually written), `specVersion` (text), `createdAt`.
- **Idempotency key** = a stable hash (sha256, hex) of `workspaceId + ":" + ` the request's `listingIds` each paired with that listing's *current* active version id, sorted and joined — e.g. `hash(workspaceId, sortedListingVersionPairs)`. Resubmitting the identical set of listings at the identical versions returns the existing `export_attempts` row (by `onConflictDoNothing` + re-select, mirroring `publishJobs.ensure()`'s exact pattern) rather than re-running neutralization and potentially double-counting a quantity-delta neutralization event. A request naming a listing whose active version has since changed gets a different key and creates a new attempt, which is correct — the content to export has genuinely changed.
- The generated XLSX bytes are stored via the existing `packages/assets` R2/S3 store (same mechanism already used for product-shot images — key-canonicalized, presigned where that package already supports it), keyed by the export attempt's id, **not regenerated on download**. This guarantees the file a caller downloads later is byte-identical to what was freshness-checked and neutralized at creation time, even if the source listings change again in the interim.

## 4. API: two routes

- **`POST /api/listings/export`** — body `{ listingIds: string[], freshnessAttested: boolean }`. Role-gated to `reviewer`/`admin`/`owner` (matching the existing single-row deliver route's bar — export ships content externally, so it uses the stricter reviewer-and-above gate rather than the operator-and-above bar used for enrichment-batch actions). Runs `createBulkExport`, persists the `export_attempts` row, writes one audit event `listing.bulk_export_created` with metadata `{ exportAttemptId, includedListingIds, excludedListingIds }` (identifiers only, matching this codebase's audit-metadata convention — no field content, no export bytes). Returns `200 { exportAttemptId, manifest, rowCount }`. `listingIds` must be non-empty and workspace-scoped (any id not resolving to a listing in the caller's workspace is treated as `excluded` with reason `listing_not_found`, not a request-level error, so one bad id in a large batch doesn't fail the whole request).
- **`GET /api/listings/export/[id]/download`** — same role gate. Loads the `export_attempts` row (404 if missing or belongs to another workspace, enforced by RLS same as every other route), streams the stored XLSX bytes with `content-disposition: attachment; filename="export-{id}-{specVersion}.xlsx"`, same content-type as the existing single-row deliver route.

## 5. Testing

- `bulk-export-service.test.ts`: the golden 3-listing scenario from the master plan's own acceptance evidence (one no-op, one changed, one mismatched-source) → exactly 1 output row, manifest shows all 3 outcomes correctly; empty-survivor-set produces `rowCount: 0` with a full manifest, not an error; `not_attested` excludes every import-origin listing when `freshnessAttested: false`; create-origin listings excluded with `not_import_origin`.
- `export/route.test.ts`: role gate (viewer/operator 403), idempotency (same listingIds+versions twice → same `exportAttemptId`, no duplicate `export_attempts` row), a listing id from another workspace excluded rather than erroring the request.
- `export/[id]/download/route.test.ts`: downloads the exact bytes generated at creation time even if the source listing's content changes afterward; 404 for an unknown or cross-workspace id.
- Extend `bulk-form.test.ts`'s existing round-trip pattern with a multi-row case if not already implicitly covered by `createBulkFormUpdate`'s existing tests (confirm during planning whether this is genuinely new coverage or redundant with what already exists there).

## 6. Explicitly out of scope (per this session's decisions)

- No dependency on `enrichment_batches` (Package F) — `listingIds` is an ad-hoc list supplied by the caller each time, not a stored batch membership.
- No feature flag — role gating only, matching what Package G actually shipped despite the master plan's text suggesting a shared capability flag.
- No durable `/jobs` UI surfacing these attempts — that's explicitly Package I's job; this package only makes sure `export_attempts` exists and is populated so Package I has something to read.

## 7. Self-review

- **Placeholder scan:** none.
- **Internal consistency:** the origin-gating check (§2) deliberately mirrors the fix already applied to Package G's approve route for the identical create-vs-import-origin distinction, so the two gates can't drift on what "needs freshness checking" means.
- **Scope check:** one new service module, one new table, two new routes, reuse of two already-shipped pure functions (`createBulkFormUpdate`, `assertExportFreshness`) — smaller than the master plan's "L" estimate, closer to "M", similar to how Package G came in smaller than originally drafted.
- **Ambiguity check:** "does one bad listing id fail the whole export" is resolved explicitly (no — excluded with a reason, per this session's per-listing-exclusion decision); "is freshness attested per-listing or per-request" is resolved explicitly (per-request, one flag); "are bytes regenerated on download or stored" is resolved explicitly (stored, for freshness-check integrity).
