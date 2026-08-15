import type { BulkFormGapsInput } from "./bulk-form.js";

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
 * - `Product Cost` is absent. It is the merchant's wholesale price, it has no
 *   bearing on customer-facing copy, and it must not reach a prompt.
 *
 * Every line becomes potential evidence that `extract` may quote, so lines
 * carry only what the form states, never interpretation.
 */
export function renderBulkFormSource(raw: BulkFormGapsInput): string {
  const lines: string[] = [];
  const push = (label: string, value: string | null | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0) return;
    lines.push(`${label}: ${trimmed}`);
  };

  push("Product name", raw.nameEn);
  push("SKU", raw.sku);

  // Newlines separate complete category paths; each becomes its own line so a
  // multi-category product does not read as one nonsensical path.
  for (const path of (raw.onlineStoreCategories ?? "").split(/\r?\n/)) {
    const segments = path
      .split(">")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (segments.length > 0) lines.push(`Categories: ${segments.join(" > ")}`);
  }

  push("Brand", raw.brand);
  push("Regular price (HKD)", raw.regularPrice);
  push("Sale price (HKD)", raw.salePrice);
  push("Stock quantity", raw.quantity);
  push("Barcode", raw.barcode);
  push("Manufacturer part number", raw.mpn);
  push("Supplier", raw.supplier);
  push("Promotion label", raw.promotionLabelEn);

  return lines.join("\n");
}
