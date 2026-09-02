# Multi-Product Export — No-Op Row Leak Fix — Design

**Date:** 2026-09-03
**Status:** Approved (brainstorming), pending implementation plan
**Origin:** discovered during Package K's readiness audit — a parallel research pass re-verifying every UAT go/no-go gate from `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` against the real current code found this bug empirically (a temporary test built a 2-listing batch — one changed, one genuine no-op — and confirmed the no-op product's row was physically written into the emitted XLSX with its quantity-delta cells force-neutralized, even though the returned manifest correctly labeled it `excluded_no_op`).

## 1. What this fixes

Package H's multi-product changed-row XLSX export (`apps/web/lib/bulk-export-service.ts`, `packages/shopline/src/bulk-form.ts`) has a real correctness bug: in a batch containing at least one genuinely-changed listing and at least one genuine no-op listing, the no-op listing's row is written into the output file anyway, with its two quantity-delta cells (`updateQuantity`/`updateVariantQuantity`) force-neutralized to `"+0"` by the writer's existing per-row neutralization logic. Re-importing that file into SHOPLINE would silently zero a stock delta on a product nobody approved touching — a direct violation of the master plan's own go/no-go bar ("zero unintended stock/price/status/category/supplier changes").

Alongside the core bug, the same audit found two related gaps that the master plan's own Package H acceptance criteria call for and that bear on the same safety property (a generated file must never silently misrepresent what was actually approved): no self-check that the emitted file's cells actually match what was intended (no "reparse and assert" step), and no rejection when a request mixes listings from two different SHOPLINE stores into one output file. A third and fourth gap the same audit found (missing manifest diagnostic fields — changed-cell counts, neutralized-delta list, output digest; and thin test coverage for some of the above) are deferred — see §5.

## 2. Root cause

`packages/shopline/src/bulk-form.ts:1072-1149`, `createBulkFormUpdate`. Its per-row inclusion check (line 1091):

```ts
const values = byProductId.get(row.productId);
if (values === undefined && include === "changed") continue;
```

only skips a row when **no enrichment entry exists at all** for that product. `apps/web/lib/bulk-export-service.ts`'s `createBulkExport` always supplies an entry for every freshness-surviving listing — including genuine no-ops, since it has no way to know in advance whether a listing's current content differs from its raw source — so this skip never fires for a no-op survivor. The function's only other safety net is a *batch-level* check (`changes.length === 0` throws `enrichment_no_changes`, lines 1128-1137): correct for an all-no-op batch, but blind to a no-op row sitting inside an otherwise-mixed batch, since the batch's `changes` array is non-empty overall.

`createBulkExport` already computes the correct manifest outcome after the fact (`changedProductIds`, derived from `update.changes`, used to relabel each entry `included` vs. `excluded_no_op` — `bulk-export-service.ts:251-262`), so the *reported* outcome has always been right. Only the *actual file contents* were wrong.

## 3. The fix

**Move the per-row skip decision from "does this row have an enrichment entry" to "did this row actually produce any changed cell," decided after building its cells, not before:**

```ts
for (const row of rows) {
  const values = byProductId.get(row.productId);
  const changesBeforeRow = changes.length;

  const cells = BULK_FORM_COLUMNS.map((column) => {
    // unchanged — builds each cell, pushing to `changes` exactly as today
    // whenever a replacement genuinely differs from the original
  });

  const rowChanged = changes.length > changesBeforeRow;
  if (!rowChanged && include === "changed") continue;

  for (const column of QUANTITY_DELTA_COLUMNS) {
    // unchanged neutralization-tracking logic — now only reached for
    // rows that survive the skip, so a skipped no-op row's delta cells
    // are never neutralized or counted either
  }
  dataRows.push(cells);
}
```

**Confirmed behavior-preserving for the other production caller.** `apps/web/lib/delivery-service.ts:537-557` (single-row delivery) calls `createBulkFormUpdate` with no `options` argument, so `include` defaults to `"changed"` there too. Before this fix, a single no-op row was *never* skipped at the per-row level (an enrichment entry always exists for the one row), so it always reached `dataRows.push`, and the function still correctly threw `enrichment_no_changes` afterward because the batch-level `changes.length === 0` check fired regardless. After this fix, a single no-op row is skipped at the per-row level instead, `dataRows` stays empty, and the same batch-level check still fires — identical observable outcome (the throw), reached one line earlier. No behavior change for this caller.

**`include: "all"` mode is untouched** — the skip only applies when `include === "changed"`; the one caller of `include: "all"` (`packages/shopline/src/bulk-form.test.ts:440`, test-only) is unaffected.

## 4. Reparse-and-assert

After `writeBulkFormWorkbook(update.sheet)` produces the output `body` in `createBulkExport`, before returning it, re-parse those exact bytes with the existing `readBulkFormSheet`/`parseBulkForm` (`packages/shopline/src/bulk-form-xlsx.ts:226`, `packages/shopline/src/bulk-form.ts`'s `parseBulkForm`) and assert, for every row the manifest marks `included`, that its locked + pass-through cells are byte-identical to the source `rawRow` the corresponding `rows[]` entry was built from. A mismatch throws a new internal error (distinct from `ShoplineBulkFormError`'s user-facing validation issues, since this indicates a bug in the writer itself, not bad input) — this is a should-never-fire self-check, not a new user-facing rejection path, and it directly re-verifies the exact invariant that just broke.

## 5. Mixed-source/store rejection

`BulkExportPlatformProductLink` (`bulk-export-service.ts:64-70`) gains a `connectionId: string` field, threaded through from `platformProducts.getByListingId` (already returns `connectionId` today, just not read by this type). While iterating survivors, `createBulkExport` tracks the distinct `connectionId` values seen among import-origin listings; if more than one distinct value appears, the whole request is rejected — `ShoplineBulkFormError` with a new issue code `mixed_source_connections` — rather than silently combining two SHOPLINE stores' listings into one output file. This reuses the export route's existing `ShoplineBulkFormError` → 409 handling (`apps/web/app/api/listings/export/route.ts`'s catch block), no new error-handling path needed.

`sourceImportId` is deliberately **not** required to match across listings in the same batch — two listings from different import batches of the *same* store is a normal, expected case (a merchant re-imports over time); only mixing two different *stores* (`connectionId`) in one file is nonsensical and worth a hard reject. Header-contract consistency is already effectively enforced globally today (`assertExportFreshness` compares each listing's stored header contract against one shared `currentHeaderContractSha256()`), so no additional cross-listing check is needed for that dimension.

## 6. Testing

- **The bug's own regression test**: a 2-listing batch (one genuinely changed, one genuine no-op, both import-origin, both fresh) — parse the actual emitted workbook bytes (not just `manifest`/`rowCount`) and assert exactly one data row exists, and it's the changed listing's. This is the test that would have caught the original bug; today's suite never reads the emitted bytes.
- **Reparse-and-assert test**: prove the self-check actually fires by temporarily reintroducing a writer bug (e.g. skip the neutralization-after-skip fix in a scratch copy) and confirming the assertion throws, then restoring and confirming a clean pass — matching this session's established red-green discipline for a safety-net check that has no other way to prove it's load-bearing.
- **Mixed-connection rejection test**: two listings with different `connectionId` values in one request → `ShoplineBulkFormError` with `mixed_source_connections`; a same-`connectionId`-different-`sourceImportId` batch continues to succeed (proving the deliberately-not-required dimension really isn't required).
- Re-run the existing `bulk-form.test.ts`, `bulk-form-xlsx.test.ts`, `bulk-export-service.test.ts`, `apps/web/app/api/listings/export/route.test.ts`, and `apps/web/lib/delivery-service.test.ts` (or wherever the single-row delivery path's tests live) suites in full to confirm nothing regresses.

## 7. Explicitly out of scope (deferred, per user decision)

- **Manifest diagnostic fields** — changed-cell counts per field, the neutralized-delta list, source/output digests. `createBulkFormUpdate` already computes `changes`/`neutralizedQuantityDeltas`; `createBulkExport` currently discards both. Wiring them into the persisted `export_attempts` manifest is cheap (no schema migration needed, `manifest` is an unstructured jsonb column) but is diagnostic detail, not a safety gap — left as a follow-up.
- **`/jobs` reconciliation / manual SHOPLINE import-result recording** — a separate, larger gap the same audit found (no mechanism exists for recording what SHOPLINE actually accepted after a manual re-import). Out of scope for this fix; belongs with Package K's own runbook work.
- **A tested rollback-source-file procedure** — also out of scope here; a Package K runbook concern, not a code fix.

## 8. Self-review

- **Placeholder scan:** none — the fix's exact diff, the reparse-and-assert's exact comparison, and the mixed-source check's exact rejection mechanism are all specified concretely.
- **Internal consistency:** §3's fix, §4's reparse-and-assert, and §5's mixed-source check are three independent, additive changes to the same two files (`bulk-form.ts`, `bulk-export-service.ts`) — none depends on the others being implemented in a particular order, though §3 must land before §4's assertion has anything correct to verify against.
- **Scope check:** appropriately sized for a single implementation plan — three related fixes to one feature, not a redesign.
- **Ambiguity check:** the two points with more than one reasonable resolution (PR scope: core-bug-only vs. everything; sourceImportId vs. connectionId as the mixed-source dimension) were both resolved explicitly with the user before this document was written.
