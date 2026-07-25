import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  encryptShoplineToken,
  type ShoplineProductPayload,
} from "@wukong/shopline";
import { createShoplineConnectorFactory } from "./shopline-runtime.js";

const base64Key = Buffer.alloc(32, 11).toString("base64");
const token = "worker-only-shopline-token";
const payload = {
  product: { title: "Mock product" },
} as unknown as ShoplineProductPayload;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SHOPLINE connector factory", () => {
  it("disabled returns null without reading or constructing credentials", async () => {
    const connection = Object.defineProperty({}, "encryptedAccessToken", {
      get() {
        throw new Error("credential was read");
      },
    });
    const factory = createShoplineConnectorFactory({
      SHOPLINE_ADAPTER: "disabled",
    });

    await expect(factory(connection as never)).resolves.toBeNull();
  });

  it("mock needs no token or network and returns a deterministic SHA-256-prefixed id", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const factory = createShoplineConnectorFactory({
      SHOPLINE_ADAPTER: "mock",
    });
    const connector = await factory();
    if (!connector) throw new Error("mock connector was not created");
    const idempotencyKey = "workspace:version:shopline:create";
    const expected = `mock_${createHash("sha256")
      .update(idempotencyKey, "utf8")
      .digest("hex")
      .slice(0, 16)}`;

    await expect(
      connector.createProduct(payload, idempotencyKey),
    ).resolves.toEqual({ remoteProductId: expected });
    await expect(
      connector.createProduct(payload, idempotencyKey),
    ).resolves.toEqual({ remoteProductId: expected });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("real rejects unless both the explicit write gate and a valid key are present", () => {
    expect(() =>
      createShoplineConnectorFactory({
        SHOPLINE_ADAPTER: "real",
        SHOPLINE_TOKEN_ENCRYPTION_KEY: base64Key,
      }),
    ).toThrow("SHOPLINE real publishing is disabled");
    expect(() =>
      createShoplineConnectorFactory({
        SHOPLINE_ADAPTER: "real",
        SHOPLINE_PUBLISH_ENABLED: "true",
        SHOPLINE_TOKEN_ENCRYPTION_KEY: "invalid-key",
      }),
    ).toThrow("SHOPLINE credential is unavailable");
  });

  it("real decrypts in the Worker and does not expose plaintext or ciphertext", async () => {
    const encryptedAccessToken = await encryptShoplineToken(token, base64Key);
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${token}`,
        );
        return new Response(
          JSON.stringify({ merchant: { id: "merchant_1" } }),
          {
            status: 200,
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetch);
    const factory = createShoplineConnectorFactory({
      SHOPLINE_ADAPTER: "real",
      SHOPLINE_PUBLISH_ENABLED: "true",
      SHOPLINE_TOKEN_ENCRYPTION_KEY: base64Key,
    });
    const connector = await factory({ encryptedAccessToken });
    if (!connector) throw new Error("real connector was not created");

    expect(JSON.stringify(connector)).not.toContain(token);
    expect(JSON.stringify(connector)).not.toContain(encryptedAccessToken);
    await expect(connector.verifyConnection()).resolves.toEqual({
      merchantId: "merchant_1",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects adapter values outside disabled, mock, and real", () => {
    expect(() =>
      createShoplineConnectorFactory({ SHOPLINE_ADAPTER: "preview" } as never),
    ).toThrow("unsupported SHOPLINE adapter mode");
  });
});
