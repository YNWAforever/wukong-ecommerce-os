export {
  projectToShopline,
} from "./projection.js";
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
export type {
  CommerceConnector,
  ConnectorErrorCode,
  ConnectorFetch,
} from "./connector.js";
export {
  ShoplineConnector,
  ShoplineError,
  type ShoplineConnectorOptions,
} from "./shopline-connector.js";
export {
  assertShoplineEncryptionKey,
  decryptShoplineToken,
  encryptShoplineToken,
} from "./token-vault.js";
