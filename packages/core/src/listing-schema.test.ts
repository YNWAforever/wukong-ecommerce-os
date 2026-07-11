import { describe, expect, it } from "vitest";
import { canonicalListingSchema } from "./listing-schema";

describe("canonicalListingSchema", () => {
  it("accepts an evidence-backed bilingual wine listing", () => {
    const parsed = canonicalListingSchema.parse({
      sku: "OPAK-DEMO-001",
      title: { en: "Demo Estate Riesling 2024", "zh-Hant": "Demo Estate 雷司令 2024" },
      description: { en: "Dry Riesling.", "zh-Hant": "乾身雷司令。" },
      producer: "Demo Estate",
      productType: "wine",
      country: "Germany",
      region: "Mosel",
      vintage: 2024,
      grapeVarieties: ["Riesling"],
      volumeMl: 750,
      abvPercent: 12.5,
      packQuantity: 1,
      priceHkd: 288,
      stockQuantity: null,
      criticScores: [],
      awards: [],
      seo: {
        title: { en: "Demo Riesling 2024", "zh-Hant": "Demo 雷司令 2024" },
        description: { en: "Dry Mosel Riesling.", "zh-Hant": "Mosel 乾身雷司令。" }
      },
      tags: ["Riesling", "Mosel"],
      imageAssetIds: ["asset_demo_1"]
    });

    expect(parsed.priceHkd).toBe(288);
  });

  it("rejects negative prices and impossible alcohol values", () => {
    expect(() => canonicalListingSchema.parse({ priceHkd: -1, abvPercent: 101 })).toThrow();
  });
});
