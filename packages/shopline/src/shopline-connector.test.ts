import { describe, expect, it, vi } from "vitest";

import fixture from "../fixtures/shopline-create-product.json" with { type: "json" };
import { ShoplineConnector, ShoplineError } from "./shopline-connector.js";

const payload = fixture as Parameters<ShoplineConnector["createProduct"]>[0];

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("ShoplineConnector", () => {
  it("creates a hidden SHOPLINE product with bearer authentication", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://open.shopline.io/v1/products");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer shopline_test_token",
        );
        expect(new Headers(init?.headers).get("content-type")).toBe(
          "application/json",
        );
        expect(new Headers(init?.headers).get("idempotency-key")).toBe(
          "delivery_key_1",
        );
        expect(JSON.parse(String(init?.body))).toEqual(payload);
        return response(201, { product: { _id: "remote_123" } });
      },
    );

    const result = await new ShoplineConnector("shopline_test_token", {
      fetch,
    }).createProduct(payload, "delivery_key_1");
    expect(result).toEqual({ remoteProductId: "remote_123" });
  });

  it.each([
    [401, "invalid_credentials_or_permission"],
    [403, "invalid_credentials_or_permission"],
    [422, "validation_failed"],
    [429, "rate_limited"],
    [500, "remote_unavailable"],
  ] as const)(
    "maps HTTP %s to a typed redacted error",
    async (status, code) => {
      const fetch = vi.fn(async () =>
        response(status, { token: "do-not-leak", detail: "private" }),
      );
      await expect(
        new ShoplineConnector("secret-token", { fetch }).createProduct(
          payload,
          "key",
        ),
      ).rejects.toMatchObject({ code, status });
      try {
        await new ShoplineConnector("secret-token", { fetch }).createProduct(
          payload,
          "key",
        );
      } catch (error) {
        expect(String(error)).not.toContain("secret-token");
        expect(String(error)).not.toContain("private");
        expect(String(error)).not.toContain("do-not-leak");
      }
    },
  );

  it("aborts a bounded request and maps timeout to a redacted stable error", async () => {
    let requestSignal: AbortSignal | null = null;
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? null;
          requestSignal?.addEventListener(
            "abort",
            () =>
              reject(
                requestSignal?.reason ??
                  new DOMException("request timed out", "AbortError"),
              ),
            { once: true },
          );
        }),
    );
    const request = new ShoplineConnector("secret-timeout-token", {
      fetch,
      requestTimeoutMs: 10,
    } as any).createProduct(payload, "timeout_key");

    const outcome = await Promise.race([
      request.catch((error: unknown) => error),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("test_guard_elapsed"), 100),
      ),
    ]);

    expect(outcome).toMatchObject({
      code: "remote_unavailable",
      message: "SHOPLINE request failed: remote_unavailable",
    });
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(true);
    expect(String(outcome)).not.toContain("secret-timeout-token");
  });

  it("maps network and malformed JSON responses to remote_unavailable", async () => {
    const network = new ShoplineConnector("secret", {
      fetch: vi.fn(async () => {
        throw new Error("socket secret");
      }),
    });
    await expect(network.createProduct(payload, "key")).rejects.toMatchObject({
      code: "remote_unavailable",
    });

    const malformed = new ShoplineConnector("secret", {
      fetch: vi.fn(async () => new Response("not-json", { status: 200 })),
    });
    await expect(malformed.createProduct(payload, "key")).rejects.toMatchObject(
      { code: "remote_unavailable" },
    );
  });

  it("supports safe update, status, and connection requests without arbitrary URL injection", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        if (String(input).endsWith("/me"))
          return response(200, { merchant: { id: "merchant_1" } });
        if (String(input).endsWith("/remote_123"))
          return response(200, {
            product: { _id: "remote_123", status: true },
          });
        return response(200, {});
      },
    );
    const connector = new ShoplineConnector("token", { fetch });
    await expect(connector.verifyConnection()).resolves.toEqual({
      merchantId: "merchant_1",
    });
    await expect(
      connector.updateProduct("remote_123", payload, "update_key"),
    ).resolves.toBeUndefined();
    await expect(connector.getProductStatus("remote_123")).resolves.toEqual({
      exists: true,
      status: true,
    });
    expect(calls).toEqual([
      "GET https://open.shopline.io/v1/me",
      "PUT https://open.shopline.io/v1/products/remote_123",
      "GET https://open.shopline.io/v1/products/remote_123",
    ]);
    expect(
      () =>
        new ShoplineConnector("token", {
          baseUrl: "https://open.shopline.io/v1/https://evil.test",
        }),
    ).not.toThrow();
  });

  it("throws a typed error when the create response does not contain a strict remote id", async () => {
    const fetch = vi.fn(async () =>
      response(201, { product: { id: "wrong-field" } }),
    );
    await expect(
      new ShoplineConnector("token", { fetch }).createProduct(payload, "key"),
    ).rejects.toMatchObject({ code: "remote_unavailable" });
  });

  it("constructs ShoplineError without exposing response bodies", () => {
    const error = new ShoplineError("remote_unavailable", 503);
    expect(error.code).toBe("remote_unavailable");
    expect(error.status).toBe(503);
    expect(error.message).toBe("SHOPLINE request failed: remote_unavailable");
  });
});
