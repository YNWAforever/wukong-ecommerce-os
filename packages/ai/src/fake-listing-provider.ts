import {
  canonicalListingSchema,
  listingFactsSchema,
  type FieldEvidence,
  type ListingFacts,
} from "@wukong/core";

import {
  NOTE_SOURCE_ID,
  type AIUsage,
  type ExtractionInput,
  type ExtractionResult,
  type GenerationInput,
  type GenerationResult,
  type ListingAIProvider,
} from "./contracts.js";
import { EXTRACTION_PROMPT, GENERATION_PROMPT } from "./prompts.js";

const PROTECTED_FIELDS = [
  "sku",
  "producer",
  "productType",
  "country",
  "region",
  "vintage",
  "volumeMl",
  "abvPercent",
  "priceHkd",
  "stockQuantity",
] as const;

function usage(promptVersion: string): AIUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    latencyMs: 0,
    model: "fake-listing-provider",
    promptVersion,
  };
}

function capture(note: string, pattern: RegExp): string | null {
  return note.match(pattern)?.[1]?.trim() ?? null;
}

function numberCapture(note: string, pattern: RegExp): number | null {
  const value = capture(note, pattern);
  return value === null ? null : Number(value);
}

function noteEvidence(field: string, excerpt: string): FieldEvidence {
  return { field, sourceAssetId: NOTE_SOURCE_ID, page: null, excerpt, confidence: 1 };
}

export class FakeListingProvider implements ListingAIProvider {
  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const note = input.note?.trim() ?? "";
    const sku = capture(note, /\bSKU\s+([A-Z0-9-]+)/i);
    const vintage = numberCapture(note, /\b((?:18|19|20|21)\d{2})\b/);
    const volumeMl = numberCapture(note, /\b(\d{2,5})\s*ml\b/i);
    const abvPercent = numberCapture(note, /\b(\d+(?:\.\d+)?)\s*%\s*ABV\b/i);
    const priceHkd = numberCapture(note, /\bHK\$\s*(\d+(?:\.\d+)?)\b/i);
    const producer = capture(note, /(?:^|,\s*)([A-Za-z][A-Za-z ]+?)(?=\s+(?:Riesling|Cabernet|Chardonnay|Pinot|Sauvignon|Merlot|Shiraz)\b)/i);
    const country = /\bGermany\b/i.test(note) ? "Germany" : null;
    const region = /\bMosel\b/i.test(note) ? "Mosel" : null;
    const grapes = ["Riesling", "Cabernet Sauvignon", "Chardonnay", "Pinot Noir", "Sauvignon Blanc", "Merlot", "Shiraz"]
      .filter((grape) => new RegExp(`\\b${grape}\\b`, "i").test(note));

    const facts = listingFactsSchema.parse({
      sku,
      producer,
      productType: /\bwine\b/i.test(note)
        ? "wine"
        : /\bspirits?\b/i.test(note)
          ? "spirits"
          : /\bsake\b/i.test(note)
            ? "sake"
            : /\bproduct\s+type\s+other\b/i.test(note)
              ? "other"
              : null,
      country,
      region,
      vintage,
      grapeVarieties: grapes,
      volumeMl,
      abvPercent,
      packQuantity: 1,
      priceHkd,
      stockQuantity: null,
      criticScores: [],
      awards: [],
    });

    const evidence: FieldEvidence[] = [];
    const excerpts: Partial<Record<keyof ListingFacts, string>> = {
      sku: sku === null ? undefined : `SKU ${sku}`,
      producer: producer ?? undefined,
      productType: facts.productType ?? undefined,
      country: country ?? undefined,
      region: region ?? undefined,
      vintage: vintage === null ? undefined : String(vintage),
      grapeVarieties: grapes[0],
      volumeMl: volumeMl === null ? undefined : `${volumeMl}ml`,
      abvPercent: abvPercent === null ? undefined : `${abvPercent}% ABV`,
      priceHkd: priceHkd === null ? undefined : `HK$${priceHkd}`,
    };
    for (const [field, excerpt] of Object.entries(excerpts)) {
      if (excerpt && note.toLocaleLowerCase().includes(excerpt.toLocaleLowerCase())) {
        evidence.push(noteEvidence(field, excerpt));
      }
    }

    return {
      facts,
      evidence,
      missingFields: PROTECTED_FIELDS.filter((field) => facts[field] === null),
      usage: usage(EXTRACTION_PROMPT.version),
    };
  }

  async generate(input: GenerationInput): Promise<GenerationResult> {
    const { facts } = input;
    const required = {
      sku: facts.sku,
      producer: facts.producer,
      productType: facts.productType,
      country: facts.country,
      volumeMl: facts.volumeMl,
      abvPercent: facts.abvPercent,
      priceHkd: facts.priceHkd,
    };
    for (const [field, value] of Object.entries(required)) {
      if (value === null) throw new Error(`Fake generation requires ${field}`);
    }
    const vintage = facts.vintage === null ? "" : ` ${facts.vintage}`;
    const title = `${facts.producer}${vintage}`;
    const region = facts.region === null ? facts.country : `${facts.region}, ${facts.country}`;
    const description = `${facts.producer} ${facts.productType} from ${region}.`;
    const listing = canonicalListingSchema.parse({
      ...facts,
      ...required,
      title: { en: title, "zh-Hant": title },
      description: { en: description, "zh-Hant": `${facts.producer}，產自${region}。` },
      seo: {
        title: { en: title, "zh-Hant": title },
        description: { en: description, "zh-Hant": `${facts.producer}，產自${region}。` },
      },
      tags: [...facts.grapeVarieties, ...(facts.region === null ? [] : [facts.region])],
      imageAssetIds: input.imageAssetIds,
    });
    return { listing, usage: usage(GENERATION_PROMPT.version) };
  }
}
