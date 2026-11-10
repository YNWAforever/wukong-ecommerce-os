import { describe, expect, it } from "vitest";

import {
  supplierIntelPayloadFromContext,
  supplierIntelProposalPayloadSchema,
  type SupplierIntelContext,
} from "./supplier-intel";

const NOW = new Date("2026-11-11T10:00:00.000Z");

function context(
  overrides: Partial<SupplierIntelContext> = {},
): SupplierIntelContext {
  return {
    listingId: "listing-1",
    listingTitle: "Margaux 2019",
    workbook: {
      productId: "product-1",
      values: {
        supplier: "Demo Supplier Ltd",
        brand: "Chateau Demo",
        sku: "OPAK-001",
        productCost: "120.0",
        tradePrice: "150.0",
      },
      missingFields: ["barcode", "mpn"],
    },
    sourceImport: {
      importId: "import-1",
      receivedAt: "2026-11-08T10:00:00.000Z",
    },
    allowedEvidenceRefs: [
      "listing:listing-1:v1",
      "workbook:product-1",
      "source_import:import-1",
    ],
    ...overrides,
  };
}

describe("supplierIntelPayloadFromContext", () => {
  it("quotes only stored values and keeps the missing list", () => {
    const payload = supplierIntelPayloadFromContext(context(), NOW);
    expect(payload).not.toBeNull();
    expect(supplierIntelProposalPayloadSchema.safeParse(payload).success).toBe(
      true,
    );
    expect(payload?.fields.map((field) => field.field)).toEqual([
      "supplier",
      "brand",
      "sku",
      "productCost",
      "tradePrice",
    ]);
    expect(payload?.missingFields).toEqual(["barcode", "mpn"]);
    expect(payload?.asOf).toBe(NOW.toISOString());
  });

  it("cites both the workbook row and the source-import receipt", () => {
    const payload = supplierIntelPayloadFromContext(context(), NOW);
    for (const field of payload?.fields ?? []) {
      expect(field.evidenceRefs).toEqual([
        "workbook:product-1",
        "source_import:import-1",
      ]);
    }
    expect(payload?.limitations.map((line) => line.key)).toEqual([
      "studio.limit.supplier_not_applied",
      "studio.limit.supplier_website_unlinked",
      "studio.limit.supplier_fields_missing",
    ]);
  });

  it("omits the receipt ref when the receipt did not resolve", () => {
    const payload = supplierIntelPayloadFromContext(
      context({ sourceImport: null }),
      NOW,
    );
    expect(payload?.fields[0]?.evidenceRefs).toEqual(["workbook:product-1"]);
    expect(payload?.limitations.map((line) => line.key)).toContain(
      "studio.limit.supplier_source_import_unavailable",
    );
  });

  it("returns null without a linked workbook row", () => {
    expect(
      supplierIntelPayloadFromContext(
        context({ workbook: null, sourceImport: null }),
        NOW,
      ),
    ).toBeNull();
  });
});
