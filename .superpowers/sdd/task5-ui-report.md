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
