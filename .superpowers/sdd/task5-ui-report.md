# Task 5 UI implementation report

## Implemented

- Added reviewer-authorized catalog selection for import-origin linked listings, persistent across pagination/filter fetches, with an accessible `Select <SKU> for Bulk Update` checkbox, selected count, and clear action.
- Added `BulkExportPanel` with explicit SHOPLINE freshness attestation, synchronous duplicate guard, retryable generation, submitted-ID snapshotting, all-excluded/no-op manifest reporting, stable attempt status loading, and ready-only download.
- Added a shared `ExportReconciliationPanel` for catalog generation and Jobs. It renders stable attempt/member data attributes, requested/included/excluded/no-op and accepted/rejected/unreported totals, artifact status, reasons, operator reports, correction history, and the independent unverified state.
- Added `ImportResultForm` with export-bound or explicit historical-manual context, accepted/rejected validation, required rejection/correction reasons, synchronous duplicate guard, and payload-bound idempotency keys retained through ambiguous POST or refresh failures.
- Extended Jobs to render persisted export reconciliations and reload an attempt after result submission.
- Extended listing detail models fail closed for missing permissions/origin. Import-origin listings expose Bulk Update XLSX; created-origin listings identify Create CSV/API delivery. Historical result entry is an explicit unlinked mode and uses the durable newest manual receipt as its correction head.
- Added responsive plain-CSS layouts with wrapping for long IDs.

## Tests and verification

### TDD evidence

- RED: `corepack.cmd pnpm@11.7.0 --filter @wukong/web test -- bulk-export-panel.test.tsx export-reconciliation-panel.test.tsx` failed because both new component modules were absent. This was the expected missing-feature failure.
- GREEN: the same command passed after implementing the components; subsequent coverage added catalog permission/origin selection, ready-only download and manifest counts, mixed reconciliation/history, export payload binding, and ambiguous retry key reuse.

### Final checks

- `corepack.cmd pnpm@11.7.0 --filter @wukong/web test` — 104 files passed, 875 tests passed.
- `corepack.cmd pnpm@11.7.0 --filter @wukong/web typecheck` — passed.
- Prettier check across all owned files — passed.
- `git diff --check` — passed (only Git line-ending notices).

## Files changed

- `apps/web/components/bulk-export-panel.tsx` and test
- `apps/web/components/import-result-form.tsx`
- `apps/web/components/export-reconciliation-panel.tsx` and test
- `apps/web/components/catalog-control-center.tsx`, test, and module CSS
- `apps/web/components/listing-view-models.ts`
- `apps/web/components/listing-review-client.tsx`
- `apps/web/components/delivery-panel.tsx` and test
- `apps/web/components/jobs-ledger-client.tsx` and test
- `apps/web/app/globals.css`

## Self-review and concerns

- Fixed a self-review issue where a successful POST followed by a failed detail refresh could have cleared the retry key too early. The key now remains stable until the persisted view refresh succeeds.
- Real browser/E2E acceptance, combined build, and synthetic service orchestration are owned by the root agent and remain outside this component-only commit.

## Review fixes

- Bound freshness confirmation to the normalized selected-ID set, so any add/remove invalidates it immediately.
- Preserved every POST-created attempt ID and artifact status when detail retrieval fails, with a retry action scoped to that same attempt. This also handles non-2xx artifact responses that carry a persisted attempt.
- Rendered rejection reasons separately from correction reasons for latest receipts and every export/manual history revision.
- Made Create via API/Create CSV and Update via API/Update CSV labels visible at the controls while retaining the existing bilingual action text.
- Changed `ImportResultForm` to a discriminated prop union: export mode requires attempt/version IDs, historical mode forbids them.

### Review TDD evidence

- RED: the focused review run failed three assertions: freshness remained checked after selected IDs changed; a successful POST followed by failed detail GET hid `attempt-stable`; and durable rejected history omitted `Protected field rejected`/`Original row rejected`.
- GREEN: `corepack.cmd pnpm@11.7.0 --filter @wukong/web test -- bulk-export-panel.test.tsx export-reconciliation-panel.test.tsx delivery-panel.test.tsx jobs-ledger-client.test.tsx` completed with 104 files / 878 tests passing, followed by a focused persisted-error-attempt case with 104 files / 879 tests passing. `corepack.cmd pnpm@11.7.0 --filter @wukong/web typecheck` passed.
- Root owns the final combined build and real-browser rerun against the synthetic services.
### Origin capability follow-up

- Verified `delivery-service.ts` method `csv` always calls the 15-column `createShoplineCsv`; removed the invented imported-origin Update CSV/API controls.
- Import-origin listings now expose only Bulk Update XLSX. Created-origin links expose Update via API plus Create CSV; unlinked listings expose Create via API plus Create CSV; unknown link origin fails closed.
- RED: the origin regression saw `發布至 SHOPLINE` and `匯出 SHOPLINE CSV` on an approved imported listing.
- GREEN: focused delivery run completed with 104 files / 879 tests passing; web typecheck passed.