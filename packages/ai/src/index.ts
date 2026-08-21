export type {
  AIUsage,
  ExtractionAsset,
  ExtractionInput,
  ExtractionResult,
  GenerationInput,
  GenerationResult,
  ListingAIProvider,
  ProductShotInput,
  ProductShotResult,
  ProductShotProvider,
} from "./contracts.js";
export { NOTE_SOURCE_ID } from "./contracts.js";
export { FakeListingProvider } from "./fake-listing-provider.js";
export {
  ListingProviderError,
  LISTING_PROVIDER_REQUEST_TIMEOUT_MS,
  OpenAIListingProvider,
  ProviderApiError,
  ProviderOutputError,
  ProviderRefusalError,
  UnsupportedAssetError,
} from "./openai-listing-provider.js";
export type {
  ModelPricing,
  OpenAIListingProviderConfig,
  ResponsesClientPort,
} from "./openai-listing-provider.js";
export { EXTRACTION_PROMPT, GENERATION_PROMPT, PRODUCT_SHOT_PROMPT } from "./prompts.js";

export {
  PROTECTED_FACT_FIELDS,
  assertEvaluation,
  evaluateExtraction,
} from "./eval.js";
export type {
  EvaluationFixture,
  ExtractionEvaluation,
  NumericAgreement,
  NumericFactField,
  ProtectedFactField,
} from "./eval.js";
