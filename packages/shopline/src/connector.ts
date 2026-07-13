import type { ShoplineProductPayload } from "./projection.js";

export type ConnectorErrorCode =
  | "invalid_credentials_or_permission"
  | "validation_failed"
  | "rate_limited"
  | "remote_unavailable";

export type ConnectorFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CommerceConnector {
  verifyConnection(): Promise<{ merchantId: string | null }>;
  createProduct(
    payload: ShoplineProductPayload,
    idempotencyKey: string,
  ): Promise<{ remoteProductId: string }>;
  updateProduct(
    remoteProductId: string,
    payload: ShoplineProductPayload,
    idempotencyKey: string,
  ): Promise<void>;
  getProductStatus(
    remoteProductId: string,
  ): Promise<{ exists: boolean; status: boolean | null }>;
}
