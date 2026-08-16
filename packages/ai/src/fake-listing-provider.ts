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

/**
 * A captured fact and the text the note actually used to state it.
 *
 * The excerpt is the matched substring rather than a re-spelling of the value,
 * because evidence must be quotable from the source. A note that writes
 * `SKU: DEMO0001` has to be quoted that way; emitting `SKU DEMO0001` would be a
 * quote the note does not contain.
 */
type Capture = { value: string; excerpt: string };

function capture(note: string, pattern: RegExp): Capture | null {
  const match = note.match(pattern);
  const value = match?.[1]?.trim();
  if (!match || value === undefined || value.length === 0) return null;
  return { value, excerpt: match[0].trim() };
}

function numberCapture(note: string, pattern: RegExp): Capture | null {
  const found = capture(note, pattern);
  if (found === null) return null;
  return Number.isFinite(Number(found.value)) ? found : null;
}

const numberOf = (found: Capture | null): number | null =>
  found === null ? null : Number(found.value);

function noteEvidence(field: string, excerpt: string): FieldEvidence {
  return {
    field,
    sourceAssetId: NOTE_SOURCE_ID,
    page: null,
    excerpt,
    confidence: 1,
  };
}

export class FakeListingProvider implements ListingAIProvider {
  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const note = input.note?.trim() ?? "";
    // Each pattern accepts both note shapes this codebase produces: the
    // comma-separated one-liner of the supplier-sheet fixture, and the labelled
    // lines `renderBulkFormSource` writes for an imported catalog row
    // (`SKU: DEMO0001`, `Stock quantity: 6`). Reading only the first meant every
    // imported draft failed to enrich under `AI_PROVIDER=fake`.
    const sku = capture(note, /\bSKU:?\s+([A-Z0-9-]+)/i);
    const vintage = numberCapture(note, /\b((?:18|19|20|21)\d{2})\b/);
    const volumeMl = numberCapture(note, /\b(\d{2,5})\s*ml\b/i);
    const abvPercent = numberCapture(note, /\b(\d+(?:\.\d+)?)\s*%\s*ABV\b/i);
    const priceHkd = numberCapture(note, /\bHK\$\s*(\d+(?:\.\d+)?)\b/i);
    const stockQuantity = numberCapture(
      note,
      /\bstock(?:\s+quantity)?:?\s+(\d+)\b/i,
    );
    // `:\s*` and the `m` flag let a producer be read out of a labelled line
    // (`Product name: Demo Estate Riesling 2024`), not only after a comma.
    const producer = capture(
      note,
      /(?:^|,\s*|:\s*)([A-Za-z][A-Za-z ]+?)(?=\s+(?:Riesling|Cabernet|Chardonnay|Pinot|Sauvignon|Merlot|Shiraz)\b)/im,
    );
    const country = /\bGermany\b/i.test(note) ? "Germany" : null;
    const region = /\bMosel\b/i.test(note) ? "Mosel" : null;
    const grapes = [
      "Riesling",
      "Cabernet Sauvignon",
      "Chardonnay",
      "Pinot Noir",
      "Sauvignon Blanc",
      "Merlot",
      "Shiraz",
    ].filter((grape) => new RegExp(`\\b${grape}\\b`, "i").test(note));

    const facts = listingFactsSchema.parse({
      sku: sku?.value ?? null,
      producer: producer?.value ?? null,
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
      vintage: numberOf(vintage),
      grapeVarieties: grapes,
      volumeMl: numberOf(volumeMl),
      abvPercent: numberOf(abvPercent),
      packQuantity: 1,
      priceHkd: numberOf(priceHkd),
      stockQuantity: numberOf(stockQuantity),
      criticScores: [],
      awards: [],
    });

    const evidence: FieldEvidence[] = [];
    const excerpts: Partial<Record<keyof ListingFacts, string>> = {
      sku: sku?.excerpt,
      // The producer's own name, not the match: the pattern consumes the `,` or
      // `:` that precedes it, and neither belongs in the quote.
      producer: producer?.value,
      productType: facts.productType ?? undefined,
      country: country ?? undefined,
      region: region ?? undefined,
      vintage: vintage?.excerpt,
      volumeMl: volumeMl?.excerpt,
      abvPercent: abvPercent?.excerpt,
      priceHkd: priceHkd?.excerpt,
      stockQuantity: stockQuantity?.excerpt,
    };
    for (const [field, excerpt] of Object.entries(excerpts)) {
      if (!excerpt) continue;
      const at = note.toLocaleLowerCase().indexOf(excerpt.toLocaleLowerCase());
      if (at < 0) continue;
      // Quote the note's own casing. `wine`, matched case-insensitively against
      // a `White Wine` category, has to be quoted as `Wine` — an excerpt that
      // differs from the source even in case is not a verbatim quote.
      evidence.push(noteEvidence(field, note.slice(at, at + excerpt.length)));
    }
    for (const grape of grapes) {
      evidence.push(noteEvidence("grapeVarieties", grape));
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
    const region =
      facts.region === null
        ? facts.country
        : `${facts.region}, ${facts.country}`;
    const description = `${facts.producer} ${facts.productType} from ${region}.`;
    const listing = canonicalListingSchema.parse({
      ...facts,
      ...required,
      title: { en: title, "zh-Hant": title },
      description: {
        en: description,
        "zh-Hant": `${facts.producer}，產自${region}。`,
      },
      seo: {
        title: { en: title, "zh-Hant": title },
        description: {
          en: description,
          "zh-Hant": `${facts.producer}，產自${region}。`,
        },
      },
      tags: [
        ...facts.grapeVarieties,
        ...(facts.region === null ? [] : [facts.region]),
      ],
      imageAssetIds: input.imageAssetIds,
    });
    return { listing, usage: usage(GENERATION_PROMPT.version) };
  }
}
