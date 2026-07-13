import { workspaceProfileSchema, type WorkspaceProfile } from "@wukong/core";

export const opakProfile: WorkspaceProfile = workspaceProfileSchema.parse({
  name: "Opak Cellar",
  currency: "HKD",
  locales: ["en", "zh-Hant"],
  tone: "Knowledgeable, concise, premium, and non-exaggerated.",
  claimPolicy: [
    "ratings require evidence",
    "awards require evidence",
    "exclusivity claims require evidence",
    "health claims are blocked",
    "superlatives require review",
  ],
  requiredFields: [
    "sku",
    "producer",
    "productType",
    "country",
    "volumeMl",
    "abvPercent",
    "priceHkd",
  ],
});

export const OPAK_WORKSPACE_ID = "ws_opak";
export const OPAK_OPERATOR_ID = "user_opak_operator";
export const OPAK_PROMPT_KEY = "listing-generation";
export const OPAK_PROMPT_VERSION = "1.0.0";

export const opakPromptTemplate = [
  "Generate a SHOPLINE listing for Opak Cellar.",
  "Use English and Traditional Chinese, with a knowledgeable, concise, premium, non-exaggerated tone.",
  "Never invent ratings, awards, exclusivity, health effects, or superlatives; flag unsupported claims for review.",
  "Return only the structured listing fields required by the workspace profile.",
].join(" ");
