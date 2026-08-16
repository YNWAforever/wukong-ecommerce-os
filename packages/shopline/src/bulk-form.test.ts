import { describe, expect, it } from "vitest";

import headerFixture from "../fixtures/shopline-bulk-form-headers.json" with { type: "json" };

import {
  BULK_FORM_COLUMNS,
  BULK_FORM_ENRICHABLE_COLUMNS,
  BULK_FORM_LOCKED_COLUMNS,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
  ShoplineBulkFormError,
  bulkFormGaps,
  createBulkFormUpdate,
  isBulkFormRawRow,
  parseBulkForm,
  type BulkFormColumnKey,
  type BulkFormExportRow,
  type BulkFormIssueCode,
  type BulkFormSheet,
} from "./bulk-form.js";
import { SHOPLINE_TITLE_MAX_LENGTH } from "./validation.js";

const HEADER_EN = BULK_FORM_COLUMNS.map((column) => column.en);
const HEADER_ZH = BULK_FORM_COLUMNS.map((column) => column.zh);

/** A row that looks like the pilot export: every column filled plausibly. */
const DEFAULTS: Partial<Record<BulkFormColumnKey, string>> = {
  productId: "aaaaaaaaaaaaaaaaaaaaaa01",
  nameEn: "Demo Estate Riesling 2024",
  nameZh: "Demo Estate Riesling 2024",
  seoTitleEn: "Demo Estate Riesling 2024",
  seoTitleZh: "Demo Estate Riesling 2024",
  seoDescriptionEn: "Demo Estate Riesling 2024",
  seoDescriptionZh: "Demo Estate Riesling 2024",
  seoKeywords: "Demo Estate Riesling 2024",
  hiddenProduct: "N",
  preorderFeature: "N",
  onlineStoreStatus: "Y",
  retailStoreStatus: "N",
  hidePrice: "N",
  onlineStoreCategories: "White Wine>Germany>Mosel",
  regularPrice: "100.0",
  salePrice: "80.0",
  productRetailStorePrice: "80.0",
  memberPrice: "0.0",
  tradePrice: "0.0",
  unlimitedQuantity: "N",
  productCost: "40.0",
  sku: "0001",
  quantity: "6",
  updateQuantity: "+0",
  weightKg: "0.0",
  barcode: "1234567890123",
  slStockId: "bbbbbbbbbbbbbbbbbbbbbb01",
  warehouse: "Primary",
  productNotApplicableToDiscount: "N",
  slKey0: "cccccccccccccccccccccccccccccc01",
  slKey1: "dddddddddddddddddddddddddddddd01",
};

const dataRow = (
  overrides: Partial<Record<BulkFormColumnKey, string>> = {},
): string[] =>
  BULK_FORM_COLUMNS.map(
    (column) => overrides[column.key] ?? DEFAULTS[column.key] ?? "",
  );

const sheetOf = (...rows: readonly string[][]): BulkFormSheet => [
  HEADER_EN,
  HEADER_ZH,
  ...rows,
];

const codes = (
  issues: readonly { code: BulkFormIssueCode }[],
): BulkFormIssueCode[] => issues.map((issue) => issue.code);

describe("SHOPLINE bulk form column contract", () => {
  it("matches the headers of a real exported bulk update form", () => {
    expect(SHOPLINE_BULK_FORM_SPEC_VERSION).toBe(headerFixture.specVersion);
    expect(BULK_FORM_COLUMNS).toHaveLength(71);
    expect(HEADER_EN).toEqual(headerFixture.en);
    expect(HEADER_ZH).toEqual(headerFixture.zh);
  });

  it("keys every column uniquely and keeps locked and enrichable columns disjoint", () => {
    const keys = BULK_FORM_COLUMNS.map((column) => column.key);
    expect(new Set(keys).size).toBe(keys.length);

    for (const key of [
      ...BULK_FORM_LOCKED_COLUMNS,
      ...BULK_FORM_ENRICHABLE_COLUMNS,
    ]) {
      expect(keys).toContain(key);
    }
    const locked = new Set<string>(BULK_FORM_LOCKED_COLUMNS);
    expect(
      BULK_FORM_ENRICHABLE_COLUMNS.filter((key) => locked.has(key)),
    ).toEqual([]);
  });

  it("never exposes the English product name as enrichable", () => {
    expect(BULK_FORM_ENRICHABLE_COLUMNS).not.toContain("nameEn");
  });
});

describe("parseBulkForm", () => {
  it("skips both header rows and reports 1-based worksheet row numbers", () => {
    const result = parseBulkForm(
      sheetOf(dataRow(), dataRow({ productId: "p2", sku: "0002" })),
    );

    expect(result.headerRow).toBe(1);
    expect(result.localeHeaderRow).toBe(2);
    expect(result.rows.map((row) => row.rowNumber)).toEqual([3, 4]);
    expect(result.issues).toEqual([]);
  });

  it("preserves leading-zero SKUs as text", () => {
    const result = parseBulkForm(sheetOf(dataRow({ sku: "0001" })));

    expect(result.rows[0]?.sku).toBe("0001");
    expect(result.rows[0]?.facts.sku).toBe("0001");
  });

  it("splits a newline-separated category cell into complete paths", () => {
    const result = parseBulkForm(
      sheetOf(
        dataRow({
          onlineStoreCategories:
            "Champagne>Non-Vintage Champagne>Rose\nParty Wines Selection>Party Champagne Selection",
        }),
      ),
    );

    expect(result.rows[0]?.categories).toEqual([
      ["Champagne", "Non-Vintage Champagne", "Rose"],
      ["Party Wines Selection", "Party Champagne Selection"],
    ]);
  });

  it("keeps deep category paths intact", () => {
    const result = parseBulkForm(
      sheetOf(dataRow({ onlineStoreCategories: "A>B>C>D>E" })),
    );

    expect(result.rows[0]?.categories).toEqual([["A", "B", "C", "D", "E"]]);
  });

  it("reads the unlimited-stock sentinel in the numeric quantity column", () => {
    const result = parseBulkForm(
      sheetOf(dataRow({ quantity: "無限數量", unlimitedQuantity: "Y" })),
    );

    expect(result.rows[0]?.inventory).toMatchObject({
      unlimited: true,
      quantity: null,
    });
    expect(result.rows[0]?.facts.stockQuantity).toBeNull();
    expect(codes(result.issues)).toContain("quantity_unlimited_sentinel");
  });

  it("treats the unlimited flag alone as unlimited stock", () => {
    const result = parseBulkForm(
      sheetOf(dataRow({ quantity: "0", unlimitedQuantity: "Y" })),
    );

    expect(result.rows[0]?.inventory.unlimited).toBe(true);
    expect(result.rows[0]?.facts.stockQuantity).toBeNull();
  });

  it("clamps oversold stock to zero because canonical facts are nonnegative", () => {
    const result = parseBulkForm(sheetOf(dataRow({ quantity: "-1" })));

    expect(result.rows[0]?.facts.stockQuantity).toBe(0);
    expect(codes(result.issues)).toContain("quantity_negative");
  });

  it("reads a zero sale price as not on sale", () => {
    const onSale = parseBulkForm(
      sheetOf(dataRow({ regularPrice: "100.0", salePrice: "80.0" })),
    );
    const notOnSale = parseBulkForm(
      sheetOf(dataRow({ regularPrice: "100.0", salePrice: "0.0" })),
    );

    expect(onSale.rows[0]?.facts.priceHkd).toBe(80);
    expect(notOnSale.rows[0]?.facts.priceHkd).toBe(100);
  });

  it("warns about a non-neutral stock delta in the source", () => {
    const result = parseBulkForm(sheetOf(dataRow({ updateQuantity: "+5" })));

    expect(codes(result.issues)).toContain("quantity_delta_not_neutral");
    expect(result.rows).toHaveLength(1);
  });

  it("drops rows without a Product ID or SKU and keeps the rest", () => {
    const result = parseBulkForm(
      sheetOf(
        dataRow(),
        dataRow({ productId: "" }),
        dataRow({ productId: "p3", sku: "" }),
      ),
    );

    expect(result.rows).toHaveLength(1);
    expect(codes(result.issues)).toEqual(["product_id_missing", "sku_missing"]);
  });

  it("drops a duplicate Product ID and keeps the first occurrence", () => {
    const result = parseBulkForm(
      sheetOf(dataRow({ nameEn: "first" }), dataRow({ nameEn: "second" })),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.content.name.en).toBe("first");
    expect(codes(result.issues)).toEqual(["product_id_duplicated"]);
  });

  it("rejects a sheet whose columns do not match the contract", () => {
    const result = parseBulkForm([
      HEADER_EN.slice(0, 70),
      HEADER_ZH.slice(0, 70),
    ]);

    expect(result.rows).toEqual([]);
    expect(result.headerRow).toBeNull();
    expect(codes(result.issues)).toEqual(["header_row_missing"]);
  });

  it("skips fully blank rows without reporting them", () => {
    const result = parseBulkForm(
      sheetOf(
        dataRow(),
        BULK_FORM_COLUMNS.map(() => ""),
      ),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it("reads a row of trailing blanks as empty rather than dropping it", () => {
    // Worksheets omit trailing empty cells, so this is what a real short row is.
    const result = parseBulkForm(sheetOf(dataRow().slice(0, 40)));

    expect(codes(result.issues)).toContain("row_too_short");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.sku).toBe("0001");
    expect(result.rows[0]?.raw.slKey1).toBeNull();
  });

  it("parses a form that has no Traditional Chinese header row", () => {
    const result = parseBulkForm([HEADER_EN, dataRow()]);

    expect(result.localeHeaderRow).toBeNull();
    expect(result.rows.map((row) => row.rowNumber)).toEqual([2]);
  });
});

describe("bulk form facts prefill", () => {
  it("resolves product type past a merchandising category to the real one", () => {
    const result = parseBulkForm(
      sheetOf(
        dataRow({
          onlineStoreCategories:
            "Party Wines Selection>Party Red Wine Selection\nRed Wine>France>Bordeaux",
        }),
      ),
    );

    expect(result.rows[0]?.facts.productType).toBe("wine");
  });

  it("maps whisky and sake tops and leaves unknown tops null", () => {
    const sheet = sheetOf(
      dataRow({
        productId: "p1",
        onlineStoreCategories: "Whisky>Scotland>Islay",
      }),
      dataRow({
        productId: "p2",
        onlineStoreCategories: "Sake>Junmai Ginjo & Ginjo",
      }),
      dataRow({ productId: "p3", onlineStoreCategories: "Demo Consignment" }),
    );

    expect(
      parseBulkForm(sheet).rows.map((row) => row.facts.productType),
    ).toEqual(["spirits", "sake", null]);
  });

  it("leaves prose-derived facts for the extract step", () => {
    const facts = parseBulkForm(sheetOf(dataRow())).rows[0]?.facts;

    expect(facts).toMatchObject({
      producer: null,
      country: null,
      region: null,
      vintage: null,
      volumeMl: null,
      abvPercent: null,
      grapeVarieties: [],
      criticScores: [],
      awards: [],
      packQuantity: 1,
    });
  });

  it("warns when a row carries no category path", () => {
    const result = parseBulkForm(
      sheetOf(dataRow({ onlineStoreCategories: "" })),
    );

    expect(codes(result.issues)).toContain("categories_missing");
    expect(result.rows[0]?.facts.productType).toBeNull();
  });
});

describe("bulk form content gaps", () => {
  it("flags the pathologies the pilot catalog exhibits", () => {
    const result = parseBulkForm(sheetOf(dataRow()));

    expect(result.rows[0]?.gaps).toEqual({
      untranslatedName: true,
      untranslatedSeoTitle: true,
      seoTitleMirrorsName: true,
      seoDescriptionMirrorsSeoTitle: true,
      keywordsMirrorName: true,
      summaryMissing: true,
    });
  });

  it("clears each flag once the field carries real content", () => {
    const result = parseBulkForm(
      sheetOf(
        dataRow({
          nameZh: "示範酒莊麗絲玲 2024",
          seoTitleZh: "德國麗絲玲白酒 2024",
          seoTitleEn: "German Riesling 2024 | Demo Estate",
          seoDescriptionEn: "A dry Mosel Riesling with citrus and slate.",
          seoKeywords: "riesling, mosel, german white wine",
          summaryEn: "Dry Mosel Riesling.",
        }),
      ),
    );

    expect(result.rows[0]?.gaps).toEqual({
      untranslatedName: false,
      untranslatedSeoTitle: false,
      seoTitleMirrorsName: false,
      seoDescriptionMirrorsSeoTitle: false,
      keywordsMirrorName: false,
      summaryMissing: false,
    });
  });
});

describe("bulkFormGaps", () => {
  it("computes the same gaps from a stored row as the parser reports", () => {
    const parsed = parseBulkForm(sheetOf(dataRow()));
    const row = parsed.rows[0];
    if (row === undefined) throw new Error("fixture row did not parse");

    expect(bulkFormGaps(row.raw)).toEqual(row.gaps);
  });

  it("accepts a partial row, because a stored snapshot may omit blank columns", () => {
    expect(
      bulkFormGaps({ nameEn: "Demo Estate Riesling 2024", nameZh: null }),
    ).toMatchObject({ untranslatedName: true, summaryMissing: true });
  });

  it("treats a filled Chinese name as translated", () => {
    expect(
      bulkFormGaps({
        nameEn: "Demo Estate Riesling 2024",
        nameZh: "示範酒莊麗絲玲 2024",
      }).untranslatedName,
    ).toBe(false);
  });
});

describe("createBulkFormUpdate", () => {
  const parsed = () =>
    parseBulkForm(
      sheetOf(
        dataRow({ productId: "p1", sku: "0001" }),
        dataRow({ productId: "p2", sku: "0002" }),
      ),
    );

  it("changes only the enriched cells and echoes everything else", () => {
    const result = parsed();
    const update = createBulkFormUpdate(result.rows, [
      { productId: "p1", values: { nameZh: "示範酒莊麗絲玲 2024" } },
    ]);

    expect(update.sheet[0]).toEqual(HEADER_EN);
    expect(update.sheet[1]).toEqual(HEADER_ZH);
    expect(update.sheet).toHaveLength(3);

    const emitted = update.sheet[2] ?? [];
    BULK_FORM_COLUMNS.forEach((column, index) => {
      const expected =
        column.key === "nameZh"
          ? "示範酒莊麗絲玲 2024"
          : (result.rows[0]?.raw[column.key] ?? "");
      expect(emitted[index]).toBe(expected);
    });

    expect(update.changes).toEqual([
      {
        rowNumber: 3,
        productId: "p1",
        column: "nameZh",
        from: "Demo Estate Riesling 2024",
        to: "示範酒莊麗絲玲 2024",
      },
    ]);
  });

  it("omits untouched rows by default and keeps them on request", () => {
    const rows = parsed().rows;
    const enrichment = [
      { productId: "p1", values: { seoKeywords: "riesling, mosel" } },
    ];

    expect(createBulkFormUpdate(rows, enrichment).sheet).toHaveLength(3);
    expect(
      createBulkFormUpdate(rows, enrichment, { include: "all" }).sheet,
    ).toHaveLength(4);
  });

  it("neutralizes a stock delta rather than echoing it", () => {
    const result = parseBulkForm(
      sheetOf(dataRow({ productId: "p1", updateQuantity: "+5" })),
    );
    const update = createBulkFormUpdate(result.rows, [
      { productId: "p1", values: { seoKeywords: "riesling" } },
    ]);

    const deltaIndex = BULK_FORM_COLUMNS.findIndex(
      (column) => column.key === "updateQuantity",
    );
    expect(update.sheet[2]?.[deltaIndex]).toBe("+0");
    expect(update.neutralizedQuantityDeltas).toEqual([3]);
  });

  it("survives a round-trip back through the parser", () => {
    const update = createBulkFormUpdate(parsed().rows, [
      {
        productId: "p1",
        values: {
          nameZh: "示範酒莊麗絲玲 2024",
          seoKeywords: "riesling, mosel",
        },
      },
    ]);
    const reparsed = parseBulkForm(update.sheet);

    expect(reparsed.rows).toHaveLength(1);
    expect(reparsed.rows[0]?.content.name["zh-Hant"]).toBe(
      "示範酒莊麗絲玲 2024",
    );
    expect(reparsed.rows[0]?.content.seoKeywords).toBe("riesling, mosel");
    expect(reparsed.rows[0]?.sku).toBe("0001");
    expect(reparsed.rows[0]?.gaps.untranslatedName).toBe(false);
  });

  it("rejects enrichment that targets a locked or unknown column", () => {
    const rows = parsed().rows;

    expect(() =>
      createBulkFormUpdate(rows, [
        { productId: "p1", values: { productId: "x" } as never },
      ]),
    ).toThrow(ShoplineBulkFormError);
    expect(() =>
      createBulkFormUpdate(rows, [
        { productId: "p1", values: { regularPrice: "1" } as never },
      ]),
    ).toThrow(ShoplineBulkFormError);
    expect(() =>
      createBulkFormUpdate(rows, [
        { productId: "p1", values: { nameEn: "New name" } as never },
      ]),
    ).toThrow(ShoplineBulkFormError);
  });

  it("rejects an unknown Product ID, a duplicate, and an empty enrichment set", () => {
    const rows = parsed().rows;

    expect(() =>
      createBulkFormUpdate(rows, [
        { productId: "nope", values: { nameZh: "x" } },
      ]),
    ).toThrow(/not present in the parsed sheet/);
    expect(() =>
      createBulkFormUpdate(rows, [
        { productId: "p1", values: { nameZh: "x" } },
        { productId: "p1", values: { seoKeywords: "y" } },
      ]),
    ).toThrow(/more than once/);
    expect(() => createBulkFormUpdate(rows, [])).toThrow(
      /no enrichments supplied/,
    );
  });

  it("rejects blank values, over-long titles, and control characters", () => {
    const rows = parsed().rows;

    expect(() =>
      createBulkFormUpdate(rows, [
        { productId: "p1", values: { nameZh: "   " } },
      ]),
    ).toThrow(/must not be blank/);
    expect(() =>
      createBulkFormUpdate(rows, [
        {
          productId: "p1",
          values: { seoTitleZh: "字".repeat(SHOPLINE_TITLE_MAX_LENGTH + 1) },
        },
      ]),
    ).toThrow(/at most 255 characters/);
    expect(() =>
      createBulkFormUpdate(rows, [
        { productId: "p1", values: { seoDescriptionEn: "line one\nline two" } },
      ]),
    ).toThrow(/control characters/);
  });

  it("rejects an enrichment set that would change nothing", () => {
    const rows = parsed().rows;

    expect(() =>
      createBulkFormUpdate(rows, [
        { productId: "p1", values: { nameZh: "Demo Estate Riesling 2024" } },
      ]),
    ).toThrow(/already matches the source sheet/);
  });

  it("collects every enrichment issue before throwing", () => {
    const rows = parsed().rows;

    try {
      createBulkFormUpdate(rows, [
        { productId: "nope", values: { nameZh: "x" } },
        { productId: "p1", values: { nameZh: "  ", seoDescriptionEn: "a\tb" } },
      ]);
      expect.unreachable("expected ShoplineBulkFormError");
    } catch (error) {
      expect(error).toBeInstanceOf(ShoplineBulkFormError);
      expect(codes((error as ShoplineBulkFormError).issues)).toEqual([
        "enrichment_product_unknown",
        "enrichment_value_blank",
        "enrichment_value_control_characters",
      ] as never);
    }
  });
});

describe("isBulkFormRawRow", () => {
  it("accepts a row with every bulk-form column present", () => {
    const raw: Record<string, string | null> = {};
    for (const column of BULK_FORM_COLUMNS) raw[column.key] = null;
    expect(isBulkFormRawRow(raw)).toBe(true);
  });

  it("rejects a row missing a column", () => {
    const raw: Record<string, string | null> = {};
    for (const column of BULK_FORM_COLUMNS) raw[column.key] = null;
    delete raw[BULK_FORM_COLUMNS[0].key];
    expect(isBulkFormRawRow(raw)).toBe(false);
  });
});

describe("createBulkFormUpdate with a minimal export row", () => {
  it("accepts a BulkFormExportRow that carries only productId, raw, and rowNumber", () => {
    const raw: Record<BulkFormColumnKey, string | null> = Object.fromEntries(
      BULK_FORM_COLUMNS.map((column) => [column.key, ""]),
    ) as Record<BulkFormColumnKey, string | null>;
    raw.nameEn = "Demo Estate Riesling 2024";
    raw.nameZh = "Demo Estate Riesling 2024";

    // Deliberately NOT a BulkFormProductRow: no categories, pricing,
    // inventory, gaps, or facts. If createBulkFormUpdate's signature still
    // demanded the full parsed shape, this would fail to compile.
    const row: BulkFormExportRow = {
      productId: "remote_1",
      raw,
      rowNumber: 1,
    };

    const update = createBulkFormUpdate(
      [row],
      [{ productId: "remote_1", values: { nameZh: "示範莊園麗絲玲 2024" } }],
    );

    expect(update.changes).toEqual([
      {
        rowNumber: 1,
        productId: "remote_1",
        column: "nameZh",
        from: "Demo Estate Riesling 2024",
        to: "示範莊園麗絲玲 2024",
      },
    ]);
  });
});
