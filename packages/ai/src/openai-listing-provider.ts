import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
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
  ListingProviderError,
  ProviderApiError,
  ProviderOutputError,
  ProviderRefusalError,
  UnsupportedAssetError,
  providerFailureDiagnostic,
  type PhysicalInvocationObserver,
} from "./listing-provider-errors.js";
import {
  FACT_KEYS,
  assertFactsGrounded,
  assertGenerationGrounding,
  buildSafeListing,
  extractionOutputSchema,
  generationInputRuntimeSchema,
  generationOutputSchema,
} from "./listing-output-validation.js";

export {
  ListingProviderError,
  UnsupportedAssetError,
  ProviderApiError,
  ProviderRefusalError,
  ProviderOutputError,
} from "./listing-provider-errors.js";
import {
  EXTRACTION_INSTRUCTIONS,
  EXTRACTION_PROMPT,
  GENERATION_INSTRUCTIONS,
  GENERATION_PROMPT,
} from "./prompts.js";

type ProviderResponse = {
  _request_id?: string;
  output_parsed?: unknown;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
  } | null;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; refusal?: string }>;
  }>;
};

export type ResponsesClientPort = {
  responses: {
    parse(
      request: unknown,
      options?: { signal?: AbortSignal; maxRetries?: number },
    ): Promise<ProviderResponse>;
  };
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
  apiKey?: string;
  timeoutMs?: number;
  invocationObserver?: PhysicalInvocationObserver;
  maxOutputTokens?: number;
};

const DEFAULT_MODEL = "gpt-5.6-terra";
/** Worst-case wall time of a single listing provider call, before retries. */
export const LISTING_PROVIDER_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = LISTING_PROVIDER_REQUEST_TIMEOUT_MS;
const DEFAULT_PRICING: ModelPricing = {
  inputUsdPerMillion: 2.5,
  outputUsdPerMillion: 15,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SAFE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function assetPart(asset: ExtractionAsset): Record<string, string> {
  if (!isHttpsUrl(asset.readUrl))
    throw new UnsupportedAssetError("AI assets require an HTTPS read URL");
  if (IMAGE_MIME_TYPES.has(asset.mimeType)) {
    return { type: "input_image", image_url: asset.readUrl };
  }
  if (asset.mimeType === "application/pdf") {
    return { type: "input_file", file_url: asset.readUrl };
  }
  throw new UnsupportedAssetError("Unsupported AI asset MIME type");
}

function containsRefusal(response: ProviderResponse): boolean {
  return (
    response.output?.some((item) =>
      item.content?.some((content) => content.type === "refusal"),
    ) ?? false
  );
}

function safeTokenCount(value: number | null | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value ?? 0)
    : 0;
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
  const isLongContext =
    pricing.longContextThresholdTokens !== undefined &&
    inputTokens > pricing.longContextThresholdTokens;
  const inputMultiplier = isLongContext
    ? (pricing.longContextInputMultiplier ?? 1)
    : 1;
  const outputMultiplier = isLongContext
    ? (pricing.longContextOutputMultiplier ?? 1)
    : 1;
  const estimatedCostUsd =
    (inputTokens * pricing.inputUsdPerMillion * inputMultiplier +
      outputTokens * pricing.outputUsdPerMillion * outputMultiplier) /
    1_000_000;
  return {
    inputTokens,
    outputTokens,
    estimatedCostUsd:
      Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0
        ? estimatedCostUsd
        : 0,
    latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0,
    model,
    promptVersion,
  };
}

function validatePricing(pricing: ModelPricing): void {
  const required = [pricing.inputUsdPerMillion, pricing.outputUsdPerMillion];
  const optional = [
    pricing.longContextThresholdTokens,
    pricing.longContextInputMultiplier,
    pricing.longContextOutputMultiplier,
  ].filter((value): value is number => value !== undefined);
  if (
    [...required, ...optional].some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  ) {
    throw new TypeError("pricing must contain finite non-negative values");
  }
}

export class OpenAIListingProvider implements ListingAIProvider {
  private client: ResponsesClientPort | undefined;
  private readonly model: string;
  private readonly pricing: ModelPricing;
  private readonly now: () => number;
  private readonly clientFactory: () => ResponsesClientPort;
  private readonly timeoutMs: number;
  private readonly invocationObserver?: PhysicalInvocationObserver;
  private readonly maxOutputTokens: number;

  constructor(
    client?: ResponsesClientPort,
    config: OpenAIListingProviderConfig = {},
  ) {
    this.client = client;
    const configuredModel: unknown =
      config.model === undefined
        ? (process.env.OPENAI_LISTING_MODEL ?? DEFAULT_MODEL)
        : config.model;
    if (
      typeof configuredModel !== "string" ||
      !SAFE_MODEL_PATTERN.test(configuredModel)
    ) {
      throw new TypeError("model must be a safe non-empty identifier");
    }
    this.model = configuredModel;
    this.pricing = config.pricing ?? DEFAULT_PRICING;
    this.now = config.now ?? Date.now;
    this.clientFactory =
      config.clientFactory ??
      (() =>
        new OpenAI({
          ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
          maxRetries: 0,
        }) as unknown as ResponsesClientPort);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.invocationObserver = config.invocationObserver;
    this.maxOutputTokens = config.maxOutputTokens ?? 4096;
    if (
      !Number.isInteger(this.maxOutputTokens) ||
      this.maxOutputTokens < 1 ||
      this.maxOutputTokens > 100000
    )
      throw new TypeError(
        "maxOutputTokens must be an integer between 1 and 100000",
      );
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 600_000
    ) {
      throw new TypeError(
        "timeoutMs must be an integer between 1000 and 600000",
      );
    }
    validatePricing(this.pricing);
  }

  private getClient(): ResponsesClientPort {
    this.client ??= this.clientFactory();
    return this.client;
  }

  private physicalUsage(
    response: ProviderResponse,
  ): import("./listing-provider-errors.js").PhysicalInvocationUsage {
    const token = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
    const inputTokens = token(response.usage?.input_tokens),
      outputTokens = token(response.usage?.output_tokens);
    return {
      inputTokens,
      outputTokens,
      costUsd:
        inputTokens === null || outputTokens === null
          ? null
          : makeUsage(response, this.model, "physical", this.pricing, 0)
              .estimatedCostUsd,
      certainty:
        inputTokens === null || outputTokens === null ? "unknown" : "estimated",
    };
  }
  private async observeResponse(
    response: ProviderResponse,
    ordinal: number,
    phase: "request" | "repair",
  ): Promise<void> {
    const refusal = containsRefusal(response);
    const outcome = refusal
      ? "refusal"
      : response.output_parsed == null
        ? "invalid_output"
        : "response";
    await this.invocationObserver?.({
      ordinal,
      phase,
      outcome,
      diagnostic: {
        category: refusal
          ? "refusal"
          : response.output_parsed == null
            ? "invalid_output"
            : "internal",
        retryable: false,
        httpStatus: 200,
        providerCode: null,
        requestId: providerFailureDiagnostic({
          request_id: response._request_id,
        }).requestId,
      },
      usage: this.physicalUsage(response),
    });
  }
  private async observeInvalidOutput(
    response: ProviderResponse,
    ordinal: number,
    phase: "request" | "repair",
  ): Promise<void> {
    await this.invocationObserver?.({
      ordinal,
      phase,
      outcome: "invalid_output",
      diagnostic: {
        category: "invalid_output",
        retryable: false,
        httpStatus: 200,
        providerCode: null,
        requestId: null,
      },
      usage: this.physicalUsage(response),
    });
  }
  private async parseWithOneRepair(
    request: Record<string, unknown>,
    validate: (output: unknown) => void,
  ): Promise<ProviderResponse> {
    let response: ProviderResponse;
    let ordinal = 1;
    await this.invocationObserver?.({
      ordinal: 1,
      phase: "request",
      outcome: "started",
      diagnostic: {
        category: "internal",
        retryable: false,
        httpStatus: null,
        providerCode: null,
        requestId: null,
      },
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        certainty: "unknown",
      },
    });
    try {
      response = await this.getClient().responses.parse(request, {
        signal: AbortSignal.timeout(this.timeoutMs),
        maxRetries: 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const diagnostic = providerFailureDiagnostic(error);
      await this.invocationObserver?.({
        ordinal,
        phase: ordinal === 1 ? "request" : "repair",
        outcome: "api_error",
        diagnostic,
        usage: {
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          certainty: "unknown",
        },
      });
      throw new ProviderApiError(
        /timeout|timed out|abort|etimedout/i.test(message)
          ? "AI provider request timed out"
          : "AI provider request failed",
        diagnostic,
      );
    }
    if (containsRefusal(response)) {
      await this.observeResponse(response, 1, "request");
      throw new ProviderRefusalError("AI provider refused the request");
    }
    if (response.output_parsed != null) {
      try {
        validate(response.output_parsed);
      } catch (error) {
        await this.observeInvalidOutput(response, 1, "request");
        throw error;
      }
      await this.observeResponse(response, 1, "request");
      return response;
    }
    await this.observeResponse(response, 1, "request");
    const repairRequest = {
      ...request,
      input: [
        ...((request.input as unknown[]) ?? []),
        {
          role: "system",
          content:
            "Bounded repair: return only a complete response matching the required schema.",
        },
      ],
    };
    ordinal = 2;
    await this.invocationObserver?.({
      ordinal: 2,
      phase: "repair",
      outcome: "started",
      diagnostic: {
        category: "internal",
        retryable: false,
        httpStatus: null,
        providerCode: null,
        requestId: null,
      },
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        certainty: "unknown",
      },
    });
    try {
      response = await this.getClient().responses.parse(repairRequest, {
        signal: AbortSignal.timeout(this.timeoutMs),
        maxRetries: 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const diagnostic = providerFailureDiagnostic(error);
      await this.invocationObserver?.({
        ordinal,
        phase: ordinal === 1 ? "request" : "repair",
        outcome: "api_error",
        diagnostic,
        usage: {
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          certainty: "unknown",
        },
      });
      throw new ProviderApiError(
        /timeout|timed out|abort|etimedout/i.test(message)
          ? "AI provider request timed out"
          : "AI provider request failed",
        diagnostic,
      );
    }
    if (containsRefusal(response)) {
      await this.observeResponse(response, 2, "repair");
      throw new ProviderRefusalError("AI provider refused the request");
    }
    if (response.output_parsed == null) {
      await this.observeResponse(response, 2, "repair");
      throw new ProviderOutputError("AI provider returned no parsed output");
    }
    try {
      validate(response.output_parsed);
    } catch (error) {
      await this.observeInvalidOutput(response, 2, "repair");
      throw error;
    }
    await this.observeResponse(response, 2, "repair");
    return response;
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const parts = input.assets.map(assetPart);
    const start = this.now();
    const request = {
      model: this.model,
      max_output_tokens: this.maxOutputTokens,
      ...(/^(?:gpt-5|o[1-9])/.test(this.model)
        ? { reasoning: { effort: "low" } }
        : {}),
      input: [
        {
          role: "system",
          content: `${EXTRACTION_PROMPT.name}@${EXTRACTION_PROMPT.version}\n${EXTRACTION_INSTRUCTIONS}`,
        },
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
      text: {
        format: zodTextFormat(extractionOutputSchema, "listing_extraction"),
      },
    };
    const response = await this.parseWithOneRepair(request, (output) => {
      const parsed = extractionOutputSchema.parse(output);
      const allowedSources = new Set(input.assets.map((asset) => asset.id));
      allowedSources.add(NOTE_SOURCE_ID);
      assertFactsGrounded(parsed.facts, parsed.evidence, {
        allowedSources,
        note: input.note,
      });
    });
    let parsed: z.infer<typeof extractionOutputSchema>;
    try {
      parsed = extractionOutputSchema.parse(response.output_parsed);
      const allowedSources = new Set(input.assets.map((asset) => asset.id));
      allowedSources.add(NOTE_SOURCE_ID);
      assertFactsGrounded(parsed.facts, parsed.evidence, {
        allowedSources,
        note: input.note,
      });
    } catch (error) {
      if (error instanceof ProviderOutputError) throw error;
      throw new ProviderOutputError(
        "AI extraction did not match the required schema",
      );
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
      assertFactsGrounded(validatedInput.facts, validatedInput.evidence, {
        operatorProvidedFields: validatedInput.operatorProvidedFields,
      });
    } catch (error) {
      if (error instanceof ProviderOutputError) throw error;
      throw new ProviderOutputError(
        "AI generation input did not match the required schema",
      );
    }

    const safeListing = buildSafeListing(validatedInput);
    const start = this.now();
    const request = {
      model: this.model,
      max_output_tokens: this.maxOutputTokens,
      ...(/^(?:gpt-5|o[1-9])/.test(this.model)
        ? { reasoning: { effort: "low" } }
        : {}),
      input: [
        {
          role: "system",
          content: `${GENERATION_PROMPT.name}@${GENERATION_PROMPT.version}\n${GENERATION_INSTRUCTIONS}`,
        },
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
      text: {
        format: zodTextFormat(generationOutputSchema, "listing_generation"),
      },
    };
    const response = await this.parseWithOneRepair(request, (output) => {
      const parsed = generationOutputSchema.parse(output);
      assertGenerationGrounding(parsed.listing, validatedInput);
    });
    let modelListing: z.infer<typeof generationOutputSchema>["listing"];
    try {
      modelListing = generationOutputSchema.parse(
        response.output_parsed,
      ).listing;
      assertGenerationGrounding(modelListing, validatedInput);
    } catch (error) {
      if (error instanceof ProviderOutputError) throw error;
      throw new ProviderOutputError(
        "AI generation did not match the required schema",
      );
    }
    return {
      listing: modelListing,
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
