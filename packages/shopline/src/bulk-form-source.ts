import type {
  BulkFormColumnKey,
  BulkFormEnrichableColumn,
  BulkFormGapsInput,
} from "./bulk-form.js";

/**
 * Columns this renderer is allowed to read.
 *
 * Derived from the enrichable set rather than restated, so adding a ninth
 * enrichable column automatically removes it here and `tsc` — which is what
 * `pnpm lint` runs — fails the build. The exclusion is therefore a compile
 * gate that cannot drift, rather than a convention a future edit could quietly
 * break.
 *
 * The two cost columns are excluded for a different reason: they are the
 * merchant's wholesale buying price, not a customer-facing fact.
 */
type SourceColumn = Exclude<
  BulkFormColumnKey,
  BulkFormEnrichableColumn | "productCost" | "variantCost"
>;

/**
 * Renders a stored bulk-form row as a plain-text document for the `extract`
 * step, which reads it as the draft's note.
 *
 * Two exclusions are deliberate and load-bearing:
 *
 * - The enrichable columns (Chinese name, summary, SEO fields) are absent.
 *   Those are what `generate` is about to write; for 499 of the pilot's 500
 *   products the Chinese name is just the English one, and feeding that back in
 *   as a source invites the model to reproduce the placeholder.
 * - The cost columns are absent. They are the merchant's wholesale price, they
 *   have no bearing on customer-facing copy, and they must not reach a prompt.
 *
 * Every line becomes potential evidence that `extract` may quote, so lines
 * carry only what the form states, never interpretation.
 */
export function renderBulkFormSource(raw: BulkFormGapsInput): string {
  const lines: string[] = [];
  const push = (label: string, key: SourceColumn): void => {
    // Collapse interior whitespace, not just the ends. A newline inside a cell
    // would emit an unlabelled orphan line, which `extract` could quote as
    // evidence with nothing identifying what it describes — exactly what the
    // labelled-line format exists to prevent.
    const trimmed = raw[key]?.replace(/\s+/g, " ").trim();
    if (trimmed === undefined || trimmed.length === 0) return;
    lines.push(`${label}: ${trimmed}`);
  };

  push("Product name", "nameEn");
  push("SKU", "sku");

  // Read directly rather than through `push`: newlines separate complete
  // category paths here, so collapsing them would merge two categories into one
  // nonsensical path.
  for (const path of (raw.onlineStoreCategories ?? "").split(/\r?\n/)) {
    const segments = path
      .split(">")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (segments.length > 0) lines.push(`Categories: ${segments.join(" > ")}`);
  }

  push("Brand", "brand");
  push("Regular price (HKD)", "regularPrice");
  push("Sale price (HKD)", "salePrice");
  push("Stock quantity", "quantity");
  push("Barcode", "barcode");
  push("Manufacturer part number", "mpn");
  push("Supplier", "supplier");
  push("Promotion label", "promotionLabelEn");

  return lines.join("\n");
}
