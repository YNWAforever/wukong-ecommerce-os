import {
  BULK_FORM_COLUMNS,
  BULK_FORM_ENRICHABLE_COLUMNS,
  parseBulkForm,
  type BulkFormColumnKey,
  type BulkFormSheet,
} from "./bulk-form.js";
export const FRESH_EXPORT_POLICY_VERSION = "fresh-export-v1" as const;
export const MAX_COMPARISON_ROWS = 5000;
export const MAX_COMPARISON_EVIDENCE_BYTES = 2 * 1024 * 1024;
export type ComparisonOutcome =
  "matches_compared_fields" | "differences_found" | "inconclusive";
export type ComparisonRow = { rowNumber: number; cells: (string | null)[] };
export type ComparisonField = {
  column: BulkFormColumnKey;
  category: "intended" | "protected";
  expected: string | null;
  observed: string | null;
  different: boolean;
};
export type QuantityDeltaObservation = {
  column: "updateQuantity" | "updateVariantQuantity";
  expected: string | null;
  observed: string | null;
};
export type ProductComparison = {
  productId: string;
  outcome:
    "matched" | "differences" | "missing" | "ambiguous" | "unsupported_variant";
  expectedRow: ComparisonRow;
  observedRows: ComparisonRow[];
  fields: ComparisonField[];
  quantityDeltaObservations: QuantityDeltaObservation[];
};
export type FreshExportComparison = {
  policyVersion: typeof FRESH_EXPORT_POLICY_VERSION;
  outcome: ComparisonOutcome;
  counts: {
    expected: number;
    matched: number;
    differences: number;
    missing: number;
    ambiguous: number;
    unsupportedVariant: number;
    unrelatedRows: number;
    suppliedRows: number;
  };
  products: ProductComparison[];
};
export class FreshExportComparisonError extends Error {
  constructor(
    public code:
      | "comparison_workbook_invalid"
      | "comparison_input_too_large"
      | "export_membership_mismatch",
  ) {
    super(code);
    this.name = "FreshExportComparisonError";
  }
}
const fail = (code: FreshExportComparisonError["code"]): never => {
  throw new FreshExportComparisonError(code);
};
const normalize = (cell: string | null | undefined): string | null =>
  cell == null || cell.trim() === "" ? null : cell;
const deltaKeys = ["updateQuantity", "updateVariantQuantity"] as const;
/** Uses the existing parser's header contract, but retains rejected/duplicate rows as evidence. */
function rows(sheet: BulkFormSheet): ComparisonRow[] {
  if (sheet.length > MAX_COMPARISON_ROWS + 2)
    fail("comparison_input_too_large");
  let units = 0;
  for (const row of sheet) {
    if (row.length > 71 && row.slice(71).some((c) => normalize(c) !== null))
      fail("comparison_workbook_invalid");
    for (const cell of row) {
      if (cell !== null && typeof cell !== "string")
        fail("comparison_workbook_invalid");
      if ((cell?.length ?? 0) > 32767) fail("comparison_input_too_large");
      units += cell?.length ?? 0;
    }
  }
  if (units > MAX_COMPARISON_EVIDENCE_BYTES) fail("comparison_input_too_large");
  const parsed = parseBulkForm(sheet);
  if (parsed.headerRow !== 1 || parsed.localeHeaderRow !== 2)
    fail("comparison_workbook_invalid");
  const start = parsed.localeHeaderRow ?? 1;
  const result: ComparisonRow[] = [];
  for (let i = start; i < sheet.length; i++) {
    const row = sheet[i]!;
    if (row.every((c) => normalize(c) === null)) continue;
    const cells = BULK_FORM_COLUMNS.map((_, index) => normalize(row[index]));
    if (cells[0] === null) fail("comparison_workbook_invalid");
    result.push({ rowNumber: i + 1, cells });
  }
  if (result.length > MAX_COMPARISON_ROWS) fail("comparison_input_too_large");
  return result;
}
export function compareFreshExport(input: {
  delivered: BulkFormSheet;
  supplied: BulkFormSheet;
  productIds: readonly string[];
}): FreshExportComparison {
  const expected = rows(input.delivered),
    observed = rows(input.supplied);
  const ids = new Set(input.productIds);
  if (
    ids.size === 0 ||
    ids.size !== input.productIds.length ||
    expected.length !== ids.size
  )
    fail("export_membership_mismatch");
  const expectedMap = new Map<string, ComparisonRow>();
  const variantIndex = BULK_FORM_COLUMNS.findIndex(
    (c) => c.key === "variantId",
  );
  for (const row of expected) {
    const id = row.cells[0]!;
    if (!ids.has(id) || expectedMap.has(id) || row.cells[variantIndex] !== null)
      fail("export_membership_mismatch");
    expectedMap.set(id, row);
  }
  const observedMap = new Map<string, ComparisonRow[]>();
  let unrelatedRows = 0;
  for (const row of observed) {
    const id = row.cells[0]!;
    if (!ids.has(id)) {
      unrelatedRows++;
      continue;
    }
    const matches = observedMap.get(id) ?? [];
    matches.push(row);
    observedMap.set(id, matches);
  }
  const products: ProductComparison[] = input.productIds.map((productId) => {
    const expectedRow = expectedMap.get(productId)!;
    const observedRows = observedMap.get(productId) ?? [];
    const base = {
      productId,
      expectedRow,
      observedRows,
      fields: [] as ComparisonField[],
      quantityDeltaObservations: [] as QuantityDeltaObservation[],
    };
    if (observedRows.length === 0) return { ...base, outcome: "missing" };
    if (observedRows.length > 1) return { ...base, outcome: "ambiguous" };
    const actual = observedRows[0]!;
    if (actual.cells[variantIndex] !== null)
      return { ...base, outcome: "unsupported_variant" };
    BULK_FORM_COLUMNS.forEach((column, index) => {
      const expected = expectedRow.cells[index] ?? null,
        observed = actual.cells[index] ?? null;
      if ((deltaKeys as readonly string[]).includes(column.key)) {
        base.quantityDeltaObservations.push({
          column: column.key as QuantityDeltaObservation["column"],
          expected,
          observed,
        });
        return;
      }
      base.fields.push({
        column: column.key,
        category: (BULK_FORM_ENRICHABLE_COLUMNS as readonly string[]).includes(
          column.key,
        )
          ? "intended"
          : "protected",
        expected,
        observed,
        different: expected !== observed,
      });
    });
    return {
      ...base,
      outcome: base.fields.some((f) => f.different) ? "differences" : "matched",
    };
  });
  const count = (outcome: ProductComparison["outcome"]) =>
    products.filter((p) => p.outcome === outcome).length;
  const counts = {
    expected: ids.size,
    matched: count("matched"),
    differences: count("differences"),
    missing: count("missing"),
    ambiguous: count("ambiguous"),
    unsupportedVariant: count("unsupported_variant"),
    unrelatedRows,
    suppliedRows: observed.length,
  };
  const result: FreshExportComparison = {
    policyVersion: FRESH_EXPORT_POLICY_VERSION,
    outcome:
      counts.missing + counts.ambiguous + counts.unsupportedVariant > 0
        ? "inconclusive"
        : counts.differences > 0
          ? "differences_found"
          : "matches_compared_fields",
    counts,
    products,
  };
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    MAX_COMPARISON_EVIDENCE_BYTES
  )
    fail("comparison_input_too_large");
  return result;
}
