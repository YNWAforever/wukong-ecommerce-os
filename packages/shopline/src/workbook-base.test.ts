import { describe, expect, it } from "vitest";

import {
  BULK_FORM_COLUMNS,
  type BulkFormColumnKey,
  type BulkFormSheet,
} from "./bulk-form.js";
import {
  inferWorkbookExportTime,
  prepareWorkbookBase,
} from "./workbook-base.js";

const HEADER_EN = BULK_FORM_COLUMNS.map((column) => column.en);
const HEADER_ZH = BULK_FORM_COLUMNS.map((column) => column.zh);

const DEFAULTS: Partial<Record<BulkFormColumnKey, string>> = {
  productId: "product-1",
  nameEn: "Synthetic Riesling",
  nameZh: "合成麗斯玲",
  regularPrice: "120",
  salePrice: "98.5",
  sku: "0001",
  hiddenProduct: "N",
  preorderFeature: "N",
  onlineStoreStatus: "Y",
  retailStoreStatus: "N",
  hidePrice: "N",
  onlineStoreCategories: "White Wine>Germany",
  unlimitedQuantity: "N",
  quantity: "5",
  updateQuantity: "+0",
  productNotApplicableToDiscount: "N",
};

const dataRow = (
  overrides: Partial<Record<BulkFormColumnKey, string>> = {},
): string[] =>
  BULK_FORM_COLUMNS.map(
    (column) => overrides[column.key] ?? DEFAULTS[column.key] ?? "",
  );

const sheetOf = (...rows: readonly string[][]): BulkFormSheet => [
  ["Synthetic instructions"],
  HEADER_EN,
  HEADER_ZH,
  ...rows,
];

describe("inferWorkbookExportTime", () => {
  it("retains the filename's exact local date and time without a timezone", () => {
    expect(
      inferWorkbookExportTime(
        "synthetic-BulkUpdateForm-2026-05-21-15-50_0.xlsx",
      ),
    ).toEqual({
      value: "2026-05-21T15:50",
      source: "filename",
      timeZone: null,
    });
  });

  it("returns null for renamed files and impossible calendar dates", () => {
    expect(inferWorkbookExportTime("renamed.xlsx")).toBeNull();
    expect(
      inferWorkbookExportTime("x-BulkUpdateForm-2026-02-30-15-50.xlsx"),
    ).toBeNull();
    expect(
      inferWorkbookExportTime("x-BulkUpdateForm-2026-13-01-15-50.xlsx"),
    ).toBeNull();
  });

  it("retains future-looking dates only as untrusted filename inference", () => {
    expect(
      inferWorkbookExportTime("x-BulkUpdateForm-2099-12-31-23-59.xlsx"),
    ).toEqual({
      value: "2099-12-31T23:59",
      source: "filename",
      timeZone: null,
    });
  });
});

describe("prepareWorkbookBase", () => {
  it("projects eligible rows with bilingual titles, prices, raw cells, and original row numbers", () => {
    const first = dataRow({ barcode: "001234567890", salePrice: "98.5" });
    const second = dataRow({
      productId: "product-2",
      sku: "0002",
      nameEn: "Synthetic Chardonnay",
      nameZh: "合成莎當妮",
      regularPrice: "200",
      salePrice: "0",
    });
    const sheet = sheetOf(first, second);

    const prepared = prepareWorkbookBase(
      sheet,
      "BulkUpdateForm-2026-05-21-15-50.xlsx",
    );

    expect(BULK_FORM_COLUMNS).toHaveLength(71);
    expect(prepared.sheet).toBe(sheet);
    expect(prepared.totalRows).toBe(2);
    expect(prepared.excludedRows).toBe(0);
    expect(prepared.products).toHaveLength(2);
    expect(prepared.products[0]).toMatchObject({
      rowNumber: 4,
      productId: "product-1",
      sku: "0001",
      title: {
        en: "Synthetic Riesling",
        "zh-Hant": "合成麗斯玲",
      },
      priceHkd: 98.5,
      raw: { barcode: "001234567890" },
    });
    expect(prepared.products[0]?.raw).toEqual(
      Object.fromEntries(
        BULK_FORM_COLUMNS.map((column, index) => [
          column.key,
          first[index] || null,
        ]),
      ),
    );
    expect(prepared.products[1]).toMatchObject({
      rowNumber: 5,
      productId: "product-2",
      sku: "0002",
      title: {
        en: "Synthetic Chardonnay",
        "zh-Hant": "合成莎當妮",
      },
      priceHkd: 200,
    });
  });

  it("does not count instruction, header, locale-header, or blank rows", () => {
    const prepared = prepareWorkbookBase(
      sheetOf(
        [],
        dataRow(),
        BULK_FORM_COLUMNS.map(() => ""),
      ),
      "renamed.xlsx",
    );

    expect(prepared.totalRows).toBe(1);
    expect(prepared.products).toHaveLength(1);
    expect(prepared.inferredExportTime).toBeNull();
  });

  it("counts parser-rejected rows as explicit exclusions while retaining the source sheet", () => {
    const sheet = sheetOf(
      dataRow(),
      dataRow({ productId: "" }),
      dataRow({ productId: "product-3", sku: "" }),
      dataRow({ productId: "product-4", sku: "0004", variantId: "variant-1" }),
      dataRow({ nameEn: "duplicate" }),
    );

    const prepared = prepareWorkbookBase(sheet, "renamed.xlsx");

    expect(prepared.sheet).toBe(sheet);
    expect(prepared.totalRows).toBe(5);
    expect(prepared.products).toHaveLength(1);
    expect(prepared.excludedRows).toBe(4);
    expect(prepared.issues.map((issue) => issue.code)).toEqual([
      "product_id_missing",
      "sku_missing",
      "variant_row_blocked",
      "product_id_duplicated",
    ]);
  });

  it("returns parser issues and zero products for malformed headers", () => {
    const malformed: BulkFormSheet = [
      HEADER_EN.slice(0, 70),
      HEADER_ZH.slice(0, 70),
      dataRow(),
    ];

    const prepared = prepareWorkbookBase(malformed, "renamed.xlsx");

    expect(prepared.products).toEqual([]);
    expect(prepared.totalRows).toBe(0);
    expect(prepared.excludedRows).toBe(0);
    expect(prepared.issues.map((issue) => issue.code)).toEqual([
      "header_row_missing",
    ]);
  });
});
