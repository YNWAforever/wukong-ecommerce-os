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
export {
  PHOTOROOM_ESTIMATED_COST_USD,
  PHOTOROOM_OUTPUT_LIMIT_BYTES,
  PHOTOROOM_PRODUCT_SHOT_MODEL,
  PHOTOROOM_PRODUCT_SHOT_VERSION,
  PHOTOROOM_REQUEST_TIMEOUT_MS,
  PhotoroomProductShotProvider,
  ProductShotProviderError,
} from "./photoroom-product-shot-provider.js";
export type {
  PhotoroomProductShotProviderConfig,
  ProductShotProviderErrorCode,
} from "./photoroom-product-shot-provider.js";
export type {
  ModelPricing,
  OpenAIListingProviderConfig,
  ResponsesClientPort,
} from "./openai-listing-provider.js";

export {
  EXTRACTION_PROMPT,
  GENERATION_PROMPT,
  PRODUCT_SHOT_PROMPT,
} from "./prompts.js";

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
