# Attended Batches — List, Detail, Create, Advance — Design

**Date:** 2026-08-31
**Status:** Approved (brainstorming), pending implementation plan
**Parent plan:** `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` — Package F (§16), addressing `/batches`'s missing route (§5) and the unenforced 1–5 wave-size cap (§7 G12).

## 1. What this builds

`enrichment_batches`/`enrichment_batch_items` already exist as tables, and `createEnrichmentBatchService`'s `createBatch`/`advanceBatch` already work end-to-end via `POST /api/enrichment-batches` and `POST /api/enrichment-batches/[id]/advance`. But there is **no UI anywhere** for either action (confirmed by a repo-wide grep — no component references `enrichment-batches`, `createBatch`, or `advanceBatch`), no `GET` route to list or inspect a batch, and no `/batches` page at all. Separately, §7 G12 calls for a 1–5 wave-size cap; today's actual cap is 500 (the route's Zod schema) with no upper bound at all one layer down (the service only checks `>= 1`).

This package closes all of that: real list/detail reads, a real `/batches` page with create-batch and advance-batch actions, and the wave-size cap enforced where §7 G12 asks for it.

## 2. Wave-size cap fix (§7 G12)

Two places currently under-enforce this, fixed together:

- `apps/web/app/api/enrichment-batches/route.ts`'s Zod body schema: `waveSize: z.number().int().min(1).max(500)` → `.max(5)`.
- `apps/web/lib/enrichment-batch-service.ts`'s `createBatch`: the existing `if (!Number.isInteger(input.waveSize) || input.waveSize < 1)` guard gains `|| input.waveSize > 5`, with a `400 invalid_wave_size` matching the existing message style. This is the defense-in-depth layer — the service is called directly by tests and would remain the sole guard if the route's schema ever drifted, matching how this file already treats its own validation as authoritative rather than trusting the route.

No `gap`-related change needed here — out of scope for this fix.

## 3. Repository extension

`EnrichmentBatch` (`packages/db/src/repositories/enrichment-batches.ts`) currently has no `createdAt`, even though the underlying table column exists — needed now for list ordering. `EnrichmentBatchRepository` gains one method:

```ts
export type EnrichmentBatch = {
  id: string;
  label: string;
  budgetUsd: number;
  waveSize: number;
  status: EnrichmentBatchStatus;
  createdBy: string;
  createdAt: Date;
};

export type EnrichmentBatchRepository = {
  // ...existing methods unchanged...
  listForWorkspace(): Promise<EnrichmentBatch[]>;
};
```

`listForWorkspace` selects all batches for the calling workspace (already scoped by the `forWorkspace` transaction, matching every other repository method in this file), ordered by `createdAt desc` — no pagination, matching this pilot's small expected batch count (the codebase's only other unpaginated `listRecent`-style read, `platformProducts.listRecent`, caps at 5000 for the same reason; batch counts are orders of magnitude smaller).

**No `gap` column is added.** `gap` is used once at creation to select the cohort (`createBatch` reads it, filters listings, and never stores it), then discarded — it is not persisted anywhere on `enrichment_batches` today. Surfacing "which gap this batch targets" in the list/detail view would require a genuine schema addition; since neither the master plan's Package F outcome nor this design's approved scope calls for it, the list/detail view omits it. An operator distinguishes batches by `label` (already free text they chose at creation).

## 4. Backend: two new GET routes

**`GET /api/enrichment-batches`** (added to the existing `apps/web/app/api/enrichment-batches/route.ts`, alongside its current `POST`):
- Same `operator`-role gate as the existing `POST` handler.
- Calls a new `listBatches()` function added to `createEnrichmentBatchService`, which just calls `repositories.enrichmentBatches.listForWorkspace()` inside `forWorkspace` — no new validation, this is a straight read.
- Returns `{ batches: EnrichmentBatch[] }` (serializing `createdAt` to ISO string, matching how every other route in this codebase serializes dates via `jsonResponse`).

**`GET /api/enrichment-batches/[id]`** (new file, `apps/web/app/api/enrichment-batches/[id]/route.ts`, sibling to the existing `[id]/advance/route.ts`):
- Same role gate and `RouteContext = { params: Promise<{ id: string }> }` convention as `[id]/advance/route.ts`.
- Calls a new `getBatch(input: { workspaceId: string; batchId: string })` function added to the service: fetches `getById`, throws `404 batch_not_found` if absent (matching `advanceBatch`'s existing not-found handling), then calls `countByStatus` and returns `{ batch, counts }`.

## 5. Frontend

**`apps/web/app/(app)/batches/page.tsx`** (new page):
- Server component, mirrors `apps/web/app/(app)/catalog/page.tsx`'s shell (breadcrumb, `page-header`, then a client island).
- Renders `<CreateBatchForm />` (new client component) above `<BatchList />` (new client component, fetches `GET /api/enrichment-batches` on mount and lists label/status-badge/wave-size/budget-vs-spent-placeholder/created-date, each row linking to `/batches/[id]`).
- Status badges reuse the existing `.review-status`/`.status-<name>` CSS pattern in `globals.css` (the same one `catalog`/listing statuses use). `open`/`running` map to `.status-neutral`, `completed` maps to `.status-success`, `budget_exhausted`/`cancelled` map to `.status-danger` — no new modifier classes needed, since the existing three cover all five batch statuses semantically.

**`apps/web/app/(app)/batches/[id]/page.tsx`** (new page):
- Server component shell, same pattern, renders `<BatchDetail batchId={id} />` (new client component: fetches `GET /api/enrichment-batches/[id]` on mount, shows the batch's label/status/budget/wave-size and the 5-way item-status count breakdown, plus an `<AdvanceBatchButton batchId={id} />`).

**`apps/web/components/create-batch-form.tsx`** (new, pure-logic + thin component, mirrors `bulk-import-panel.tsx`'s split):
- Form fields: label (text), gap (`<select>` over the 6 real `EnrichmentGap` values), budget USD (number), wave size (number, 1–5).
- `submitCreateBatch(input, deps)` POSTs JSON to `/api/enrichment-batches`, mirrors `submitBulkImport`'s typed outcome shape (`{kind: "success", ...} | {kind: "validation_error"|"api_error"|"network_error", ...}`), maps the route's real error codes (`invalid_budget`, `invalid_wave_size`, `empty_cohort`, `insufficient_role`) to messages the same way `API_ERROR_MESSAGES` does today.
- On success, the list component re-fetches (simplest correct approach — no cache invalidation machinery needed at this pilot's scale).

**`apps/web/components/advance-batch-button.tsx`** (new, pure-logic + thin component):
- `submitAdvanceBatch(batchId, deps)` POSTs to `/api/enrichment-batches/${batchId}/advance`, same typed-outcome convention.
- On success, re-fetches the detail view (`GET /api/enrichment-batches/[id]`) so updated counts/status show immediately — the operator clicks "Advance" once per wave, same as calling the API directly today, just with visible feedback instead of a blind curl.

**`apps/web/app/(app)/layout.tsx`**: one new nav link, `/batches`, alongside the existing `/listings/new`/`/listings/import` links.

## 6. Testing

- `enrichment-batch-service.test.ts`: extend with a wave-size-of-6 rejection test (currently only tests `waveSize < 1`); add tests for the new `listBatches`/`getBatch` functions using this file's existing fake-`getDatabase` harness.
- `route.test.ts` (existing, `apps/web/app/api/enrichment-batches/route.ts`): add a wave-size-of-6 rejection test at the Zod-schema layer; add tests for the new `GET` handler (operator success, viewer 403).
- New `apps/web/app/api/enrichment-batches/[id]/route.test.ts`: operator success, viewer 403, not-found 404 — mirroring `[id]/advance/route.test.ts`'s existing structure.
- `packages/db/src/repositories/enrichment-batches.integration.test.ts` (existing file — confirm before assuming; extend if present, create if not): a cross-workspace RLS test for `listForWorkspace`, matching this session's established pattern (`source-imports.integration.test.ts`'s "never returns another workspace's row" style).
- New component tests for `create-batch-form.tsx`/`advance-batch-button.tsx`, matching `bulk-import-panel.test.ts`'s structure (pure-logic validation/error-mapping tests, then a thin DOM-mount render test).

## 7. Self-review

- **Placeholder scan:** none.
- **Internal consistency:** §3's `listForWorkspace` addition is consistent with §4's two new routes, both of which are consistent with §5's UI actually calling them.
- **Scope check:** backend (repository + 2 routes + wave-cap fix) and frontend (2 pages + 2 new components + nav link) are both single-PR-sized for this codebase's established package granularity (comparable to Package E's UI half, which was one PR).
- **Ambiguity check:** "should `gap` be shown in the list/detail view" is resolved explicitly (no — not persisted today, no new column added) rather than left implicit; "how does an operator advance more than one wave" is resolved explicitly (click Advance again — no auto-loop, matching the API's existing one-wave-per-call contract).
