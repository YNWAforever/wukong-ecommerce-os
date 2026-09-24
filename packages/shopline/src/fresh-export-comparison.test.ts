import { describe, expect, it } from "vitest";
import {
  BULK_FORM_COLUMNS,
  BULK_FORM_ENRICHABLE_COLUMNS,
  type BulkFormColumnKey,
} from "./bulk-form.js";
import {
  compareFreshExport,
  FRESH_EXPORT_POLICY_VERSION,
} from "./fresh-export-comparison.js";
const row = (
  id: string,
  values: Partial<Record<BulkFormColumnKey, string>> = {},
) =>
  BULK_FORM_COLUMNS.map((c) =>
    c.key === "productId" ? id : (values[c.key] ?? ""),
  );
const sheet = (...rows: string[][]) => [
  BULK_FORM_COLUMNS.map((c) => c.en),
  BULK_FORM_COLUMNS.map((c) => c.zh),
  ...rows,
];
const compare = (expected: string[][], observed: string[][], ids = ["001"]) =>
  compareFreshExport({
    delivered: sheet(...expected),
    supplied: sheet(...observed),
    productIds: ids,
  });
describe("fresh export comparison", () => {
  it("accounts for all 71 columns as 8 intended, 61 protected and 2 delta observations", () => {
    const r = compare([row("001")], [row("001")]);
    expect(r.policyVersion).toBe(FRESH_EXPORT_POLICY_VERSION);
    expect(
      r.products[0]!.fields.filter((f) => f.category === "intended"),
    ).toHaveLength(8);
    expect(
      r.products[0]!.fields.filter((f) => f.category === "protected"),
    ).toHaveLength(61);
    expect(r.products[0]!.quantityDeltaObservations).toHaveLength(2);
    expect(r.outcome).toBe("matches_compared_fields");
  });
  it("matches exact IDs independently of row order or SKU and discloses extras", () => {
    const r = compare(
      [row("001"), row("1")],
      [row("1"), row("extra"), row("001")],
      ["001", "1"],
    );
    expect(r.counts).toMatchObject({ matched: 2, unrelatedRows: 1 });
    expect(compare([row("001")], [row("1")]).products[0]!.outcome).toBe(
      "missing",
    );
  });
  it.each(
    BULK_FORM_COLUMNS.filter(
      (c) =>
        ![
          "productId",
          "variantId",
          "updateQuantity",
          "updateVariantQuantity",
        ].includes(c.key),
    ),
  )("detects difference in $key", (c) => {
    const r = compare([row("001")], [row("001", { [c.key]: "changed" })]);
    expect(r.outcome).toBe("differences_found");
    expect(r.products[0]!.fields.find((f) => f.column === c.key)).toMatchObject(
      {
        expected: null,
        observed: "changed",
        different: true,
        category: (BULK_FORM_ENRICHABLE_COLUMNS as readonly string[]).includes(
          c.key,
        )
          ? "intended"
          : "protected",
      },
    );
  });
  it("retains duplicate target rows without choosing one", () => {
    const r = compare([row("001")], [row("001"), row("001", { sku: "other" })]);
    expect(r.products[0]).toMatchObject({
      outcome: "ambiguous",
      fields: [],
      observedRows: [{ rowNumber: 3 }, { rowNumber: 4 }],
    });
    expect(r.outcome).toBe("inconclusive");
  });
  it("does not call variants matched", () =>
    expect(
      compare([row("001")], [row("001", { variantId: "v" })]).products[0],
    ).toMatchObject({ outcome: "unsupported_variant", fields: [] }));
  it("shows blank and +0 deltas without grading stock neutrality", () => {
    const r = compare(
      [row("001")],
      [row("001", { updateQuantity: "+0", updateVariantQuantity: "-8" })],
    );
    expect(r.outcome).toBe("matches_compared_fields");
    expect(r.products[0]!.quantityDeltaObservations[0]).toMatchObject({
      expected: null,
      observed: "+0",
    });
  });
  it("normalizes only blank strings and missing trailing cells; preserves meaningful whitespace", () => {
    expect(compare([row("001", { sku: "  " })], [["001"]]).outcome).toBe(
      "matches_compared_fields",
    );
    expect(
      compare([row("001", { sku: " x " })], [row("001", { sku: "x" })]).outcome,
    ).toBe("differences_found");
  });
  it("rejects malformed or extra headers, excess cells, missing row IDs and oversized input", () => {
    for (const supplied of [
      [...[["bad"]], row("001")],
      [...sheet(row("001"))].map((r, i) => (i === 0 ? [...r, "extra"] : r)),
      sheet([...row("001"), "extra"]),
      sheet(row("", { sku: "orphan" })),
      sheet(row("001", { sku: "x".repeat(32768) })),
      sheet(...Array.from({ length: 5001 }, () => row("001"))),
    ]) {
      expect(() =>
        compareFreshExport({
          delivered: sheet(row("001")),
          supplied,
          productIds: ["001"],
        }),
      ).toThrow();
    }
  });
  it("rejects delivered membership mismatches, duplicates and unsupported variants", () => {
    for (const delivered of [
      sheet(row("other")),
      sheet(row("001"), row("001")),
      sheet(row("001", { variantId: "v" })),
    ])
      expect(() =>
        compareFreshExport({
          delivered,
          supplied: sheet(row("001")),
          productIds: ["001"],
        }),
      ).toThrow();
  });
});

it("rejects a malformed localized header instead of treating it as an unrelated product", () => {
  const supplied = sheet(row("001"));
  supplied[1]![3] = "wrong";
  expect(() =>
    compareFreshExport({
      delivered: sheet(row("001")),
      supplied,
      productIds: ["001"],
    }),
  ).toThrow("comparison_workbook_invalid");
});
it("refuses oversized retained evidence without truncating fields or duplicate rows", () => {
  const huge = row(
    "001",
    Object.fromEntries(
      BULK_FORM_COLUMNS.filter(
        (c) => !["productId", "variantId"].includes(c.key),
      ).map((c) => [c.key, "x".repeat(15000)]),
    ),
  );
  expect(() => compare([huge], [huge])).toThrow("comparison_input_too_large");
});
