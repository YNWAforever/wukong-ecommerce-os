import { it, expect } from "vitest";
import { summarizeCatalog, filterCatalogItemsServer } from "./catalog-contract";

it("counts workbook sources separately and searches only all/workbook cohorts", () => {
  const item = {
    sourceType: "workbook" as const,
    id: "book",
    title: "Workbook title",
    sku: "001-SKU",
    sourceProductId: "00012",
    createdAt: "now",
    updatedAt: "now",
    canExport: false as const,
  };
  expect(summarizeCatalog([item])).toMatchObject({
    total: 1,
    workbook: 1,
    website: 0,
    unlinked: 0,
    needsReview: 0,
    needsAttention: 0,
  });
  for (const q of ["workbook title", "001-sku", "00012"])
    expect(filterCatalogItemsServer([item], q, "workbook")).toEqual([item]);
  for (const filter of [
    "website",
    "attention",
    "review",
    "unlinked",
    "published",
  ] as const)
    expect(filterCatalogItemsServer([item], undefined, filter)).toEqual([]);
});
