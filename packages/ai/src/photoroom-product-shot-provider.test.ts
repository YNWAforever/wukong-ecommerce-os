import { describe, expect, it, vi } from "vitest";

import {
  PhotoroomProductShotProvider,
  ProductShotProviderError,
} from "./photoroom-product-shot-provider.js";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const SELECTED_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xn6V5QAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function asset(id = "selected") {
  return {
    id,
    mimeType: "image/png",
    readUrl: "https://ignored.example/private.png",
  };
}

function provider(
  overrides: {
    fetch?: typeof globalThis.fetch;
    readSource?: (
      assetId: string,
    ) => Promise<{ bytes: Uint8Array; mimeType: string }>;
    now?: () => number;
  } = {},
) {
  return new PhotoroomProductShotProvider({
    apiKey: "synthetic-key",
    fetch:
      overrides.fetch ??
      (vi.fn(
        async () =>
          new Response(PNG, { headers: { "content-type": "image/png" } }),
      ) as unknown as typeof globalThis.fetch),
    readSource:
      overrides.readSource ??
      (async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
      })),
    now:
      overrides.now ??
      vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125),
  });
}

async function caught(promise: Promise<unknown>) {
  return promise.catch((error: unknown) => error);
}

describe("PhotoroomProductShotProvider", () => {
  it("uploads exactly the selected source bytes as PNG output request", async () => {
    const selected = SELECTED_PNG;
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(PNG, { headers: { "content-type": "image/png" } }),
    ) as unknown as typeof globalThis.fetch;
    const readSource = vi.fn(async () => ({
      bytes: selected,
      mimeType: "image/png",
    }));

    const result = await provider({ fetch, readSource }).generateProductShot({
      assets: [asset()],
    });

    expect(readSource).toHaveBeenCalledExactlyOnceWith("selected");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe("https://sdk.photoroom.com/v1/segment");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-api-key")).toBe("synthetic-key");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const form = init.body as FormData;
    expect(form.get("image_file")).toBeInstanceOf(Blob);
    expect(
      new Uint8Array(await (form.get("image_file") as Blob).arrayBuffer()),
    ).toEqual(selected);
    expect(form.get("format")).toBe("png");
    expect(form.has("image_url")).toBe(false);
    expect(result.cutoutPng).toEqual(PNG);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0.02,
      latencyMs: 25,
      model: "photoroom-remove-background",
      promptVersion: "1.0.0",
    });
  });

  it.each([{ assets: [] }, { assets: [asset("one"), asset("two")] }])(
    "rejects a non-singleton asset selection",
    async ({ assets }) => {
      const readSource = vi.fn();
      const fetch = vi.fn();
      const error = await caught(
        provider({
          readSource,
          fetch: fetch as typeof globalThis.fetch,
        }).generateProductShot({ assets }),
      );
      expect(error).toMatchObject({ code: "rejected" });
      expect(readSource).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects a source larger than 10 MiB before dispatch", async () => {
    const fetch = vi.fn();
    const error = await caught(
      provider({
        fetch: fetch as typeof globalThis.fetch,
        readSource: async () => ({
          bytes: new Uint8Array(10 * 1024 * 1024 + 1),
          mimeType: "image/png",
        }),
      }).generateProductShot({ assets: [asset()] }),
    );
    expect(error).toMatchObject({ code: "rejected" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "rejected"],
    [429, "rate_limited"],
    [500, "outcome_unknown"],
  ] as const)("maps provider status %i to %s", async (status, code) => {
    const fetch = vi.fn(
      async () => new Response("private provider detail", { status }),
    ) as unknown as typeof globalThis.fetch;
    const error = await caught(
      provider({ fetch }).generateProductShot({ assets: [asset()] }),
    );
    expect(error).toBeInstanceOf(ProductShotProviderError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("private provider detail");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a streamed response beyond the 10 MiB cap", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 11; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const fetch = vi.fn(
      async () =>
        new Response(stream, { headers: { "content-type": "image/png" } }),
    ) as unknown as typeof globalThis.fetch;
    const error = await caught(
      provider({ fetch }).generateProductShot({ assets: [asset()] }),
    );
    expect(error).toMatchObject({ code: "invalid_output" });
  });

  it("preserves invalid output classification when overflow cancellation rejects", async () => {
    const chunk = new Uint8Array(10 * 1024 * 1024 + 1);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        return Promise.reject(new Error("private cancellation detail"));
      },
    });
    const fetch = vi.fn(
      async () =>
        new Response(stream, { headers: { "content-type": "image/png" } }),
    ) as unknown as typeof globalThis.fetch;
    const error = await caught(
      provider({ fetch }).generateProductShot({ assets: [asset()] }),
    );
    expect(error).toMatchObject({ code: "invalid_output" });
    expect(String(error)).not.toContain("private cancellation detail");
  });
  it.each([
    ["image/jpeg", PNG],
    ["image/png", new Uint8Array([1, 2, 3])],
  ] as const)("rejects invalid output %s", async (contentType, bytes) => {
    const fetch = vi.fn(
      async () =>
        new Response(bytes, { headers: { "content-type": contentType } }),
    ) as unknown as typeof globalThis.fetch;
    const error = await caught(
      provider({ fetch }).generateProductShot({ assets: [asset()] }),
    );
    expect(error).toMatchObject({ code: "invalid_output" });
  });

  it("aborts the dispatched request after the connection timeout", async () => {
    vi.useFakeTimers();
    try {
      const timeoutController = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) => {
          setTimeout(() => timeoutController.abort(), ms);
          return timeoutController.signal;
        });
      let suppliedSignal: AbortSignal | undefined;
      const fetch = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          suppliedSignal = init?.signal ?? undefined;
          return await new Promise<Response>((_resolve, reject) => {
            suppliedSignal?.addEventListener("abort", () => {
              reject(new DOMException("private timeout detail", "AbortError"));
            });
          });
        },
      ) as unknown as typeof globalThis.fetch;
      const pending = caught(
        provider({ fetch }).generateProductShot({ assets: [asset()] }),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await pending;
      expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
      expect(suppliedSignal).toBe(timeoutController.signal);
      expect(suppliedSignal?.aborted).toBe(true);
      expect(error).toMatchObject({ code: "outcome_unknown" });
      expect(String(error)).not.toContain("private timeout detail");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
