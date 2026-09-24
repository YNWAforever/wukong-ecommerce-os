import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  NOTE_SOURCE_ID,
  type ExtractionInput,
  type ExtractionResult,
  type GenerationInput,
  type GenerationResult,
  type ListingAIProvider,
} from "./contracts.js";
import {
  ProviderOutputError,
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
import {
  TypedJsonCompletionClient,
  type TypedJsonCompletionConfig,
} from "./typed-json-completion.js";

export type ChatListingProviderConfig = TypedJsonCompletionConfig;

export class ChatListingProvider implements ListingAIProvider {
  private readonly completion: TypedJsonCompletionClient;

  constructor(config: ChatListingProviderConfig) {
    this.completion = new TypedJsonCompletionClient(config);
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
    const { parsed, usage } = await this.completion.complete(
      messages,
      extractionOutputSchema,
      "listing_extraction",
      EXTRACTION_PROMPT.version,
      (parsed) => {
        const allowedSources = new Set(input.assets.map((asset) => asset.id));
        allowedSources.add(NOTE_SOURCE_ID);
        assertFactsGrounded(parsed.facts, parsed.evidence, {
          allowedSources,
          note: input.note,
        });
      },
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
    assertFactsGrounded(validatedInput.facts, validatedInput.evidence, {
      operatorProvidedFields: validatedInput.operatorProvidedFields,
    });
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
    const { parsed, usage } = await this.completion.complete(
      messages,
      generationOutputSchema,
      "listing_generation",
      GENERATION_PROMPT.version,
      (parsed) => assertGenerationGrounding(parsed.listing, validatedInput),
    );
    assertGenerationGrounding(parsed.listing, validatedInput);
    return { listing: parsed.listing, usage };
  }
}
