import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import {
  NOTE_SOURCE_ID,
  type AIUsage,
  type ExtractionInput,
  type ExtractionResult,
  type GenerationInput,
  type GenerationResult,
  type ListingAIProvider,
} from "./contracts.js";
import {
  ProviderApiError,
  ProviderOutputError,
  ProviderRefusalError,
  UnsupportedAssetError,
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
import {
  EXTRACTION_INSTRUCTIONS,
  EXTRACTION_PROMPT,
  GENERATION_INSTRUCTIONS,
  GENERATION_PROMPT,
} from "./prompts.js";

export type OpenRouterListingProviderConfig = {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

// Require explicit model slugs and reject known routing aliases and variants.
function validModel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !/(?:^|[\/._-])(auto|free|latest|online|search)(?:$|[._-])/i.test(value) &&
    !value.toLowerCase().startsWith("openrouter/")
  );
}
const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  completion_tokens: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  cost: z.number().finite().nonnegative(),
});
const envelopeSchema = z.object({
  usage: usageSchema,
  model: z.unknown().optional(),
  choices: z
    .array(z.object({ finish_reason: z.string(), message: z.unknown() }))
    .length(1),
});
const messageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string(),
  refusal: z.string().nullable().optional(),
});
const ERROR_CODES = new Set([
  "invalid_api_key",
  "insufficient_quota",
  "rate_limit_exceeded",
  "model_not_found",
  "invalid_json_schema",
  "invalid_request_error",
  "unsupported_parameter",
  "invalid_value",
  "server_error",
  "invalid_image",
  "invalid_image_url",
  "image_parse_error",
]);
function reportProviderFailure(
  error: unknown,
  phase: "request" | "repair",
): void {
  const detail = error && typeof error === "object" ? error : {};
  const rawStatus = "status" in detail ? detail.status : null;
  const status =
    typeof rawStatus === "number" &&
    Number.isInteger(rawStatus) &&
    rawStatus >= 400 &&
    rawStatus <= 599
      ? rawStatus
      : null;
  const rawCode = "code" in detail ? detail.code : null;
  const code =
    typeof rawCode === "string" && ERROR_CODES.has(rawCode)
      ? rawCode
      : "unknown";
  console.error(
    JSON.stringify({
      event: "listing_provider_failure",
      provider: "openrouter",
      phase,
      status,
      code,
    }),
  );
}

export class OpenRouterListingProvider implements ListingAIProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(config: OpenRouterListingProviderConfig) {
    if (typeof config.apiKey !== "string" || !config.apiKey.trim())
      throw new TypeError("apiKey must be non-empty");
    if (!validModel(config.model))
      throw new TypeError("model must be an explicit safe author/model slug");
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1000 ||
      this.timeoutMs > 600_000
    )
      throw new TypeError(
        "timeoutMs must be an integer between 1000 and 600000",
      );
    this.now = config.now ?? Date.now;
    this.client = new OpenAI({
      apiKey: config.apiKey.trim(),
      baseURL: "https://openrouter.ai/api/v1",
      maxRetries: 0,
      timeout: this.timeoutMs,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  private async complete<T>(
    messages: ChatCompletionMessageParam[],
    schema: z.ZodType<T>,
    schemaName: string,
    promptVersion: string,
  ): Promise<{ parsed: T; usage: AIUsage }> {
    const start = this.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let estimatedCostUsd = 0;
    let responseModel: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const request = {
        model: this.model,
        stream: false as const,
        messages:
          attempt === 0
            ? messages
            : [
                ...messages,
                {
                  role: "system" as const,
                  content:
                    "Bounded repair: return only a complete response matching the required schema.",
                },
              ],
        response_format: zodResponseFormat(schema, schemaName),
        provider: { require_parameters: true },
      };
      let raw: unknown;
      const signal = AbortSignal.timeout(this.timeoutMs);
      try {
        raw = await this.client.chat.completions.create(request, { signal });
      } catch (error) {
        reportProviderFailure(error, attempt === 0 ? "request" : "repair");
        throw new ProviderApiError(
          signal.aborted || error instanceof OpenAI.APIConnectionTimeoutError
            ? "AI provider request timed out"
            : "AI provider request failed",
        );
      }
      // Accounting and completion integrity are terminal; never spend a repair on them.
      const envelope = envelopeSchema.safeParse(raw);
      if (!envelope.success)
        throw new ProviderOutputError(
          "AI provider returned an invalid response envelope or usage",
        );
      const response = envelope.data;
      const model = response.model === undefined ? this.model : response.model;
      if (
        !validModel(model) ||
        (responseModel !== undefined && responseModel !== model)
      )
        throw new ProviderOutputError(
          "AI provider returned an invalid or inconsistent model identity",
        );
      responseModel = model;
      inputTokens += response.usage.prompt_tokens;
      outputTokens += response.usage.completion_tokens;
      estimatedCostUsd += response.usage.cost;
      if (
        !Number.isSafeInteger(inputTokens) ||
        !Number.isSafeInteger(outputTokens) ||
        !Number.isFinite(estimatedCostUsd)
      )
        throw new ProviderOutputError(
          "AI provider usage exceeded safe accounting bounds",
        );
      const choice = response.choices[0]!;
      const message = choice.message;
      if (
        choice.finish_reason === "content_filter" ||
        (message !== null &&
          typeof message === "object" &&
          "refusal" in message &&
          typeof message.refusal === "string" &&
          message.refusal.length > 0)
      )
        throw new ProviderRefusalError("AI provider refused the request");
      if (choice.finish_reason !== "stop")
        throw new ProviderOutputError(
          "AI provider returned an incomplete response",
        );
      const content = messageSchema.safeParse(message);
      if (!content.success)
        throw new ProviderOutputError(
          "AI provider returned an invalid message envelope",
        );
      let json: unknown;
      try {
        json = JSON.parse(content.data.content);
      } catch {
        json = undefined;
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) continue;
      const end = this.now();
      const latencyMs =
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        end >= start &&
        Number.isFinite(end - start)
          ? Math.round(end - start)
          : 0;
      return {
        parsed: parsed.data,
        usage: {
          inputTokens,
          outputTokens,
          estimatedCostUsd,
          model: responseModel,
          promptVersion,
          latencyMs,
        },
      };
    }
    throw new ProviderOutputError(
      "AI provider output did not match the required schema after bounded repair",
    );
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    for (const asset of input.assets) {
      let url: URL;
      try {
        url = new URL(asset.readUrl);
      } catch {
        throw new UnsupportedAssetError(
          "AI assets require an HTTPS read URL without credentials",
        );
      }
      if (url.protocol !== "https:" || url.username || url.password)
        throw new UnsupportedAssetError(
          "AI assets require an HTTPS read URL without credentials",
        );
      if (!["image/jpeg", "image/png", "image/webp"].includes(asset.mimeType))
        throw new UnsupportedAssetError("Unsupported AI asset MIME type");
    }
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `${EXTRACTION_PROMPT.name}@${EXTRACTION_PROMPT.version}\n${EXTRACTION_INSTRUCTIONS}`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              prompt: `${EXTRACTION_PROMPT.name}@${EXTRACTION_PROMPT.version}`,
              allowedAssetIds: input.assets.map((asset) => asset.id),
              note: input.note,
            }),
          },
          ...input.assets.map((asset) => ({
            type: "image_url" as const,
            image_url: { url: asset.readUrl },
          })),
        ],
      },
    ];
    const { parsed, usage } = await this.complete(
      messages,
      extractionOutputSchema,
      "listing_extraction",
      EXTRACTION_PROMPT.version,
    );
    const allowedSources = new Set(input.assets.map((asset) => asset.id));
    allowedSources.add(NOTE_SOURCE_ID);
    assertFactsGrounded(parsed.facts, parsed.evidence, {
      allowedSources,
      note: input.note,
    });
    return {
      ...parsed,
      missingFields: FACT_KEYS.filter((key) => parsed.facts[key] === null),
      usage,
    };
  }

  async generate(input: GenerationInput): Promise<GenerationResult> {
    const validated = generationInputRuntimeSchema.safeParse(input);
    if (!validated.success)
      throw new ProviderOutputError(
        "AI generation input did not match the required schema",
      );
    const validatedInput = validated.data;
    assertFactsGrounded(validatedInput.facts, validatedInput.evidence);
    const safeListing = buildSafeListing(validatedInput);
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `${GENERATION_PROMPT.name}@${GENERATION_PROMPT.version}\n${GENERATION_INSTRUCTIONS}`,
      },
      {
        role: "user",
        content: JSON.stringify({
          prompt: `${GENERATION_PROMPT.name}@${GENERATION_PROMPT.version}`,
          ...validatedInput,
          requiredSafeProjection: safeListing,
        }),
      },
    ];
    const { parsed, usage } = await this.complete(
      messages,
      generationOutputSchema,
      "listing_generation",
      GENERATION_PROMPT.version,
    );
    assertGenerationGrounding(parsed.listing, validatedInput);
    return { listing: parsed.listing, usage };
  }
}
