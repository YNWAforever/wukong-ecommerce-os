import { describe, expect, it, vi } from "vitest";

import {
  TAVILY_RESPONSE_LIMIT_BYTES,
  TavilyProvider,
  TavilyProviderError,
} from "./tavily-provider.js";

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

function responseBody(overrides: Record<string, unknown> = {}) {
  return {
    request_id: "request-fixture",
    usage: { credits: 1 },
    results: [
      {
        url: "https://producer.example/reserve",
        title: "Fixture Estate Reserve",
        content: "Search excerpt",
        raw_content: null,
      },
    ],
    ...overrides,
  };
}

async function caught(promise: Promise<unknown>) {
  return promise.catch((error: unknown) => error);
}

describe("TavilyProvider", () => {
  it("serializes a bounded basic search request", async () => {
    const fetch = vi.fn(async () => jsonResponse(responseBody()));
    const result = await new TavilyProvider({
      apiKey: "fixture-secret",
      fetch: fetch as typeof globalThis.fetch,
    }).search({
      query: "Fixture Estate Reserve Red",
      depth: "basic",
      allowedDomains: ["producer.example"],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init.headers)).toMatchObject(
      expect.objectContaining({}),
    );
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer fixture-secret",
    );
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      query: "Fixture Estate Reserve Red",
      search_depth: "basic",
      topic: "general",
      include_domains: ["producer.example"],
      auto_parameters: false,
      include_answer: false,
      include_usage: true,
      max_results: 5,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      results: [
        {
          url: "https://producer.example/reserve",
          title: "Fixture Estate Reserve",
          content: "Search excerpt",
          rawContent: null,
        },
      ],
      requestId: "request-fixture",
      credits: 1,
    });
  });

  it("maps the official extract result shape into the shared result contract", async () => {
    const provider = new TavilyProvider({
      apiKey: "fixture",
      fetch: async () =>
        jsonResponse({
          request_id: "extract-request",
          usage: { credits: 1 },
          results: [
            {
              url: "https://producer.example/reserve",
              raw_content: "Extracted document",
            },
          ],
          failed_results: [],
        }),
    });

    await expect(
      provider.extract({ urls: ["https://producer.example/reserve"] }),
    ).resolves.toEqual({
      requestId: "extract-request",
      credits: 1,
      results: [
        {
          url: "https://producer.example/reserve",
          title: "",
          content: "Extracted document",
          rawContent: "Extracted document",
        },
      ],
    });
  });
  it("serializes a bounded basic extract request", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        request_id: "extract-request",
        usage: { credits: 1 },
        results: [
          {
            url: "https://producer.example/reserve",
            raw_content: "Extracted document",
          },
        ],
      }),
    );
    await new TavilyProvider({
      apiKey: "fixture-secret",
      fetch: fetch as typeof globalThis.fetch,
    }).extract({ urls: ["https://producer.example/reserve"] });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/extract");
    expect(JSON.parse(String(init.body))).toEqual({
      urls: ["https://producer.example/reserve"],
      extract_depth: "basic",
      include_usage: true,
    });
  });

  it.each([
    { urls: [] },
    {
      urls: Array.from({ length: 6 }, (_, index) => `https://x.test/${index}`),
    },
    { urls: ["http://producer.example/reserve"] },
    { urls: ["not a URL"] },
  ])("rejects invalid extract URLs before dispatch", async (input) => {
    const fetch = vi.fn();
    const error = await caught(
      new TavilyProvider({
        apiKey: "fixture",
        fetch: fetch as typeof globalThis.fetch,
      }).extract(input),
    );
    expect(error).toMatchObject({ code: "rejected", status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "rejected"],
    [429, "rate_limited"],
  ] as const)(
    "sanitizes provider status %i as %s and calls once",
    async (status, code) => {
      const fetch = vi.fn(async () =>
        jsonResponse(
          { detail: "secret-bearing provider detail" },
          { status, headers: { "x-request-id": "safe-request-id" } },
        ),
      );
      const error = await caught(
        new TavilyProvider({
          apiKey: "fixture",
          fetch: fetch as typeof globalThis.fetch,
        }).search({ query: "Fixture", depth: "basic", allowedDomains: [] }),
      );
      expect(error).toBeInstanceOf(TavilyProviderError);
      expect(error).toMatchObject({
        code,
        status,
        requestId: "safe-request-id",
      });
      expect(String(error)).not.toContain("secret-bearing");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("times out exactly once with sanitized unknown-outcome metadata", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
        setTimeout(() => controller.abort(), milliseconds);
        return controller.signal;
      });
      const fetch = vi.fn(
        async (_url: RequestInfo | URL, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("credential detail", "AbortError")),
            );
          }),
      );
      const pending = caught(
        new TavilyProvider({
          apiKey: "fixture",
          fetch: fetch as typeof globalThis.fetch,
        }).search({ query: "Fixture", depth: "basic", allowedDomains: [] }),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await pending;
      expect(error).toMatchObject({ code: "outcome_unknown", status: null });
      expect(String(error)).not.toContain("credential detail");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry an ambiguous provider failure", async () => {
    let calls = 0;
    const provider = new TavilyProvider({
      apiKey: "fixture",
      fetch: async () => {
        calls++;
        throw new TypeError("network unavailable");
      },
    });
    await expect(
      provider.search({
        query: "Fixture Estate Reserve Red",
        depth: "basic",
        allowedDomains: [],
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("keeps missing usage unknown", async () => {
    const provider = new TavilyProvider({
      apiKey: "fixture",
      fetch: async () => jsonResponse(responseBody({ usage: undefined })),
    });
    await expect(
      provider.search({ query: "Fixture", depth: "basic", allowedDomains: [] }),
    ).resolves.toMatchObject({ credits: null });
  });

  it.each([{ credits: -1 }, { credits: 0.5 }, { credits: "1" }])(
    "rejects malformed usage %#",
    async (usage) => {
      const provider = new TavilyProvider({
        apiKey: "fixture",
        fetch: async () => jsonResponse(responseBody({ usage })),
      });
      await expect(
        provider.search({
          query: "Fixture",
          depth: "basic",
          allowedDomains: [],
        }),
      ).rejects.toMatchObject({ code: "invalid_output" });
    },
  );

  it("reports credits above the reserved call bound as a discrepancy", async () => {
    const provider = new TavilyProvider({
      apiKey: "fixture",
      fetch: async () => jsonResponse(responseBody({ usage: { credits: 3 } })),
    });
    await expect(
      provider.search({ query: "Fixture", depth: "basic", allowedDomains: [] }),
    ).rejects.toMatchObject({
      code: "cost_discrepancy",
      credits: 3,
      reservedCredits: 1,
      requestId: "request-fixture",
    });
  });

  it("rejects malformed result URLs", async () => {
    const provider = new TavilyProvider({
      apiKey: "fixture",
      fetch: async () =>
        jsonResponse(
          responseBody({
            results: [{ url: "javascript:bad", title: "x", content: "x" }],
          }),
        ),
    });
    await expect(
      provider.search({ query: "Fixture", depth: "basic", allowedDomains: [] }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("rejects a streamed response beyond 8 MiB without Content-Length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 9; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const provider = new TavilyProvider({
      apiKey: "fixture",
      fetch: async () => new Response(stream),
    });
    const error = await caught(
      provider.search({ query: "Fixture", depth: "basic", allowedDomains: [] }),
    );
    expect(TAVILY_RESPONSE_LIMIT_BYTES).toBe(8 * 1024 * 1024);
    expect(error).toMatchObject({ code: "invalid_output" });
  });

  it("rejects a false Content-Length above 8 MiB", async () => {
    const provider = new TavilyProvider({
      apiKey: "fixture",
      fetch: async () =>
        jsonResponse(responseBody(), {
          headers: {
            "content-length": String(TAVILY_RESPONSE_LIMIT_BYTES + 1),
          },
        }),
    });
    await expect(
      provider.search({ query: "Fixture", depth: "basic", allowedDomains: [] }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });
});
