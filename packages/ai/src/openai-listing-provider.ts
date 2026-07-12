import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  canonicalListingSchema,
  fieldEvidenceSchema,
  listingFactsSchema,
  workspaceProfileSchema,
  type FieldEvidence,
  type ListingFacts,
} from "@wukong/core";
import { z } from "zod";

import {
  NOTE_SOURCE_ID,
  type AIUsage,
  type ExtractionAsset,
  type ExtractionInput,
  type ExtractionResult,
  type GenerationInput,
  type GenerationResult,
  type ListingAIProvider,
} from "./contracts.js";
import {
  EXTRACTION_INSTRUCTIONS,
  EXTRACTION_PROMPT,
  GENERATION_INSTRUCTIONS,
  GENERATION_PROMPT,
} from "./prompts.js";

const extractionOutputSchema = z.object({
  facts: listingFactsSchema,
  evidence: z.array(fieldEvidenceSchema),
  missingFields: z.array(z.string()),
});

const generationOutputSchema = z.object({ listing: canonicalListingSchema });

const generationInputRuntimeSchema = z.object({
  facts: listingFactsSchema,
  evidence: z.array(fieldEvidenceSchema),
  profile: workspaceProfileSchema,
  imageAssetIds: z.array(z.string().min(1)),
});

type ProviderResponse = {
  output_parsed?: unknown;
  usage?: { input_tokens?: number | null; output_tokens?: number | null } | null;
  output?: Array<{ type?: string; content?: Array<{ type?: string; refusal?: string }> }>;
};

export type ResponsesClientPort = {
  responses: { parse(request: unknown): Promise<ProviderResponse> };
};

export type ModelPricing = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  longContextThresholdTokens?: number;
  longContextInputMultiplier?: number;
  longContextOutputMultiplier?: number;
};

export type OpenAIListingProviderConfig = {
  model?: string;
  pricing?: ModelPricing;
  now?: () => number;
  clientFactory?: () => ResponsesClientPort;
};

const DEFAULT_MODEL = "gpt-5.6-terra";
const DEFAULT_PRICING: ModelPricing = {
  inputUsdPerMillion: 2.5,
  outputUsdPerMillion: 15,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const FACT_KEYS = Object.keys(listingFactsSchema.shape) as Array<keyof ListingFacts>;
const MAX_EVIDENCE_EXCERPT_LENGTH = 500;
const SAFE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ListingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnsupportedAssetError extends ListingProviderError {}
export class ProviderApiError extends ListingProviderError {}
export class ProviderRefusalError extends ListingProviderError {}
export class ProviderOutputError extends ListingProviderError {}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function assetPart(asset: ExtractionAsset): Record<string, string> {
  if (!isHttpsUrl(asset.readUrl)) throw new UnsupportedAssetError("AI assets require an HTTPS read URL");
  if (IMAGE_MIME_TYPES.has(asset.mimeType)) {
    return { type: "input_image", image_url: asset.readUrl };
  }
  if (asset.mimeType === "application/pdf") {
    return { type: "input_file", file_url: asset.readUrl };
  }
  throw new UnsupportedAssetError("Unsupported AI asset MIME type");
}

function containsRefusal(response: ProviderResponse): boolean {
  return response.output?.some((item) =>
    item.content?.some((content) => content.type === "refusal"),
  ) ?? false;
}

function safeTokenCount(value: number | null | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value ?? 0) : 0;
}

function safeLatency(start: number, end: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.max(0, Math.round(end - start));
}

function makeUsage(
  response: ProviderResponse,
  model: string,
  promptVersion: string,
  pricing: ModelPricing,
  latencyMs: number,
): AIUsage {
  const inputTokens = safeTokenCount(response.usage?.input_tokens);
  const outputTokens = safeTokenCount(response.usage?.output_tokens);
  const isLongContext = pricing.longContextThresholdTokens !== undefined &&
    inputTokens > pricing.longContextThresholdTokens;
  const inputMultiplier = isLongContext ? (pricing.longContextInputMultiplier ?? 1) : 1;
  const outputMultiplier = isLongContext ? (pricing.longContextOutputMultiplier ?? 1) : 1;
  const estimatedCostUsd =
    (inputTokens * pricing.inputUsdPerMillion * inputMultiplier +
      outputTokens * pricing.outputUsdPerMillion * outputMultiplier) / 1_000_000;
  return {
    inputTokens,
    outputTokens,
    estimatedCostUsd: Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0 ? estimatedCostUsd : 0,
    latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0,
    model,
    promptVersion,
  };
}

function normalizedTokens(value: string): string[] {
  return value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function excerptContainsExactTerm(excerpt: string, expected: string): boolean {
  const expectedTokens = normalizedTokens(expected);
  if (expectedTokens.length === 0) return false;
  const excerptTokens = normalizedTokens(excerpt);
  return excerptTokens.some((_, start) =>
    expectedTokens.every((token, offset) => excerptTokens[start + offset] === token),
  );
}

function excerptContainsNumber(excerpt: string, expected: number): boolean {
  const values = excerpt.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return values.some((value) => Number.isFinite(value) && value === expected);
}

function excerptSupportsValue(excerpt: string, value: unknown): boolean {
  if (typeof value === "string") return excerptContainsExactTerm(excerpt, value);
  if (typeof value === "number") return excerptContainsNumber(excerpt, value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.every((item) => excerptContainsExactTerm(excerpt, item));
  }
  return false;
}

function evidenceSupportsValue(evidence: FieldEvidence[], value: unknown): boolean {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.every((item) => evidence.some((entry) => excerptSupportsValue(entry.excerpt, item)));
  }
  return evidence.some((entry) => excerptSupportsValue(entry.excerpt, value));
}

function isMeaningfulFact(value: unknown): boolean {
  return value !== null && value !== undefined && (!Array.isArray(value) || value.length > 0);
}

function assertComplexFactEvidence(
  key: "criticScores" | "awards",
  value: ListingFacts[typeof key],
  evidenceForField: FieldEvidence[],
  allowedSources?: Set<string>,
): void {
  for (const item of value) {
    const evidenceId = item.evidenceId;
    if (allowedSources && !allowedSources.has(evidenceId)) {
      throw new ProviderOutputError("AI claim referenced an unknown source");
    }
    const supporting = evidenceForField.filter((entry) => entry.sourceAssetId === evidenceId);
    const terms = key === "criticScores"
      ? (() => {
          const score = item as ListingFacts["criticScores"][number];
          return [score.source, score.score];
        })()
      : [(item as ListingFacts["awards"][number]).name];
    if (!supporting.some((entry) => terms.every((term) => excerptSupportsValue(entry.excerpt, term)))) {
      throw new ProviderOutputError("AI claim evidence did not support its value");
    }
  }
}

function assertFactsGrounded(
  facts: ListingFacts,
  evidence: FieldEvidence[],
  options: { allowedSources?: Set<string>; note?: string | null } = {},
): void {
  for (const item of evidence) {
    if (item.excerpt.length > MAX_EVIDENCE_EXCERPT_LENGTH) {
      throw new ProviderOutputError("AI evidence excerpt exceeded the allowed bound");
    }
    if (options.allowedSources && !options.allowedSources.has(item.sourceAssetId)) {
      throw new ProviderOutputError("AI evidence referenced an unknown source");
    }
    if (item.sourceAssetId === NOTE_SOURCE_ID && options.note !== undefined &&
      !(options.note ?? "").includes(item.excerpt)) {
      throw new ProviderOutputError("AI evidence was not present in the supplied note");
    }
    if (!FACT_KEYS.includes(item.field as keyof ListingFacts)) {
      throw new ProviderOutputError("AI evidence referenced an unknown field");
    }
    const value = facts[item.field as keyof ListingFacts];
    if (!isMeaningfulFact(value)) {
      throw new ProviderOutputError("AI evidence referenced an absent fact");
    }
  }

  for (const key of FACT_KEYS) {
    const value = facts[key];
    if (!isMeaningfulFact(value)) continue;
    const evidenceForField = evidence.filter((item) => item.field === key);
    if (evidenceForField.length === 0) {
      throw new ProviderOutputError("AI fact had no supporting evidence");
    }
    if (key === "criticScores" || key === "awards") {
      assertComplexFactEvidence(key, value as ListingFacts[typeof key], evidenceForField, options.allowedSources);
      continue;
    }
    if (!evidenceSupportsValue(evidenceForField, value)) {
      throw new ProviderOutputError("AI evidence did not support its fact value");
    }
  }
}

function assertGenerationGrounding(
  listing: z.infer<typeof canonicalListingSchema>,
  input: GenerationInput,
): void {
  for (const key of FACT_KEYS) {
    if (JSON.stringify(listing[key]) !== JSON.stringify(input.facts[key])) {
      throw new ProviderOutputError("AI generation changed a protected fact");
    }
  }
  if (JSON.stringify(listing.imageAssetIds) !== JSON.stringify(input.imageAssetIds)) {
    throw new ProviderOutputError("AI generation changed supplied image assets");
  }
}

function buildSafeListing(input: GenerationInput): z.infer<typeof canonicalListingSchema> {
  const facts = input.facts;
  const required = {
    sku: facts.sku,
    producer: facts.producer,
    productType: facts.productType,
    country: facts.country,
    volumeMl: facts.volumeMl,
    abvPercent: facts.abvPercent,
    priceHkd: facts.priceHkd,
  };
  for (const [key, value] of Object.entries(required)) {
    if (value === null) throw new ProviderOutputError(`Safe generation requires ${key}`);
  }

  const title = `${facts.producer}${facts.vintage === null ? "" : ` ${facts.vintage}`}`;
  const origin = facts.region === null ? facts.country : `${facts.region}, ${facts.country}`;
  const grapes = facts.grapeVarieties.length === 0 ? "" : ` Grape: ${facts.grapeVarieties.join(", ")}.`;
  const vintage = facts.vintage === null ? "" : ` Vintage: ${facts.vintage}.`;
  const descriptionEn = `${facts.producer}. Product type: ${facts.productType}. Origin: ${origin}.${vintage}${grapes} Volume: ${facts.volumeMl} ml. ABV: ${facts.abvPercent}%.`;
  const typeZh = { wine: "葡萄酒", spirits: "烈酒", sake: "清酒", other: "其他" }[facts.productType ?? "other"];
  const grapesZh = facts.grapeVarieties.length === 0 ? "" : `葡萄品種：${facts.grapeVarieties.join("、")}。`;
  const vintageZh = facts.vintage === null ? "" : `年份：${facts.vintage}。`;
  const descriptionZh = `${facts.producer}。產品類型：${typeZh}。產地：${origin}。${vintageZh}${grapesZh}容量：${facts.volumeMl}毫升。酒精濃度：${facts.abvPercent}%。`;
  const tags = [
    facts.productType,
    facts.country,
    facts.region,
    facts.vintage === null ? null : String(facts.vintage),
    ...facts.grapeVarieties,
  ].filter((value): value is string => value !== null);

  return canonicalListingSchema.parse({
    ...facts,
    ...required,
    title: { en: title, "zh-Hant": title },
    description: { en: descriptionEn, "zh-Hant": descriptionZh },
    seo: {
      title: { en: title, "zh-Hant": title },
      description: { en: descriptionEn, "zh-Hant": descriptionZh },
    },
    tags,
    imageAssetIds: input.imageAssetIds,
  });
}

function validatePricing(pricing: ModelPricing): void {
  const required = [pricing.inputUsdPerMillion, pricing.outputUsdPerMillion];
  const optional = [
    pricing.longContextThresholdTokens,
    pricing.longContextInputMultiplier,
    pricing.longContextOutputMultiplier,
  ].filter((value): value is number => value !== undefined);
  if ([...required, ...optional].some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError("pricing must contain finite non-negative values");
  }
}

export class OpenAIListingProvider implements ListingAIProvider {
  private client: ResponsesClientPort | undefined;
  private readonly model: string;
  private readonly pricing: ModelPricing;
  private readonly now: () => number;
  private readonly clientFactory: () => ResponsesClientPort;

  constructor(client?: ResponsesClientPort, config: OpenAIListingProviderConfig = {}) {
    this.client = client;
    const configuredModel: unknown = config.model === undefined
      ? (process.env.OPENAI_LISTING_MODEL ?? DEFAULT_MODEL)
      : config.model;
    if (typeof configuredModel !== "string" || !SAFE_MODEL_PATTERN.test(configuredModel)) {
      throw new TypeError("model must be a safe non-empty identifier");
    }
    this.model = configuredModel;
    this.pricing = config.pricing ?? DEFAULT_PRICING;
    this.now = config.now ?? Date.now;
    this.clientFactory = config.clientFactory ?? (() => new OpenAI() as unknown as ResponsesClientPort);
    validatePricing(this.pricing);
  }

  private getClient(): ResponsesClientPort {
    this.client ??= this.clientFactory();
    return this.client;
  }

  private async parseWithOneRepair(request: Record<string, unknown>): Promise<ProviderResponse> {
    let response: ProviderResponse;
    try {
      response = await this.getClient().responses.parse(request);
    } catch {
      throw new ProviderApiError("AI provider request failed");
    }
    if (containsRefusal(response)) throw new ProviderRefusalError("AI provider refused the request");
    if (response.output_parsed != null) return response;
    const repairRequest = {
      ...request,
      input: [
        ...((request.input as unknown[]) ?? []),
        { role: "system", content: "Bounded repair: return only a complete response matching the required schema." },
      ],
    };
    try {
      response = await this.getClient().responses.parse(repairRequest);
    } catch {
      throw new ProviderApiError("AI provider request failed");
    }
    if (containsRefusal(response)) throw new ProviderRefusalError("AI provider refused the request");
    if (response.output_parsed == null) throw new ProviderOutputError("AI provider returned no parsed output");
    return response;
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const parts = input.assets.map(assetPart);
    const start = this.now();
    const request = {
      model: this.model,
      reasoning: { effort: "low" },
      input: [
        { role: "system", content: `${EXTRACTION_PROMPT.name}@${EXTRACTION_PROMPT.version}\n${EXTRACTION_INSTRUCTIONS}` },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                prompt: `${EXTRACTION_PROMPT.name}@${EXTRACTION_PROMPT.version}`,
                allowedAssetIds: input.assets.map((asset) => asset.id),
                note: input.note,
              }),
            },
            ...parts,
          ],
        },
      ],
      text: { format: zodTextFormat(extractionOutputSchema, "listing_extraction") },
    };
    const response = await this.parseWithOneRepair(request);
    let parsed: z.infer<typeof extractionOutputSchema>;
    try {
      parsed = extractionOutputSchema.parse(response.output_parsed);
      const allowedSources = new Set(input.assets.map((asset) => asset.id));
      allowedSources.add(NOTE_SOURCE_ID);
      assertFactsGrounded(parsed.facts, parsed.evidence, { allowedSources, note: input.note });
    } catch (error) {
      if (error instanceof ProviderOutputError) throw error;
      throw new ProviderOutputError("AI extraction did not match the required schema");
    }
    return {
      ...parsed,
      missingFields: FACT_KEYS.filter((key) => parsed.facts[key] === null),
      usage: makeUsage(
        response,
        this.model,
        EXTRACTION_PROMPT.version,
        this.pricing,
        safeLatency(start, this.now()),
      ),
    };
  }

  async generate(input: GenerationInput): Promise<GenerationResult> {
    let validatedInput: GenerationInput;
    try {
      validatedInput = generationInputRuntimeSchema.parse(input);
      assertFactsGrounded(validatedInput.facts, validatedInput.evidence);
    } catch (error) {
      if (error instanceof ProviderOutputError) throw error;
      throw new ProviderOutputError("AI generation input did not match the required schema");
    }

    const safeListing = buildSafeListing(validatedInput);
    const start = this.now();
    const request = {
      model: this.model,
      reasoning: { effort: "low" },
      input: [
        { role: "system", content: `${GENERATION_PROMPT.name}@${GENERATION_PROMPT.version}\n${GENERATION_INSTRUCTIONS}` },
        {
          role: "user",
          content: JSON.stringify({
            prompt: `${GENERATION_PROMPT.name}@${GENERATION_PROMPT.version}`,
            facts: validatedInput.facts,
            evidence: validatedInput.evidence,
            profile: validatedInput.profile,
            imageAssetIds: validatedInput.imageAssetIds,
            requiredSafeProjection: safeListing,
          }),
        },
      ],
      text: { format: zodTextFormat(generationOutputSchema, "listing_generation") },
    };
    const response = await this.parseWithOneRepair(request);
    try {
      const modelListing = generationOutputSchema.parse(response.output_parsed).listing;
      assertGenerationGrounding(modelListing, validatedInput);
    } catch (error) {
      if (error instanceof ProviderOutputError) throw error;
      throw new ProviderOutputError("AI generation did not match the required schema");
    }
    return {
      listing: safeListing,
      usage: makeUsage(
        response,
        this.model,
        GENERATION_PROMPT.version,
        this.pricing,
        safeLatency(start, this.now()),
      ),
    };
  }
}