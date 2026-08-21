import { describe, expect, it } from "vitest";
import {
  canonicalListingSchema,
  workspaceProfileSchema,
} from "./listing-schema";

const validCanonicalListing = {
  sku: "OPAK-DEMO-001",
  title: {
    en: "Demo Estate Riesling 2024",
    "zh-Hant": "Demo Estate 雷司令 2024",
  },
  description: { en: "Dry Riesling.", "zh-Hant": "乾身雷司令。" },
  producer: "Demo Estate",
  productType: "wine" as const,
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
    description: { en: "Dry Mosel Riesling.", "zh-Hant": "Mosel 乾身雷司令。" },
  },
  tags: ["Riesling", "Mosel"],
  imageAssetIds: ["asset_demo_1"],
};

describe("canonicalListingSchema", () => {
  it("accepts an evidence-backed bilingual wine listing", () => {
    const parsed = canonicalListingSchema.parse(validCanonicalListing);

    expect(parsed.priceHkd).toBe(288);
  });

  it("rejects a negative price on an otherwise valid listing", () => {
    expect(() =>
      canonicalListingSchema.parse({ ...validCanonicalListing, priceHkd: -1 }),
    ).toThrow();
  });

  it("rejects an alcohol value above 100 on an otherwise valid listing", () => {
    expect(() =>
      canonicalListingSchema.parse({
        ...validCanonicalListing,
        abvPercent: 101,
      }),
    ).toThrow();
  });
});

const validWorkspaceProfileWithoutBrandColor = {
  name: "Opak Cellar",
  currency: "HKD" as const,
  locales: ["en", "zh-Hant"] as const,
  tone: "clear and restrained",
  claimPolicy: ["No invented claims"],
  requiredFields: ["sku", "priceHkd"],
};

describe("workspaceProfileSchema", () => {
  it("accepts a legacy profile row where brandBackgroundColor is entirely absent, defaulting it to null", () => {
    const parsed = workspaceProfileSchema.parse(
      validWorkspaceProfileWithoutBrandColor,
    );

    expect(parsed.brandBackgroundColor).toBeNull();
  });

  it("accepts an explicit null brandBackgroundColor", () => {
    const parsed = workspaceProfileSchema.parse({
      ...validWorkspaceProfileWithoutBrandColor,
      brandBackgroundColor: null,
    });

    expect(parsed.brandBackgroundColor).toBeNull();
  });

  it("accepts a valid six-digit hex brandBackgroundColor", () => {
    const parsed = workspaceProfileSchema.parse({
      ...validWorkspaceProfileWithoutBrandColor,
      brandBackgroundColor: "#1a2b3c",
    });

    expect(parsed.brandBackgroundColor).toBe("#1a2b3c");
  });

  it("rejects a malformed brandBackgroundColor", () => {
    expect(() =>
      workspaceProfileSchema.parse({
        ...validWorkspaceProfileWithoutBrandColor,
        brandBackgroundColor: "not-a-color",
      }),
    ).toThrow();
  });
});
