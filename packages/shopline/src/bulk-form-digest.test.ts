import { describe, expect, it } from "vitest";

import { BULK_FORM_COLUMNS, parseBulkForm, type BulkFormColumnKey } from "./bulk-form.js";
import { hashBulkFormRow } from "./bulk-form-digest.js";

const HEADER_EN = BULK_FORM_COLUMNS.map((column) => column.en);
const HEADER_ZH = BULK_FORM_COLUMNS.map((column) => column.zh);

const DEFAULTS: Partial<Record<BulkFormColumnKey, string>> = {
  productId: "aaaaaaaaaaaaaaaaaaaaaa01",
  nameEn: "Demo Estate Riesling 2024",
  nameZh: "Demo Estate Riesling 2024",
  sku: "0001",
  regularPrice: "100.0",
  salePrice: "80.0",
  quantity: "6",
  updateQuantity: "+0",
  onlineStoreCategories: "White Wine>Germany>Mosel",
};

const rowFor = (overrides: Partial<Record<BulkFormColumnKey, string>> = {}) =>
  BULK_FORM_COLUMNS.map((column) => overrides[column.key] ?? DEFAULTS[column.key] ?? "");

const rawRowFor = (overrides: Partial<Record<BulkFormColumnKey, string>> = {}) => {
  const parsed = parseBulkForm([HEADER_EN, HEADER_ZH, rowFor(overrides)]);
  const row = parsed.rows[0];
  if (row === undefined) throw new Error("fixture row did not parse");
  return row.raw;
};

describe("hashBulkFormRow", () => {
  it("returns the same digest for the same cells", () => {
    expect(hashBulkFormRow(rawRowFor())).toBe(hashBulkFormRow(rawRowFor()));
  });

  it("ignores object key insertion order", () => {
    const raw = rawRowFor();
    const reversed = Object.fromEntries(
      Object.entries(raw).reverse(),
    ) as typeof raw;

    expect(hashBulkFormRow(reversed)).toBe(hashBulkFormRow(raw));
  });

  it("changes when any cell changes", () => {
    const baseline = hashBulkFormRow(rawRowFor());

    expect(hashBulkFormRow(rawRowFor({ nameZh: "示範酒莊麗絲玲 2024" }))).not.toBe(baseline);
    expect(hashBulkFormRow(rawRowFor({ salePrice: "70.0" }))).not.toBe(baseline);
  });

  it("emits a hex sha-256", () => {
    expect(hashBulkFormRow(rawRowFor())).toMatch(/^[0-9a-f]{64}$/);
  });
});
