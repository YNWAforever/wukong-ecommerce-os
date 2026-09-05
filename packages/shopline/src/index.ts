export { projectToShopline } from "./projection.js";
export type {
  ShoplineProduct,
  ShoplineProductPayload,
  ShoplineTranslations,
} from "./projection.js";

export {
  ShoplineValidationError,
  SHOPLINE_TITLE_MAX_LENGTH,
  validateShoplineProduct,
  validateShoplineProducts,
} from "./validation.js";
export type {
  ShoplineBatchValidationResult,
  ShoplineValidationIssue,
  ShoplineValidationResult,
} from "./validation.js";

export { SHOPLINE_CSV_SPEC_VERSION, createShoplineCsv } from "./csv.js";

export {
  BULK_FORM_COLUMNS,
  BULK_FORM_ENRICHABLE_COLUMNS,
  BULK_FORM_LOCKED_COLUMNS,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
  ShoplineBulkFormError,
  bulkFormGaps,
  createBulkFormUpdate,
  isBulkFormRawRow,
  parseBulkForm,
} from "./bulk-form.js";
export type {
  BulkFormCategoryPath,
  BulkFormCell,
  BulkFormChange,
  BulkFormColumnKey,
  BulkFormContentGaps,
  BulkFormEnrichableColumn,
  BulkFormEnrichment,
  BulkFormEnrichmentIssue,
  BulkFormEnrichmentIssueCode,
  BulkFormExportRow,
  BulkFormGapsInput,
  BulkFormIssue,
  BulkFormIssueCode,
  BulkFormParseResult,
  BulkFormProductRow,
  BulkFormRawRow,
  BulkFormSheet,
  BulkFormText,
  BulkFormUpdate,
  BulkFormUpdateOptions,
} from "./bulk-form.js";
export {
  hashBulkFormHeaderContract,
  hashBulkFormRow,
} from "./bulk-form-digest.js";
export { renderBulkFormSource } from "./bulk-form-source.js";
export {
  evaluateDeliveryPolicy,
  hashCanonicalListing,
  shoplinePublishIdempotencyKey,
} from "./delivery-policy.js";
export type {
  DeliveryAuditFacts,
  DeliveryConnectionSnapshot,
  DeliveryJobSnapshot,
  DeliveryListingSnapshot,
  DeliveryMethod,
  DeliveryPlan,
  DeliveryPolicyInput,
  DeliveryPolicyOutcome,
  DeliveryPolicyPhase,
} from "./delivery-policy.js";
export type {
  CommerceConnector,
  ConnectorErrorCode,
  ConnectorFetch,
} from "./connector.js";
export {
  ShoplineConnector,
  ShoplineError,
  SHOPLINE_REQUEST_TIMEOUT_MS,
  type ShoplineConnectorOptions,
} from "./shopline-connector.js";
export {
  assertShoplineEncryptionKey,
  decryptShoplineToken,
  encryptShoplineToken,
} from "./token-vault.js";

export * from "./fresh-export-comparison.js";
