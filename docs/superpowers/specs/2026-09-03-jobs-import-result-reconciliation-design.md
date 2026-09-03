# `/jobs` Import-Result Reconciliation — Design

**Date:** 2026-09-03
**Status:** Approved (brainstorming), pending implementation plan
**Origin:** the master plan's proposed-but-never-built `POST /api/listings/[id]/shopline-import-result` endpoint (`docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` §10, §11, §18; Package I's stated outcome at §16), flagged as an open gap by this session's own Package K readiness audit and explicitly required by `docs/runbooks/opak-uat-rollout.md` §4 before Stage 3 (the 50–100-product shadow pilot) can begin.

## 1. What this fixes

Nothing today records what SHOPLINE actually accepted after an operator manually re-imports a Wukong-generated bulk-form export. The `/jobs` ledger (Package I, on `main`) shows that a file was *generated* (via its `export` entries, sourced from `export_attempts`), but has no concept of what happened after the operator uploaded that file to SHOPLINE — whether the import succeeded, was rejected, or partially succeeded. The Opak UAT rollout runbook's Stage 1–2 workaround (a manual log) is explicitly documented as insufficient at Stage 3's 50–100-product, 2-week cadence.

## 2. Scope

Backend + `/jobs` ledger display only — no new recording form. An operator records an outcome via a documented `curl` call (added to `shopline-pilot-onboarding.md`, matching that runbook's existing style for import/enrich/export actions), and the result becomes visible in the existing `/jobs` ledger as a new entry kind. No changes to `delivery-service.ts` or `bulk-export-service.ts`'s existing persistence behavior — this is purely additive.

## 3. Data model

New table `import_results` (schema in `packages/db/src/schema.ts`, repository `packages/db/src/repositories/import-results.ts`, mirroring `export-attempts.ts`'s shape and conventions):

- `id` — uuid pk.
- `workspaceId` — uuid, not null, RLS-scoped like every other table.
- `listingId` — uuid, not null, FK to `listing_drafts`, **restrict** (matching `platform_products.listingId`'s existing restrict discipline — an operator's reconciliation record must not silently vanish or cascade if the draft is later deleted).
- `exportAttemptId` — uuid, **nullable**, FK to `export_attempts`, restrict. Present when reconciling a multi-product export (`/api/listings/export`, which persists `export_attempts` rows); `null` for a single-listing `deliver` (`method: "bulk_form"`) download, which persists no such row today. No change to `delivery-service.ts` to manufacture one — this stays additive.
- `outcome` — text, app-level CHECK `IN ('accepted', 'rejected')` (no pg enum, matching `platform_products.origin`'s existing precedent).
- `rejectReason` — text, nullable; required (enforced at the zod layer, not a DB constraint — matching the codebase's existing preference for validation logic in the route/service layer over DB-level conditional constraints) when `outcome = 'rejected'`.
- `recordedBy` — text (actor id, not a FK — matching `export_attempts.requestedBy`'s existing convention).
- `createdAt` — timestamp, default now.

Indexes: `(workspaceId, listingId)` for lookup, `(workspaceId, createdAt desc, id desc)` for the ledger's sort — matching `export_attempts`' existing index shape.

**Append-only, not idempotent.** Unlike `export_attempts` (which is idempotency-keyed because generating the same export twice is a real, detectable repeat action), recording an import result is an operator's point-in-time report — they might legitimately record a corrected outcome after an earlier mistaken entry. No idempotency key, no `ensure`-style dedup. The `/jobs` ledger and any future reconciliation view show every record; "current known state" for a listing is simply its most recent `import_results` row by `createdAt`.

## 4. API

`POST /api/listings/[id]/shopline-import-result`, in a new file `apps/web/app/api/listings/[id]/shopline-import-result/route.ts`, following `approve/route.ts`'s exact conventions:

- Deps factory: `createImportResultHandler(deps)`, bound at file bottom as `export const POST = createImportResultHandler({ sessionContext: authSessionContext, getDatabase })`.
- `RouteContext = { params: Promise<{ id: string }> }`, `const { id } = await context.params`.
- Id validation: `if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, "listing_not_found", ...)` — same regex as `approve/route.ts`.
- Role gate: `operator+` (matching the XLSX-import role — this is an operator reporting the outcome of their own manual action, not a review/approval action).
- Body schema (zod, `.strict()`):
  ```ts
  const bodySchema = z
    .object({
      outcome: z.enum(["accepted", "rejected"]),
      rejectReason: z.string().min(1).max(2000).optional(),
      exportAttemptId: z.string().uuid().optional(),
    })
    .strict()
    .refine(
      (body) => body.outcome !== "rejected" || body.rejectReason !== undefined,
      { message: "rejectReason is required when outcome is \"rejected\"." },
    );
  ```
  (Mirrors `export/route.ts`'s existing `.refine()` pattern for a different invariant — no new validation idiom introduced.)
- Inside one `db.forWorkspace` call: confirm the listing exists (404 if not); if `exportAttemptId` is present, confirm it exists and belongs to this workspace (404 `export_attempt_not_found` if not — same defense-in-depth pattern as every other cross-entity reference in this codebase); insert the `import_results` row; write one audit event.
- Audit action: `listing.shopline_import_result_recorded`, metadata `{ outcome, exportAttemptId: exportAttemptId ?? null }` (no `rejectReason` in metadata — free-text from an operator could contain something sensitive; keep it in the dedicated column, not duplicated into `audit_events.metadata`).
- Success response: `jsonResponse(201, { id, listingId, outcome, exportAttemptId, createdAt })`.

No bulk/batch variant. An operator reconciling a multi-product export calls this once per listing — matching the existing bulk-approve UX precedent (`shopline-pilot-onboarding.md` §7: the single-listing approval logic called once per listing, sequentially, each reported independently) rather than inventing a new bulk-call shape.

## 5. `/jobs` ledger integration

- `LedgerKind` (`apps/web/lib/jobs-ledger.ts`) gains a 5th member: `"import_result"`.
- `apps/web/app/api/jobs/route.ts` adds a 5th parallel fetch: `repositories.importResults.listForWorkspace(SOURCE_FETCH_LIMIT)`.
- `jobs-ledger.ts` gains a mapper (matching the shape of the existing four): `outcome: "accepted" → normalizedStatus: "succeeded"`, `outcome: "rejected" → normalizedStatus: "failed"`; `summary` built from outcome + (if present) a truncated `rejectReason`.
- `jobs-ledger-client.tsx` gains a `KIND_FILTERS` entry and a `KIND_LABELS` entry (bilingual, matching the existing four kinds' label style, e.g. `import_result: "匯入結果 Import result"`). No new row-template code — the existing generic `<li className="flag-item">` rendering (kind label, status pill, summary, `rawStatus`/`createdAt` meta line, conditional "View listing" link via `listingId`) already covers this.

## 6. Documentation

Add a new numbered step to `shopline-pilot-onboarding.md` (after §6, "Exporting enrichment back to SHOPLINE," since recording an import result is the natural next action after that export/re-import cycle), documenting the `curl` invocation with both outcomes shown, matching that file's existing style exactly (real command, real response fields described, real failure codes named).

## 7. Testing plan

- `packages/db/src/repositories/import-results.test.ts` (or `.integration.test.ts` if it needs live Postgres for the FK/RLS checks, matching `export-attempts.ts`'s own test split) — insert/read, workspace-scoping, cross-workspace-denial (per this codebase's standing rule: no new tenant-scoped table without one), FK-restrict behavior on listing delete.
- `apps/web/app/api/listings/[id]/shopline-import-result/route.test.ts` — the standard route-test shape (fake deps): success (both outcomes), 404 unknown listing, 404 unknown/cross-workspace `exportAttemptId`, 400 on missing `rejectReason` when `outcome: "rejected"`, role-gate rejection for a sub-operator role, audit event written with correct action/metadata.
- `apps/web/lib/jobs-ledger.test.ts` — extend with the new `import_result` mapper's status normalization and summary construction, matching the existing per-kind test structure.
- `apps/web/app/api/jobs/route.test.ts` — extend to confirm the 5th source is fetched and merged correctly.
- `apps/web/components/jobs-ledger-client.test.tsx` — extend to confirm the new kind filters/renders correctly, matching the existing per-kind test pattern.

## 8. Explicitly out of scope

- A dedicated recording UI/form — curl-only for this follow-up, per the approved scope decision (§2).
- Any change to `delivery-service.ts` or `bulk-export-service.ts` to manufacture an `export_attempts` row for the single-listing path — the nullable `exportAttemptId` absorbs that gap instead.
- A broader channel-listing sync-state model (`in_sync`/`local_changes_pending`/`remote_changes_detected`/`conflict`/`delivery_failed`/`unsupported`, per `docs/product/ecommerce-os-product-plan.md` §4.4) — this endpoint is a first, narrow instance of that larger concept, not an attempt to build it.
- A bulk/batch recording endpoint — per-listing calls, looped by the operator, matching the bulk-approve precedent.

## 9. Self-review

- **Placeholder scan:** none — schema fields, route conventions, audit action name, and ledger integration points are all named concretely.
- **Internal consistency:** §3's nullable `exportAttemptId` is consistently reflected in §4's route logic (optional field, conditional lookup) and §8's explicit scope boundary (no change to the paths that don't produce one).
- **Scope check:** appropriately sized for a single implementation plan — one new table, one new route, extensions to four existing files for ledger integration, one doc update. Comparable in size to PR #65.
- **Ambiguity check:** the two points with more than one reasonable resolution (UI scope, `export_attempts` anchor design) were both resolved explicitly with the user before this document was written.
