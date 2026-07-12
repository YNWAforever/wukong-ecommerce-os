import { describe, expect, it } from "vitest";

import { FakeListingProvider } from "./fake-listing-provider.js";

describe("FakeListingProvider", () => {
  it("extracts only explicit note facts and returns missing protected facts", async () => {
    const provider = new FakeListingProvider();
    const result = await provider.extract({
      assets: [{ id: "asset_1", mimeType: "image/png", readUrl: "memory://label" }],
      note: "Demo Estate Riesling 2024, Germany, Mosel, 750ml, 12.5% ABV",
    });

    expect(result.facts).toMatchObject({
      producer: "Demo Estate",
      vintage: 2024,
      country: "Germany",
      region: "Mosel",
      volumeMl: 750,
      abvPercent: 12.5,
      priceHkd: null,
      stockQuantity: null,
      criticScores: [],
      awards: [],
    });
    expect(result.missingFields).toEqual(expect.arrayContaining(["priceHkd", "stockQuantity"]));
    expect(result.evidence.every((item) => item.sourceAssetId === "note")).toBe(true);
    expect(result.evidence.every((item) => result.facts[item.field as keyof typeof result.facts] !== null)).toBe(true);
    expect(result.usage).toMatchObject({ model: "fake-listing-provider", estimatedCostUsd: 0 });
  });

  it("sets product type only when the note says it explicitly", async () => {
    const provider = new FakeListingProvider();
    const grapeOnly = await provider.extract({ assets: [], note: "Demo Estate Riesling 2024" });
    expect(grapeOnly.facts.productType).toBeNull();

    const explicit = await provider.extract({ assets: [], note: "Demo Estate Riesling 2024, wine" });
    expect(explicit.facts.productType).toBe("wine");
    expect(explicit.evidence.find((item) => item.field === "productType")?.excerpt).toBe("wine");
  });

  it.each([
    "Demo Estate Riesling, Chardonnay 2024, wine, Germany, Mosel, 750ml, 12.5% ABV",
    "Demo Estate Riesling and Chardonnay 2024, wine, Germany, Mosel, 750ml, 12.5% ABV",
  ])("uses only verbatim evidence for each grape in %s", async (note) => {
    const result = await new FakeListingProvider().extract({ assets: [], note });
    const grapeEvidence = result.evidence.filter((item) => item.field === "grapeVarieties");

    expect(result.facts.grapeVarieties).toEqual(["Riesling", "Chardonnay"]);
    expect(grapeEvidence.map((item) => item.excerpt)).toEqual(["Riesling", "Chardonnay"]);
    expect(grapeEvidence.every((item) => note.includes(item.excerpt))).toBe(true);
  });

  it("generates deterministic bilingual copy from supplied facts without reading environment", async () => {
    const oldKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const provider = new FakeListingProvider();
      const extraction = await provider.extract({
        assets: [],
        note: "SKU OPAK-DEMO-001, Demo Estate Riesling 2024, wine, Germany, Mosel, Riesling, 750ml, 12.5% ABV, HK$288",
      });
      const result = await provider.generate({
        facts: extraction.facts,
        evidence: extraction.evidence,
        profile: {
          name: "Opak Cellar",
          currency: "HKD",
          locales: ["en", "zh-Hant"],
          tone: "clear and restrained",
          claimPolicy: ["No invented claims"],
          requiredFields: ["sku", "producer", "country", "volumeMl", "abvPercent", "priceHkd"],
        },
        imageAssetIds: ["asset_1"],
      });

      expect(result.listing.title.en).toContain("Demo Estate");
      expect(result.listing.title["zh-Hant"]).toContain("Demo Estate");
      expect(result.listing.priceHkd).toBe(288);
      expect(result.listing.imageAssetIds).toEqual(["asset_1"]);
    } finally {
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldKey;
    }
  });
});
