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

export {
  PRODUCT_TYPE_GOLDEN_SET,
  PRODUCT_TYPES,
  assertClassificationEvaluation,
  evaluateProductTypeClassification,
} from "./product-type-eval.js";
export type {
  ClassificationEvaluation,
  ClassificationThresholds,
  ProductType,
  ProductTypeCase,
  ProductTypeClassifier,
} from "./product-type-eval.js";

export {
  providerFailureDiagnostic,
  type PhysicalInvocationObserver,
  type PhysicalInvocationRecord,
  type PhysicalInvocationUsage,
  type ProviderDiagnostic,
  type ProviderFailureCategory,
} from "./listing-provider-errors.js";

export { OpenRouterListingProvider } from "./openrouter-listing-provider.js";
export type { OpenRouterListingProviderConfig } from "./openrouter-listing-provider.js";

export {
  FACT_GROUNDING_MODES,
  GENERATION_REQUIRED_FACTS,
  factsSufficientForGeneration,
} from "./fact-grounding-rules.js";
export type { GroundingMode } from "./fact-grounding-rules.js";

export { calculateConservativeRunCeiling } from "./provider-cost-bound.js";

export {
  OpenCodeGoListingProvider,
  type OpenCodeGoListingProviderConfig,
} from "./opencode-go-listing-provider.js";
export {
  TAVILY_REQUEST_TIMEOUT_MS,
  TAVILY_RESPONSE_LIMIT_BYTES,
  TavilyProvider,
  TavilyProviderError,
} from "./tavily-provider.js";
export type {
  TavilyProviderConfig,
  TavilyProviderErrorCode,
  TavilyResponse,
  TavilyResult,
} from "./tavily-provider.js";
export { TypedJsonCompletionClient } from "./typed-json-completion.js";
export type { TypedJsonCompletionConfig } from "./typed-json-completion.js";
export {
  WineEnrichmentProvider,
  validateWineSupportProposal,
  wineExtractionSchema,
  wineVerificationProposalSchema,
  wineSupportProposalSchema,
  wineFrozenContextSchema,
  wineQualityIssueSchema,
} from "./wine-enrichment-provider.js";
export type {
  WineExtraction,
  WineSupportProposal,
  WineFrozenContext,
  WineVerificationRequest,
  WineVerificationResult,
  WineObserverCoordinate,
  WineObserverFactory,
  WineEnrichmentProviderConfig,
} from "./wine-enrichment-provider.js";
export {
  WINE_PROMPT_VERSIONS,
  WINE_PROMPTS,
  WINE_STAGE_ROLES,
  WINE_EXECUTION_SNAPSHOT,
  wineExecutionSnapshotSchema,
} from "./wine-enrichment-prompts.js";
export type {
  WineRole,
  WineLogicalStage,
  WineExecutionSnapshot,
} from "./wine-enrichment-prompts.js";
export {
  wineGenerationRequestSchema,
  wineOutputAnnotationSchema,
  wineGenerationCandidateSchema,
  wineCheckResponseSchema,
  type WineGenerationRequest,
  type WineGenerationCandidate,
  type WineGenerationResult,
  type WineCheckRequest,
  type WineCheckResult,
} from "./wine-enrichment-schemas.js";

export {
  validateWineGenerationRequest,
  wineCandidateIssues,
} from "./wine-enrichment-content-validation.js";
