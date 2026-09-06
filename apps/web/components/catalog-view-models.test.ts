import { describe, expect, it } from "vitest";

import { CATALOG_FILTERS, catalogStatusLabel } from "./catalog-view-models.js";

describe("catalog view models", () => {
  it("labels products without a Wukong draft explicitly", () => {
    expect(catalogStatusLabel(null)).toBe("未建立草稿 No draft");
  });
});

it("offers a distinct website filter and names the platform-only unlinked cohort", () => {
  expect(CATALOG_FILTERS.find((f) => f.value === "website")?.labelEn).toBe(
    "Website",
  );
  expect(CATALOG_FILTERS.find((f) => f.value === "unlinked")?.labelEn).toBe(
    "Unlinked platform",
  );
});

it("offers a workbook filter", () => {
  expect(CATALOG_FILTERS.find((f) => f.value === "workbook")?.labelEn).toBe(
    "Workbook",
  );
});
