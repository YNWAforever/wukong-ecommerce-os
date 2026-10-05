import { describe, expect, it } from "vitest";
import { emptyWorkingListing } from "./working-listing.js";
import {
  contentFields,
  contentFieldSelectionSchema,
  mergeMaintenanceCopy,
} from "./maintenance-content-fields.js";

describe("maintenance copy whitelist", () => {
  it("accepts exactly the eight authorized columns and rejects commercial/identity fields", () => {
    expect(contentFields).toEqual([
      "nameZh",
      "summaryEn",
      "summaryZh",
      "seoTitleEn",
      "seoTitleZh",
      "seoDescriptionEn",
      "seoDescriptionZh",
      "seoKeywords",
    ]);
    for (const field of [
      "sku",
      "price",
      "stock",
      "nameEn",
      "id",
      "descriptionEn",
      "imageAssetIds",
    ])
      expect(
        contentFieldSelectionSchema.safeParse(["nameZh", field]).success,
      ).toBe(false);
    expect(contentFieldSelectionSchema.safeParse([]).success).toBe(false);
    expect(
      contentFieldSelectionSchema.safeParse(["nameZh", "nameZh"]).success,
    ).toBe(false);
  });

  it("adopts only selected copy and retains commercial facts, unknown pack and unselected copy", () => {
    const saved = {
      ...emptyWorkingListing(),
      sku: "000012",
      priceHkd: 123,
      packQuantity: null,
      title: { en: "Original", "zh-Hant": "" },
      description: { en: "Keep summary", "zh-Hant": "" },
    };
    const candidate = {
      ...saved,
      sku: "AI-SKU",
      priceHkd: 1,
      packQuantity: 1,
      title: { en: "AI English", "zh-Hant": "建議中文" },
      description: { en: "AI summary", "zh-Hant": "AI summary" },
    };
    const result = mergeMaintenanceCopy(saved, {}, candidate, ["nameZh"]);
    expect(result).toEqual({
      ...saved,
      title: { ...saved.title, "zh-Hant": "建議中文" },
    });
  });

  it("retains human ownership and locked values even when those fields are selected", () => {
    const saved = {
      ...emptyWorkingListing(),
      title: { en: "Original", "zh-Hant": "人工中文" },
      seo: {
        title: { en: "", "zh-Hant": "人工 SEO" },
        description: { en: "", "zh-Hant": "" },
      },
    };
    const candidate = {
      ...saved,
      title: { ...saved.title, "zh-Hant": "AI" },
      seo: { ...saved.seo, title: { ...saved.seo.title, "zh-Hant": "AI" } },
    };
    const state = {
      state: "manual" as const,
      owner: "operator" as const,
      locked: false,
      evidenceRefs: [],
    };
    expect(
      mergeMaintenanceCopy(
        saved,
        {
          "title.zh-Hant": state,
          "seo.title.zh-Hant": { ...state, owner: "ai", locked: true },
        },
        candidate,
        ["nameZh", "seoTitleZh"],
      ),
    ).toEqual(saved);
  });
});
