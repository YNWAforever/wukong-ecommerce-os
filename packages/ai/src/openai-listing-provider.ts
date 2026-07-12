import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  canonicalListingSchema,
  fieldEvidenceSchema,
  listingFactsSchema,
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
const FACT_KEYS = Object.keys(listingFactsSchema.shape) as Array<keyof z.infer<typeof listingFactsSchema>>;

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
    estimatedCostUsd: Number.isFinite(estimatedCostUsd) ? estimatedCostUsd : 0,
    latencyMs: Math.max(0, Math.round(latencyMs)),
    model,
    promptVersion,
  };
}

function assertEvidenceGrounding(parsed: z.infer<typeof extractionOutputSchema>, input: ExtractionInput): void {
  const allowedSources = new Set(input.assets.map((asset) => asset.id));
  allowedSources.add(NOTE_SOURCE_ID);
  for (const item of parsed.evidence) {
    if (!allowedSources.has(item.sourceAssetId)) {
      throw new ProviderOutputError("AI evidence referenced an unknown source");
    }
    if (item.sourceAssetId === NOTE_SOURCE_ID && !(input.note ?? "").includes(item.excerpt)) {
      throw new ProviderOutputError("AI evidence was not present in the supplied note");
    }
    if (!(item.field in parsed.facts)) throw new ProviderOutputError("AI evidence referenced an unknown field");
    const value = parsed.facts[item.field as keyof typeof parsed.facts];
    if (value === null || (Array.isArray(value) && value.length === 0)) {
      throw new ProviderOutputError("AI evidence referenced an absent fact");
    }
  }
  for (const score of parsed.facts.criticScores) {
    if (!allowedSources.has(score.evidenceId)) throw new ProviderOutputError("AI score referenced an unknown source");
  }
  for (const award of parsed.facts.awards) {
    if (!allowedSources.has(award.evidenceId)) throw new ProviderOutputError("AI award referenced an unknown source");
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

export class OpenAIListingProvider implements ListingAIProvider {
  private client: ResponsesClientPort | undefined;
  private readonly model: string;
  private readonly pricing: ModelPricing;
  private readonly now: () => number;
  private readonly clientFactory: () => ResponsesClientPort;

  constructor(client?: ResponsesClientPort, config: OpenAIListingProviderConfig = {}) {
    this.client = client;
    this.model = config.model ?? DEFAULT_MODEL;
    this.pricing = config.pricing ?? DEFAULT_PRICING;
    this.now = config.now ?? Date.now;
    this.clientFactory = config.clientFactory ?? (() => new OpenAI() as unknown as ResponsesClientPort);
    if (!this.model.trim()) throw new TypeError("model must not be empty");
    if (!Number.isFinite(this.pricing.inputUsdPerMillion) || this.pricing.inputUsdPerMillion < 0 ||
      !Number.isFinite(this.pricing.outputUsdPerMillion) || this.pricing.outputUsdPerMillion < 0) {
      throw new TypeError("pricing must contain finite non-negative rates");
    }
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
      assertEvidenceGrounding(parsed, input);
    } catch (error) {
      if (error instanceof ProviderOutputError) throw error;
      throw new ProviderOutputError("AI extraction did not match the required schema");
    }
    return {
      ...parsed,
      missingFields: FACT_KEYS.filter((key) => parsed.facts[key] === null),
      usage: makeUsage(response, this.model, EXTRACTION_PROMPT.version, this.pricing, this.now() - start),
    };
  }

  async generate(input: GenerationInput): Promise<GenerationResult> {
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
            facts: input.facts,
            evidence: input.evidence,
            profile: input.profile,
            imageAssetIds: input.imageAssetIds,
          }),
        },
      ],
      text: { format: zodTextFormat(generationOutputSchema, "listing_generation") },
    };
    const response = await this.parseWithOneRepair(request);
    let listing: z.infer<typeof canonicalListingSchema>;
    try {
      listing = generationOutputSchema.parse(response.output_parsed).listing;
      assertGenerationGrounding(listing, input);
    } catch (error) {
      if (error instanceof ProviderOutputError) throw error;
      throw new ProviderOutputError("AI generation did not match the required schema");
    }
    return {
      listing,
      usage: makeUsage(response, this.model, GENERATION_PROMPT.version, this.pricing, this.now() - start),
    };
  }
}
