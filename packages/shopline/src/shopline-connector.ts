import type {
  CommerceConnector,
  ConnectorErrorCode,
  ConnectorFetch,
} from "./connector.js";
import type { ShoplineProductPayload } from "./projection.js";

export type ShoplineConnectorOptions = {
  baseUrl?: string;
  fetch?: ConnectorFetch;
};

export class ShoplineError extends Error {
  readonly code: ConnectorErrorCode;
  readonly status: number | null;

  constructor(code: ConnectorErrorCode, status: number | null = null) {
    super(`SHOPLINE request failed: ${code}`);
    this.name = "ShoplineError";
    this.code = code;
    this.status = status;
  }
}

function errorCode(status: number): ConnectorErrorCode {
  if (status === 401 || status === 403) return "invalid_credentials_or_permission";
  if (status === 422) return "validation_failed";
  if (status === 429) return "rate_limited";
  return "remote_unavailable";
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SHOPLINE base URL must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("SHOPLINE base URL must use HTTP(S)");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("SHOPLINE base URL must not contain a query or fragment");
  }
  return value.replace(/\/+$/, "");
}

function safeRemoteProductId(value: string): string {
  if (!/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new ShoplineError("validation_failed");
  }
  return encodeURIComponent(value);
}

function strictString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class ShoplineConnector implements CommerceConnector {
  readonly #token: string;
  private readonly baseUrl: string;
  private readonly requestFetch: ConnectorFetch;

  constructor(
    token: string,
    options: ShoplineConnectorOptions = {},
  ) {
    if (!token.trim()) throw new Error("SHOPLINE token is required");
    this.#token = token;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://open.shopline.io/v1");
    this.requestFetch = options.fetch ?? fetch;
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.requestFetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#token}`,
          ...init.headers,
        },
      });
    } catch {
      throw new ShoplineError("remote_unavailable");
    }

    if (!response.ok) {
      throw new ShoplineError(errorCode(response.status), response.status);
    }

    try {
      return await response.json();
    } catch {
      throw new ShoplineError("remote_unavailable", response.status);
    }
  }

  private async requestNoContent(path: string, init: RequestInit = {}): Promise<void> {
    try {
      const response = await this.requestFetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#token}`,
          ...init.headers,
        },
      });
      if (!response.ok) throw new ShoplineError(errorCode(response.status), response.status);
    } catch (error) {
      if (error instanceof ShoplineError) throw error;
      throw new ShoplineError("remote_unavailable");
    }
  }

  async verifyConnection(): Promise<{ merchantId: string | null }> {
    const body = await this.requestJson("/me");
    if (typeof body !== "object" || body === null) {
      throw new ShoplineError("remote_unavailable");
    }
    const merchant = (body as { merchant?: unknown }).merchant;
    if (typeof merchant !== "object" || merchant === null) {
      return { merchantId: null };
    }
    const id = (merchant as { id?: unknown }).id;
    return { merchantId: strictString(id) ? id : null };
  }

  async createProduct(
    payload: ShoplineProductPayload,
    idempotencyKey: string,
  ): Promise<{ remoteProductId: string }> {
    const body = await this.requestJson("/products", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
    });
    const id =
      typeof body === "object" && body !== null &&
      typeof (body as { product?: unknown }).product === "object" &&
      (body as { product: { _id?: unknown } }).product !== null
        ? (body as { product: { _id?: unknown } }).product._id
        : undefined;
    if (!strictString(id)) throw new ShoplineError("remote_unavailable");
    return { remoteProductId: id };
  }

  async updateProduct(
    remoteProductId: string,
    payload: ShoplineProductPayload,
    idempotencyKey: string,
  ): Promise<void> {
    await this.requestNoContent(`/products/${safeRemoteProductId(remoteProductId)}`, {
      method: "PUT",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
    });
  }

  async getProductStatus(
    remoteProductId: string,
  ): Promise<{ exists: boolean; status: boolean | null }> {
    const encodedId = safeRemoteProductId(remoteProductId);
    let response: Response;
    try {
      response = await this.requestFetch(`${this.baseUrl}/products/${encodedId}`, {
        method: "GET",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#token}`,
        },
      });
    } catch {
      throw new ShoplineError("remote_unavailable");
    }
    if (response.status === 404) return { exists: false, status: null };
    if (!response.ok) throw new ShoplineError(errorCode(response.status), response.status);
    try {
      const body = await response.json();
      if (typeof body !== "object" || body === null || typeof (body as { product?: unknown }).product !== "object" || (body as { product: unknown }).product === null) {
        throw new Error("shape");
      }
      const product = (body as { product: { _id?: unknown; status?: unknown } }).product;
      if (!strictString(product._id) || product._id !== remoteProductId || (product.status !== true && product.status !== false)) {
        throw new Error("shape");
      }
      return { exists: true, status: product.status };
    } catch {
      throw new ShoplineError("remote_unavailable", response.status);
    }
  }
}

export type { CommerceConnector, ConnectorErrorCode, ConnectorFetch } from "./connector.js";
