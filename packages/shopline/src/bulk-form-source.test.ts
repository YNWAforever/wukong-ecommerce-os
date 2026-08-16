import { describe, expect, it } from "vitest";

import { BULK_FORM_ENRICHABLE_COLUMNS } from "./bulk-form.js";
import { renderBulkFormSource } from "./bulk-form-source.js";

const row = {
  nameEn: "Demo Estate Riesling 2024",
  nameZh: "PLACEHOLDER SHOULD NOT APPEAR",
  seoTitleEn: "SEO PLACEHOLDER SHOULD NOT APPEAR",
  seoKeywords: "KEYWORD PLACEHOLDER SHOULD NOT APPEAR",
  summaryEn: "SUMMARY PLACEHOLDER SHOULD NOT APPEAR",
  // All eight enrichable columns are seeded so the exclusion assertion below is
  // as strong as the implementation, not just a sample of it.
  summaryZh: "SUMMARY ZH PLACEHOLDER SHOULD NOT APPEAR",
  seoTitleZh: "SEO ZH PLACEHOLDER SHOULD NOT APPEAR",
  seoDescriptionEn: "SEO DESC PLACEHOLDER SHOULD NOT APPEAR",
  seoDescriptionZh: "SEO DESC ZH PLACEHOLDER SHOULD NOT APPEAR",
  onlineStoreCategories: "White Wine>Germany>Mosel\nTop Picks",
  regularPrice: "100.0",
  salePrice: "80.0",
  productCost: "40.0",
  sku: "0001",
  quantity: "6",
  barcode: "1234567890123",
  supplier: "Demo Supplier Ltd",
  promotionLabelEn: "1500ML",
};

describe("renderBulkFormSource", () => {
  it("renders the stated product facts as labelled lines", () => {
    const source = renderBulkFormSource(row);

    expect(source).toContain("Product name: Demo Estate Riesling 2024");
    expect(source).toContain("SKU: 0001");
    expect(source).toContain("Categories: White Wine > Germany > Mosel");
    expect(source).toContain("Categories: Top Picks");
    expect(source).toContain("Regular price: HK$100");
    expect(source).toContain("Sale price: HK$80");
    expect(source).toContain("Barcode: 1234567890123");
    expect(source).toContain("Supplier: Demo Supplier Ltd");
    expect(source).toContain("Promotion label: 1500ML");
  });

  it("never renders the merchant's wholesale cost", () => {
    // Product Cost is the merchant's buying price. It has no bearing on
    // customer-facing copy and must not reach a prompt.
    expect(renderBulkFormSource(row)).not.toContain("40.0");
    expect(renderBulkFormSource(row).toLowerCase()).not.toContain("cost");
  });

  it("never renders the fields that are about to be generated", () => {
    // Feeding the existing placeholder Chinese name or SEO text back in as a
    // source invites the model to reproduce it.
    expect(renderBulkFormSource(row)).not.toContain("PLACEHOLDER");
  });

  it("writes prices as currency amounts extraction can read", () => {
    // Measured against the extraction step: a bare "Regular price (HKD): 750.0"
    // does not extract at all, while "HK$750" does. `priceHkd` is required on
    // the canonical listing, so a price that cannot be read has to be invented
    // downstream. This format matches fixtures/opak/supplier-sheet.txt.
    const source = renderBulkFormSource({
      regularPrice: "750.0",
      salePrice: "620.0",
    });

    expect(source).toContain("Regular price: HK$750");
    expect(source).toContain("Sale price: HK$620");
  });

  it("omits a zero or unparsable price rather than claiming it is free", () => {
    // A 0.0 sale price means "not on sale" in this form, not "costs nothing".
    const source = renderBulkFormSource({
      regularPrice: "750.0",
      salePrice: "0.0",
    });

    expect(source).toContain("Regular price: HK$750");
    expect(source).not.toContain("Sale price");
  });

  it("omits blank fields rather than emitting empty labels", () => {
    const source = renderBulkFormSource({ nameEn: "Only a name", sku: null });

    expect(source).toBe("Product name: Only a name");
  });

  it("excludes every enrichable column, derived from the contract", () => {
    // Derived rather than hand-listed: adding a ninth enrichable column extends
    // this assertion automatically instead of silently passing.
    const seeded = Object.fromEntries(
      BULK_FORM_ENRICHABLE_COLUMNS.map((key) => [key, "DO-NOT-RENDER-" + key]),
    );

    expect(renderBulkFormSource({ ...row, ...seeded })).not.toContain(
      "DO-NOT-RENDER",
    );
  });

  it("collapses a newline inside a cell instead of orphaning a line", () => {
    // An unlabelled line could be quoted as evidence with nothing saying what
    // it describes, which defeats the labelled-line format.
    const source = renderBulkFormSource({
      nameEn: "Demo Wine",
      supplier: "Acme Ltd\n123 Some Road",
    });

    expect(source).toBe(
      "Product name: Demo Wine\nSupplier: Acme Ltd 123 Some Road",
    );
  });

  it("renders the remaining stated fields", () => {
    const source = renderBulkFormSource({
      brand: "Demo Brand",
      mpn: "MPN-9",
      quantity: "6",
    });

    expect(source).toContain("Brand: Demo Brand");
    expect(source).toContain("Manufacturer part number: MPN-9");
    expect(source).toContain("Stock quantity: 6");
  });

  it("returns an empty string when the row states nothing usable", () => {
    expect(renderBulkFormSource({})).toBe("");
  });
});
