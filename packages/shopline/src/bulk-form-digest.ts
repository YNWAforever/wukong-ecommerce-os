import { createHash } from "node:crypto";

import { BULK_FORM_COLUMNS, type BulkFormRawRow } from "./bulk-form.js";

/**
 * Stable digest of one bulk-form row, used to tell an unchanged re-import from a
 * real catalog change.
 *
 * Cell order comes from the column contract rather than object key order, so a
 * snapshot taken today and one rebuilt from a fresh export hash identically when
 * the merchant changed nothing. Lives outside `bulk-form.ts` to keep that module
 * dependency-free, as its design doc states.
 */
export function hashBulkFormRow(raw: BulkFormRawRow): string {
  const ordered = BULK_FORM_COLUMNS.map((column) => [
    column.key,
    raw[column.key] ?? null,
  ]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
