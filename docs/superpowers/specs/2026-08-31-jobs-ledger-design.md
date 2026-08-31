# Package I (scoped) — `/jobs` Ledger — Design

**Date:** 2026-08-31
**Status:** Approved (brainstorming), pending implementation plan
**Parent plan:** `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` — Package I (§16), scoped down this round to just the `/jobs` surface. `/quality`, `/system-map`, and `/admin`'s 4th tab are deferred to separate specs later, per this session's own decomposition decision (Package I as originally scoped bundles 4 fairly independent subsystems).

## 1. What this builds

A read-only observability page, `/jobs`, showing the recent activity of every asynchronous/batch operation this app performs: AI-enrichment batches (`enrichment_batches`), SHOPLINE publish attempts (`publish_jobs`), listing AI-pipeline runs (`listing_pipeline_runs`), and multi-product exports (`export_attempts`, shipped this session in Package H). Today none of these has any workspace-level visibility outside its own narrow detail view (or, for `export_attempts`, no UI at all) — an operator has no single place to see "what's been happening" across the system. This closes that gap for the four tables that already exist; it does not add new tables or new write paths.

Building on `claude/package-h-multi-product-export` (per this session's decision) rather than merging in Package F's unmerged `/batches` branch first. Consequence: `enrichment-batches.ts` has no workspace-level list method on this branch (Package F added one on its own branch), so this package adds its own — a small amount of duplicated-in-spirit work, accepted in exchange for keeping the branches decoupled.

## 2. Data model — no new tables

Four existing tables, none changed:

- `enrichment_batches` (`id, workspaceId, label, budgetUsd, waveSize, status: open|running|completed|budget_exhausted|cancelled, createdBy, createdAt, updatedAt`) — no direct `listingId` (linkage is via `enrichment_batch_items`, not surfaced in the ledger row itself; the batch detail view, if/when built, would show items).
- `publish_jobs` (`id, workspaceId, listingId, versionId, status: pending_enqueue|queued|running|published|failed, remoteProductId, error, createdAt, updatedAt`).
- `listing_pipeline_runs` (`id, workspaceId, listingId, versionId, status: started|succeeded|failed, resultStatus, errorCode, createdAt, updatedAt`).
- `export_attempts` (`id, workspaceId, requestedBy, manifest: [{listingId, versionId, outcome, reason?}], rowCount, specVersion, createdAt` — no `updatedAt`, it's insert-once; no direct `listingId`, since one export spans many listings).

## 3. Repository changes — 4 new list methods

Each mirrors `listings.ts`'s `listRecent(limit = 100)` convention exactly (validate `1 ≤ limit ≤ 100`, `orderBy(desc(createdAt))`, `.limit(limit)`, workspace-scoped via the existing `WorkspaceTransaction`):

- `enrichment-batches.ts`: `listForWorkspace(limit?): Promise<EnrichmentBatch[]>`.
- `publish-jobs.ts`: `listForWorkspace(limit?): Promise<PublishJob[]>`.
- `pipeline-runs.ts`: `listForWorkspace(limit?): Promise<PipelineRun[]>` (this repository currently has no listing capability at all — `getCompleted`/`getState` are both single-record-by-idempotency-key lookups; this is new surface area, not an extension of an existing list).
- `export-attempts.ts`: `listForWorkspace(limit?): Promise<ExportAttempt[]>`.

None of these four need a composite FK/RLS change — they're plain `SELECT ... WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?` reads against tables whose RLS policies already exist.

## 4. The ledger merge — `apps/web/lib/jobs-ledger.ts`

A pure function, `buildJobsLedger(sources: {batches, publishJobs, pipelineRuns, exports}, limit): LedgerEntry[]`, that:

1. Maps each source's rows to a common `LedgerEntry` shape:
   ```ts
   type LedgerEntry = {
     kind: "batch" | "publish_job" | "pipeline_run" | "export";
     id: string;
     listingId: string | null;       // null for batch/export (multi-listing)
     normalizedStatus: "pending" | "running" | "succeeded" | "failed" | "cancelled";
     rawStatus: string;               // the untranslated origin status, always shown alongside
     createdAt: Date;
     summary: string;                 // one-line, kind-specific (e.g. "3 of 5 listings enriched", "Export: 4 rows, 1 excluded")
   };
   ```
2. Normalizes each source's status vocabulary into the shared 5 values via a small per-kind lookup table (not a generic mapper — each kind's mapping is different enough that a shared function would just be a switch inside a switch):
   - `enrichment_batches`: `open→pending, running→running, completed→succeeded, budget_exhausted→cancelled, cancelled→cancelled`.
   - `publish_jobs`: `pending_enqueue|queued→pending, running→running, published→succeeded, failed→failed`.
   - `listing_pipeline_runs`: `started→running, succeeded→succeeded, failed→failed`.
   - `export_attempts`: always `succeeded` (the row only exists once the attempt completed; per-listing failures inside one export are visible in the manifest, not the top-level status).
3. Merges all four mapped arrays, sorts by `createdAt` descending, truncates to `limit`.

Kept as a pure, dependency-free function (like `createBulkExport`) specifically so it's unit-testable without touching the database — feed it 4 arrays, assert the merged/sorted/normalized output.

## 5. API — `GET /api/jobs`

Role-gated `viewer+` (i.e., just `requireSessionContext`, no `requireWorkspaceRole` call) — matching the established convention for read endpoints (`GET /api/catalog`, `GET /api/listings`), since this page has no write path and viewing operational status shouldn't require a higher bar than viewing the catalog itself. Optional `?limit=` query param (default 50, capped at 100, matching `listRecent`'s existing bounds). Inside `db.forWorkspace(...)`, calls all four new `listForWorkspace` methods (each with a generous fetch limit, e.g. `Math.min(limit, 100)`, since the final truncation happens after the merge — fetching fewer than `limit` from each source could wrongly exclude a source that happens to have more recent activity than the others), builds the ledger via `buildJobsLedger`, returns `200 { entries: LedgerEntry[] }`.

## 6. UI — `/jobs` page

`apps/web/app/(app)/jobs/page.tsx` (server component, no role gate beyond the existing `(app)` layout's session check — matches `/catalog`/`/dashboard`'s pattern, not `/admin`'s admin-only redirect) renders a client component, `JobsLedgerClient`, which fetches `GET /api/jobs` on mount and renders a flat list of rows: an icon/color keyed off `normalizedStatus`, the `kind` as a small label, `summary`, `rawStatus` in a muted sub-label, a relative timestamp, and — when `listingId` is present — a link to `/listings/[id]`. A simple client-side `kind` filter (a row of toggle buttons: All/Batches/Publish/Pipeline/Export) narrows the already-fetched list; no server-side filter param needed at this scale. Nav link added to `apps/web/app/(app)/layout.tsx` alongside the existing `/catalog`/`/dashboard`/`/listings`/`/admin` links.

No pagination beyond the capped-N fetch — matches this codebase's existing convention (`listRecent` everywhere, no cursor/offset precedent to build on), and is an explicit, accepted scope limit for this round: if operational volume ever exceeds ~100 recent events being enough context, that's a real cursor-pagination feature to design later, not something to build speculatively now.

## 7. Testing

- `jobs-ledger.test.ts`: pure-function tests for `buildJobsLedger` — status normalization for each kind (including `budget_exhausted→cancelled`), correct multi-source sort-by-`createdAt`, `limit` truncation after merge (not per-source), `listingId` present/absent correctly per kind.
- Repository integration tests for the 4 new `listForWorkspace` methods: workspace scoping (RLS cross-tenant isolation, matching this session's established pattern), `createdAt desc` ordering, `limit` bounds validation.
- `api/jobs/route.test.ts`: viewer can read (200), the 4 repositories are all called, `limit` query param respected/capped, malformed `limit` handled gracefully (clamped or 400 — implementer's call, documented either way).
- `jobs-ledger-client.test.tsx` (or wherever this codebase's convention puts client-component tests — check `batch-list.tsx`'s test file for the pattern once Package F's convention is available, or default to colocated `*.test.tsx`): renders entries, filter toggles work, listing links render only when `listingId` is present.

## 8. Explicitly out of scope this round

- `/quality`, `/system-map`, `/admin`'s 4th tab, and the capability-registry module — separate specs.
- Any write/action from the ledger (retry a failed job, cancel a batch, etc.) — pure read surface only.
- Cursor-based pagination — capped-N only, per §6.
- A detail/drill-down page per ledger entry (e.g. `/jobs/[id]`) — the flat list with a `summary` string is the whole surface this round; if a future need for full manifest/error detail per entry emerges, that's an additive follow-up, not a redesign.

## 9. Self-review

- **Placeholder scan:** none.
- **Internal consistency:** the ledger's `normalizedStatus` vocabulary is deliberately small and lossy by design (§4), with `rawStatus` always carried alongside specifically to avoid losing information — this tradeoff is stated once and applied consistently, not re-litigated per table.
- **Scope check:** four small repository methods (all following one existing convention), one pure merge function, one read endpoint, one page + one client component — comparable in shape to Package F's original UI work, smaller than Package H.
- **Ambiguity check:** "does a batch/export row link to a listing" is resolved explicitly (no — `listingId: null` for those two kinds, since they're inherently multi-listing); "server-side or client-side kind filter" is resolved explicitly (client-side, given the whole capped list is already fetched); "is this genuinely a new /jobs surface or an extension of something existing" is resolved explicitly (new — nothing today reads any of these 4 tables at the workspace level).
