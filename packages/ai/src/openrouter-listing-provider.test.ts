import { describe, expect, it, vi } from "vitest";
import { OpenRouterListingProvider } from "./openrouter-listing-provider.js";
import {
  ProviderApiError,
  ProviderOutputError,
  ProviderRefusalError,
  UnsupportedAssetError,
} from "./listing-provider-errors.js";
import { buildSafeListing } from "./listing-output-validation.js";

const facts = {
  sku: null,
  producer: null,
  productType: null,
  country: null,
  region: null,
  vintage: null,
  grapeVarieties: [],
  volumeMl: null,
  abvPercent: null,
  packQuantity: 1,
  priceHkd: null,
  stockQuantity: null,
  criticScores: [],
  awards: [],
};
const extraction = { facts, evidence: [], missingFields: [] };
const empty = { assets: [], note: null };
function envelope(
  output: unknown = extraction,
  extra: Record<string, unknown> = {},
) {
  return {
    id: "synthetic",
    object: "chat.completion",
    created: 0,
    model: "test/vision-model",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify(output),
          refusal: null,
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
    ...extra,
  };
}
function setup(...responses: unknown[]) {
  const sent: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    sent.push(new Request(input, init));
    return Response.json(responses.shift());
  };
  return {
    sent,
    provider: new OpenRouterListingProvider({
      apiKey: " synthetic-key ",
      model: "test/vision-model",
      fetch: fetcher,
    }),
  };
}
const fullFacts = {
  ...facts,
  sku: "DEMO",
  producer: "Estate",
  productType: "wine" as const,
  country: "France",
  volumeMl: 750,
  abvPercent: 12,
  priceHkd: 200,
};
const generation = {
  facts: fullFacts,
  evidence: Object.entries(fullFacts)
    .filter(
      ([key, value]) =>
        value !== null && !Array.isArray(value) && key !== "packQuantity",
    )
    .map(([field, value]) => ({
      field,
      sourceAssetId: "note",
      page: null,
      excerpt: String(value),
      confidence: 1,
    })),
  profile: {
    name: "Demo",
    currency: "HKD" as const,
    locales: ["en", "zh-Hant"] as ["en", "zh-Hant"],
    tone: "restrained",
    claimPolicy: [],
    requiredFields: [],
    brandBackgroundColor: null,
  },
  imageAssetIds: ["image"],
};

describe("OpenRouter listing provider", () => {
  it("uses actual SDK chat wire, strict schema, and provider-reported accounting", async () => {
    const { sent, provider } = setup(envelope());
    const result = await provider.extract(empty);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer synthetic-key");
    const body = await sent[0]!.json();
    expect(body).toMatchObject({
      model: "test/vision-model",
      stream: false,
      provider: { require_parameters: true },
      response_format: {
        type: "json_schema",
        json_schema: { name: "listing_extraction", strict: true },
      },
    });
    for (const key of ["reasoning", "tools", "plugins"])
      expect(body).not.toHaveProperty(key);
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.001,
      model: "test/vision-model",
    });
    expect(result.missingFields).toContain("sku");
  });
  it("sends text before HTTPS image parts", async () => {
    const { sent, provider } = setup(envelope());
    await provider.extract({
      assets: [
        {
          id: "image",
          mimeType: "image/png",
          readUrl: "https://assets.invalid/image.png",
        },
      ],
      note: null,
    });
    const body = await sent[0]!.json();
    expect(body.messages[1].content).toEqual([
      { type: "text", text: expect.any(String) },
      {
        type: "image_url",
        image_url: { url: "https://assets.invalid/image.png" },
      },
    ]);
  });
  it.each(["application/pdf", "image/gif"])(
    "rejects %s before dispatch",
    async (mimeType) => {
      const { sent, provider } = setup();
      await expect(
        provider.extract({
          assets: [{ id: "x", mimeType, readUrl: "https://assets.invalid/x" }],
          note: null,
        }),
      ).rejects.toBeInstanceOf(UnsupportedAssetError);
      expect(sent).toHaveLength(0);
    },
  );
  it.each([
    "http://assets.invalid/x",
    "https://user:pass@assets.invalid/x",
    "invalid",
  ])("rejects unsafe URL %s", async (readUrl) => {
    const { sent, provider } = setup();
    await expect(
      provider.extract({
        assets: [{ id: "x", mimeType: "image/png", readUrl }],
        note: null,
      }),
    ).rejects.toBeInstanceOf(UnsupportedAssetError);
    expect(sent).toHaveLength(0);
  });
  it.each([
    "",
    "plain",
    "openrouter/auto",
    "openrouter/free",
    "vendor/model:free",
    "vendor/model:online",
    "vendor/model:latest",
    "vendor/model:extended",
    "vendor/latest",
    "vendor/auto",
    "vendor/model-search",
    "vendor/" + "a".repeat(128),
  ])("rejects unsafe model %s", (model) => {
    expect(
      () =>
        new OpenRouterListingProvider({
          apiKey: "synthetic",
          model,
          fetch: vi.fn(),
        }),
    ).toThrow(TypeError);
  });
  it("requires explicit key and model and bounded timeout", () => {
    for (const apiKey of ["", " ", undefined])
      expect(
        () =>
          new OpenRouterListingProvider({
            apiKey: apiKey as string,
            model: "test/model",
          }),
      ).toThrow(TypeError);
    expect(
      () =>
        new OpenRouterListingProvider({
          apiKey: "x",
          model: undefined as unknown as string,
        }),
    ).toThrow(TypeError);
    for (const timeoutMs of [999, 600001, NaN, 1000.5])
      expect(
        () =>
          new OpenRouterListingProvider({
            apiKey: "x",
            model: "test/model",
            timeoutMs,
          }),
      ).toThrow(TypeError);
  });
  it("repairs malformed JSON once using original messages and sums usage", async () => {
    const first = envelope(
      {},
      {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "SECRET broken json" },
          },
        ],
      },
    );
    const { sent, provider } = setup(first, envelope());
    expect((await provider.extract(empty)).usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      estimatedCostUsd: 0.002,
    });
    expect(sent).toHaveLength(2);
    const original = await sent[0]!.json();
    const repair = await sent[1]!.json();
    expect(repair.messages.slice(0, -1)).toEqual(original.messages);
    expect(JSON.stringify(repair)).not.toContain("SECRET");
  });
  it("exhausts schema repair after two responses", async () => {
    const { sent, provider } = setup(envelope({}), envelope({}));
    await expect(provider.extract(empty)).rejects.toBeInstanceOf(
      ProviderOutputError,
    );
    expect(sent).toHaveLength(2);
  });
  it.each([
    undefined,
    null,
    {},
    { prompt_tokens: -1, completion_tokens: 0, cost: 0 },
    { prompt_tokens: 1.5, completion_tokens: 0, cost: 0 },
    { prompt_tokens: 0, completion_tokens: 0, cost: -1 },
    { prompt_tokens: 0, completion_tokens: 0, cost: Infinity },
  ])("rejects invalid usage without repair %#", async (usage) => {
    const { sent, provider } = setup(envelope({}, { usage }));
    await expect(provider.extract(empty)).rejects.toBeInstanceOf(
      ProviderOutputError,
    );
    expect(sent).toHaveLength(1);
  });
  it("accepts explicit zero accounting and absent response model", async () => {
    const { provider } = setup(
      envelope(extraction, {
        model: undefined,
        usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
      }),
    );
    expect((await provider.extract(empty)).usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      model: "test/vision-model",
    });
  });
  it.each(["length", "tool_calls", "content_filter"])(
    "does not repair %s",
    async (finish_reason) => {
      const { sent, provider } = setup(
        envelope(
          {},
          { choices: [{ finish_reason, message: { content: "{}" } }] },
        ),
      );
      await expect(provider.extract(empty)).rejects.toBeInstanceOf(
        finish_reason === "content_filter"
          ? ProviderRefusalError
          : ProviderOutputError,
      );
      expect(sent).toHaveLength(1);
    },
  );
  it("does not repair refusal", async () => {
    const { sent, provider } = setup(
      envelope(
        {},
        {
          choices: [
            {
              finish_reason: "stop",
              message: { content: null, refusal: "secret" },
            },
          ],
        },
      ),
    );
    await expect(provider.extract(empty)).rejects.toBeInstanceOf(
      ProviderRefusalError,
    );
    expect(sent).toHaveLength(1);
  });
  it.each([[], [{}, {}], null])(
    "rejects malformed choices %#",
    async (choices) => {
      const { sent, provider } = setup(envelope({}, { choices }));
      await expect(provider.extract(empty)).rejects.toBeInstanceOf(
        ProviderOutputError,
      );
      expect(sent).toHaveLength(1);
    },
  );
  it.each(["unknown", "note"])(
    "rejects ungrounded source %s without repair",
    async (sourceAssetId) => {
      const { sent, provider } = setup(
        envelope({
          facts: { ...facts, producer: "Forged" },
          evidence: [
            {
              field: "producer",
              sourceAssetId,
              page: null,
              excerpt: "Forged",
              confidence: 1,
            },
          ],
          missingFields: [],
        }),
      );
      await expect(provider.extract(empty)).rejects.toBeInstanceOf(
        ProviderOutputError,
      );
      expect(sent).toHaveLength(1);
    },
  );
  it("generates validated grounded listing", async () => {
    const listing = buildSafeListing(generation);
    const { provider, sent } = setup(envelope({ listing }));
    expect((await provider.generate(generation)).listing).toEqual(listing);
    expect((await sent[0]!.json()).response_format.json_schema.name).toBe(
      "listing_generation",
    );
  });
  it.each([{ country: "Italy" }, { imageAssetIds: ["forged"] }])(
    "rejects altered protected output %#",
    async (change) => {
      const { provider, sent } = setup(
        envelope({ listing: { ...buildSafeListing(generation), ...change } }),
      );
      await expect(provider.generate(generation)).rejects.toBeInstanceOf(
        ProviderOutputError,
      );
      expect(sent).toHaveLength(1);
    },
  );
  it("rejects invalid generation input before fetch", async () => {
    const { provider, sent } = setup();
    await expect(
      provider.generate({ ...generation, evidence: [] }),
    ).rejects.toBeInstanceOf(ProviderOutputError);
    expect(sent).toHaveLength(0);
  });
  it("keeps concurrent usage local", async () => {
    const { provider } = setup(
      envelope(),
      envelope(extraction, {
        usage: { prompt_tokens: 20, completion_tokens: 8, cost: 0.02 },
      }),
    );
    const results = await Promise.all([
      provider.extract(empty),
      provider.extract(empty),
    ]);
    expect(results.map((r) => r.usage.estimatedCostUsd).sort()).toEqual([
      0.001, 0.02,
    ]);
  });
  it("rejects changed response model during repair", async () => {
    const { provider } = setup(
      envelope({}),
      envelope(extraction, { model: "other/model" }),
    );
    await expect(provider.extract(empty)).rejects.toBeInstanceOf(
      ProviderOutputError,
    );
  });
  it("rejects overflow across repair", async () => {
    const huge = {
      prompt_tokens: Number.MAX_SAFE_INTEGER,
      completion_tokens: 0,
      cost: 0,
    };
    const { provider } = setup(envelope({}, { usage: huge }), envelope());
    await expect(provider.extract(empty)).rejects.toBeInstanceOf(
      ProviderOutputError,
    );
  });
  it.each([401, 429, 503])(
    "sanitizes transport %s without SDK retry",
    async (status) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json(
              {
                error: {
                  message: "SECRET https://private.invalid",
                  code: "SECRET",
                },
              },
              { status },
            ),
          );
        const provider = new OpenRouterListingProvider({
          apiKey: "synthetic",
          model: "test/model",
          fetch: fetcher,
        });
        await expect(provider.extract(empty)).rejects.toThrow(
          "AI provider request failed",
        );
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET|private/);
        expect(log).toHaveBeenCalledTimes(1);
      } finally {
        log.mockRestore();
      }
    },
  );
  it("aborts timeout without SDK retry and sanitizes error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        async (_input, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener(
              "abort",
              () => reject(new DOMException("SECRET", "AbortError")),
              { once: true },
            );
          }),
      );
      const provider = new OpenRouterListingProvider({
        apiKey: "synthetic",
        model: "test/model",
        timeoutMs: 1000,
        fetch: fetcher,
      });
      await expect(provider.extract(empty)).rejects.toBeInstanceOf(
        ProviderApiError,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
    } finally {
      log.mockRestore();
    }
  });
});

describe("OpenRouter envelope and diagnostic edge cases", () => {
  it.each([
    null,
    { error: { message: "SECRET" } },
    envelope(extraction, { model: null }),
    envelope(extraction, { model: "unsafe:model" }),
    envelope(extraction, {
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: null },
        },
      ],
    }),
  ])("rejects malformed envelope without repair %#", async (response) => {
    const { provider, sent } = setup(response);
    await expect(provider.extract(empty)).rejects.toBeInstanceOf(
      ProviderOutputError,
    );
    expect(sent).toHaveLength(1);
  });
  it("rejects absent usage on repair without dispatching again", async () => {
    const { provider, sent } = setup(
      envelope({}),
      envelope(extraction, { usage: undefined }),
    );
    await expect(provider.extract(empty)).rejects.toBeInstanceOf(
      ProviderOutputError,
    );
    expect(sent).toHaveLength(2);
  });
  it("rejects cost overflow across repair", async () => {
    const usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      cost: Number.MAX_VALUE,
    };
    const { provider } = setup(
      envelope({}, { usage }),
      envelope(extraction, { usage }),
    );
    await expect(provider.extract(empty)).rejects.toBeInstanceOf(
      ProviderOutputError,
    );
  });
  it("records returned concrete model and measured latency", async () => {
    const times = [100, 137];
    const provider = new OpenRouterListingProvider({
      apiKey: "synthetic",
      model: "test/model",
      now: () => times.shift()!,
      fetch: async () => Response.json(envelope()),
    });
    expect((await provider.extract(empty)).usage).toMatchObject({
      model: "test/vision-model",
      latencyMs: 37,
    });
  });
  it("logs only safe diagnostic fields on repair transport failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(envelope({})))
        .mockResolvedValueOnce(
          Response.json(
            { error: { code: "rate_limit_exceeded", message: "SECRET" } },
            { status: 429 },
          ),
        );
      const provider = new OpenRouterListingProvider({
        apiKey: "synthetic",
        model: "test/model",
        fetch: fetcher,
      });
      await expect(provider.extract(empty)).rejects.toBeInstanceOf(
        ProviderApiError,
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(log.mock.calls).toEqual([
        [
          JSON.stringify({
            event: "listing_provider_failure",
            provider: "openrouter",
            phase: "repair",
            status: 429,
            code: "rate_limit_exceeded",
          }),
        ],
      ]);
    } finally {
      log.mockRestore();
    }
  });
  it("sanitizes network errors without retry", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("SECRET https://private.invalid"));
      const provider = new OpenRouterListingProvider({
        apiKey: "synthetic",
        model: "test/model",
        fetch: fetcher,
      });
      await expect(provider.extract(empty)).rejects.toThrow(
        "AI provider request failed",
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(log.mock.calls).toEqual([
        [
          JSON.stringify({
            event: "listing_provider_failure",
            provider: "openrouter",
            phase: "request",
            status: null,
            code: "unknown",
          }),
        ],
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
