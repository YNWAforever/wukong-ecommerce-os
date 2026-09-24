import type {
  ProductShotInput,
  ProductShotProvider,
  ProductShotResult,
} from "./contracts.js";

export const PHOTOROOM_PRODUCT_SHOT_MODEL = "photoroom-remove-background";
export const PHOTOROOM_PRODUCT_SHOT_VERSION = "1.0.0";
export const PHOTOROOM_ESTIMATED_COST_USD = 0.02;
export const PHOTOROOM_REQUEST_TIMEOUT_MS = 30_000;
export const PHOTOROOM_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;
const PHOTOROOM_INPUT_LIMIT_BYTES = 10 * 1024 * 1024;

export type ProductShotProviderErrorCode =
  "rejected" | "rate_limited" | "invalid_output" | "outcome_unknown";
export class ProductShotProviderError extends Error {
  readonly code: ProductShotProviderErrorCode;
  constructor(code: ProductShotProviderErrorCode) {
    super(code);
    this.name = "ProductShotProviderError";
    this.code = code;
  }
}

export type PhotoroomProductShotProviderConfig = {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  readSource: (
    assetId: string,
  ) => Promise<{ bytes: Uint8Array; mimeType: string }>;
  now: () => number;
};

function safeLatency(start: number, end: number): number {
  const latency = end - start;
  return Number.isFinite(latency) && latency >= 0 ? latency : 0;
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return [137, 80, 78, 71, 13, 10, 26, 10].every(
    (byte, index) => bytes[index] === byte,
  );
}

async function readBoundedResponse(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (!response.body) throw new ProductShotProviderError("invalid_output");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ProductShotProviderError("invalid_output");
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class PhotoroomProductShotProvider implements ProductShotProvider {
  constructor(private readonly config: PhotoroomProductShotProviderConfig) {}

  async generateProductShot(
    input: ProductShotInput,
  ): Promise<ProductShotResult> {
    if (input.assets.length !== 1)
      throw new ProductShotProviderError("rejected");
    const selected = input.assets[0];
    if (!selected) throw new ProductShotProviderError("rejected");
    let source: { bytes: Uint8Array; mimeType: string };
    try {
      source = await this.config.readSource(selected.id);
    } catch {
      throw new ProductShotProviderError("rejected");
    }
    if (source.bytes.byteLength > PHOTOROOM_INPUT_LIMIT_BYTES)
      throw new ProductShotProviderError("rejected");

    const form = new FormData();
    form.set(
      "image_file",
      new Blob([source.bytes as BlobPart], { type: source.mimeType }),
      "source",
    );
    form.set("format", "png");
    const startedAt = this.config.now();
    let response: Response;
    try {
      response = await this.config.fetch(
        "https://sdk.photoroom.com/v1/segment",
        {
          method: "POST",
          headers: { "x-api-key": this.config.apiKey },
          body: form,
          redirect: "error",
          signal: AbortSignal.timeout(PHOTOROOM_REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      throw new ProductShotProviderError("outcome_unknown");
    }

    if (!response.ok) {
      if (response.status === 429)
        throw new ProductShotProviderError("rate_limited");
      if ([400, 401, 403].includes(response.status))
        throw new ProductShotProviderError("rejected");
      throw new ProductShotProviderError("outcome_unknown");
    }
    if (
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "image/png"
    )
      throw new ProductShotProviderError("invalid_output");
    let cutoutPng: Uint8Array;
    try {
      cutoutPng = await readBoundedResponse(
        response,
        PHOTOROOM_OUTPUT_LIMIT_BYTES,
      );
    } catch (error) {
      if (error instanceof ProductShotProviderError) throw error;
      throw new ProductShotProviderError("outcome_unknown");
    }
    if (!hasPngSignature(cutoutPng))
      throw new ProductShotProviderError("invalid_output");
    return {
      cutoutPng,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: PHOTOROOM_ESTIMATED_COST_USD,
        latencyMs: safeLatency(startedAt, this.config.now()),
        model: PHOTOROOM_PRODUCT_SHOT_MODEL,
        promptVersion: PHOTOROOM_PRODUCT_SHOT_VERSION,
      },
    };
  }
}
