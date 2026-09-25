import type { VerificationInput } from "./listing-verification.js";

const facts = {
  sku: "SYN-001",
  producer: "Example Estate",
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
};

export const verificationFixture: VerificationInput = {
  facts,
  listing: {
    ...facts,
    tags: ["Riesling"],
    imageAssetIds: [],
    title: {
      en: "Example Estate 2024 Riesling",
      "zh-Hant": "Example Estate 2024 雷司令",
    },
    description: {
      en: "German Riesling, 750 ml, 12.5% ABV.",
      "zh-Hant": "德國雷司令，750 毫升，酒精濃度 12.5%。",
    },
    seo: {
      title: {
        en: "Example Estate Riesling",
        "zh-Hant": "Example Estate 雷司令",
      },
      description: { en: "Mosel Riesling.", "zh-Hant": "摩澤爾雷司令。" },
    },
  },
  evidence: [],
  note: "Example Estate; Germany, Mosel; Riesling; vintage 2024; 750 ml; 12.5% ABV.",
};
