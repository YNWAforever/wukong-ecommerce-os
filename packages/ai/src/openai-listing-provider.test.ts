import { describe, expect, it, vi } from "vitest";

import {
  OpenAIListingProvider,
  ProviderApiError,
  ProviderOutputError,
  ProviderRefusalError,
  UnsupportedAssetError,
} from "./openai-listing-provider.js";

const facts = {
  sku: "OPAK-DEMO-001",
  producer: "Demo Estate",
  productType: "wine" as const,
  country: "Germany",
  region: "Mosel",
  vintage: 2024,
  grapeVarieties: ["Riesling"],
  volumeMl: 750,
  abvPercent: 12.5,
  packQuantity: 1,
  priceHkd: 288,
  stockQuantity: null,
  criticScores: [],
  awards: [],
};

const groundingNote = "SKU OPAK-DEMO-001; producer Demo Estate; product type wine; country Germany; region Mosel; vintage 2024; grapes Riesling; volume 750 ml; ABV 12.5%; pack quantity 1; price HK$288.";

const evidence = [
  { field: "sku", sourceAssetId: "note", page: null, excerpt: "OPAK-DEMO-001", confidence: 1 },
  { field: "producer", sourceAssetId: "note", page: null, excerpt: "Demo Estate", confidence: 1 },
  { field: "productType", sourceAssetId: "note", page: null, excerpt: "wine", confidence: 1 },
  { field: "country", sourceAssetId: "note", page: null, excerpt: "Germany", confidence: 1 },
  { field: "region", sourceAssetId: "note", page: null, excerpt: "Mosel", confidence: 1 },
  { field: "vintage", sourceAssetId: "note", page: null, excerpt: "2024", confidence: 1 },
  { field: "grapeVarieties", sourceAssetId: "note", page: null, excerpt: "Riesling", confidence: 1 },
  { field: "volumeMl", sourceAssetId: "note", page: null, excerpt: "750 ml", confidence: 1 },
  { field: "abvPercent", sourceAssetId: "note", page: null, excerpt: "12.5%", confidence: 1 },
  { field: "packQuantity", sourceAssetId: "note", page: null, excerpt: "quantity 1", confidence: 1 },
  { field: "priceHkd", sourceAssetId: "note", page: null, excerpt: "HK$288", confidence: 1 },
];

const extractionFixture = { facts, evidence, missingFields: ["stockQuantity"] };

const listingFixture = {
  ...facts,
  title: { en: "Demo Estate Riesling 2024", "zh-Hant": "Demo Estate Riesling 2024" },
  description: { en: "A Mosel Riesling.", "zh-Hant": "Mosel Riesling。" },
  seo: {
    title: { en: "Demo Estate Riesling 2024", "zh-Hant": "Demo Estate Riesling 2024" },
    description: { en: "A Mosel Riesling.", "zh-Hant": "Mosel Riesling。" },
  },
  tags: ["Riesling", "Mosel"],
  imageAssetIds: ["asset_image"],
};

const profile = {
  name: "Opak Cellar",
  currency: "HKD" as const,
  locales: ["en", "zh-Hant"] as const,
  tone: "clear and restrained",
  claimPolicy: ["No invented claims"],
  requiredFields: ["sku", "producer"],
};

function fakeClient(...responses: unknown[]) {
  const parse = vi.fn();
  for (const response of responses) parse.mockResolvedValueOnce(response);
  return { client: { responses: { parse } }, parse };
}

function extractionResponse(overrides: Record<string, unknown> = {}) {
  return { output_parsed: extractionFixture, usage: {}, output: [], ...overrides };
}

describe("OpenAIListingProvider", () => {
  it("uses Responses structured parsing, multimodal HTTPS inputs, configured model, and deterministic telemetry", async () => {
    const { client, parse } = fakeClient(extractionResponse({
      usage: { input_tokens: 100, output_tokens: 50 },
    }));
    const provider = new OpenAIListingProvider(client, {
      model: "gpt-5.6-terra",
      now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125),
      pricing: { inputUsdPerMillion: 2.5, outputUsdPerMillion: 15 },
    });

    const result = await provider.extract({
      assets: [
        { id: "asset_image", mimeType: "image/png", readUrl: "https://assets.example/image.png" },
        { id: "asset_pdf", mimeType: "application/pdf", readUrl: "https://assets.example/sheet.pdf" },
      ],
      note: groundingNote,
    });

    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.6-terra",
      reasoning: { effort: "low" },
      text: { format: expect.any(Object) },
    }));
    const request = parse.mock.calls[0]?.[0] as { input: Array<{ content: unknown }> };
    expect(JSON.stringify(request.input)).toContain('"type":"input_image"');
    expect(JSON.stringify(request.input)).toContain('"type":"input_file"');
    expect(JSON.stringify(request.input)).toContain("listing-extraction@1.0.0");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: 0.001,
      latencyMs: 25,
      model: "gpt-5.6-terra",
      promptVersion: "1.0.0",
    });
  });

  it("uses the environment model by default and explicit config takes precedence", async () => {
    const previous = process.env.OPENAI_LISTING_MODEL;
    process.env.OPENAI_LISTING_MODEL = "gpt-5.6-luna";
    try {
      const fromEnv = fakeClient(extractionResponse());
      await new OpenAIListingProvider(fromEnv.client).extract({ assets: [], note: groundingNote });
      expect(fromEnv.parse).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.6-luna" }));

      const explicit = fakeClient(extractionResponse());
      await new OpenAIListingProvider(explicit.client, { model: "gpt-5.6-terra" })
        .extract({ assets: [], note: groundingNote });
      expect(explicit.parse).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.6-terra" }));
    } finally {
      if (previous === undefined) delete process.env.OPENAI_LISTING_MODEL;
      else process.env.OPENAI_LISTING_MODEL = previous;
    }
  });

  it.each(["", " unsafe model ", "../model", "model?secret=1"])("rejects unsafe model config %j", (model) => {
    expect(() => new OpenAIListingProvider(undefined, { model })).toThrow(/model/i);
  });

  it.each([42, true, null, ["gpt-5.6-terra"], { toString: () => "gpt-5.6-terra" }])("rejects non-string model config %j", (model) => {
    expect(() => new OpenAIListingProvider(undefined, { model: model as never })).toThrow(/model/i);
  });

  it.each([
    ["unsupported MIME", { id: "asset", mimeType: "text/plain", readUrl: "https://assets.example/a.txt" }],
    ["non-HTTPS URL", { id: "asset", mimeType: "image/png", readUrl: "http://assets.example/a.png" }],
    ["local URL", { id: "asset", mimeType: "application/pdf", readUrl: "file:///secret.pdf" }],
  ])("rejects %s before an API request", async (_label, asset) => {
    const { client, parse } = fakeClient();
    await expect(new OpenAIListingProvider(client).extract({ assets: [asset], note: null }))
      .rejects.toBeInstanceOf(UnsupportedAssetError);
    expect(parse).not.toHaveBeenCalled();
  });

  it("applies the documented long-context pricing multipliers deterministically", async () => {
    const { client } = fakeClient(extractionResponse({
      usage: { input_tokens: 300_000, output_tokens: 100_000 },
    }));
    const result = await new OpenAIListingProvider(client).extract({ assets: [], note: groundingNote });
    expect(result.usage.estimatedCostUsd).toBe(3.75);
  });

  it.each([
    { inputUsdPerMillion: -1, outputUsdPerMillion: 15 },
    { inputUsdPerMillion: 2.5, outputUsdPerMillion: Number.NaN },
    { inputUsdPerMillion: 2.5, outputUsdPerMillion: 15, longContextThresholdTokens: -1 },
    { inputUsdPerMillion: 2.5, outputUsdPerMillion: 15, longContextThresholdTokens: Number.NaN },
    { inputUsdPerMillion: 2.5, outputUsdPerMillion: 15, longContextInputMultiplier: -1 },
    { inputUsdPerMillion: 2.5, outputUsdPerMillion: 15, longContextOutputMultiplier: Number.NaN },
  ])("rejects invalid pricing config %#", (pricing) => {
    expect(() => new OpenAIListingProvider(undefined, { pricing })).toThrow(/pricing/i);
  });

  it.each([
    [Number.NaN, 100],
    [100, Number.NaN],
    [100, 50],
  ])("keeps latency finite and non-negative for clocks %s -> %s", async (start, end) => {
    const { client } = fakeClient(extractionResponse());
    const result = await new OpenAIListingProvider(client, {
      now: vi.fn().mockReturnValueOnce(start).mockReturnValueOnce(end),
    }).extract({ assets: [], note: groundingNote });
    expect(result.usage.latencyMs).toBe(0);
    expect(Number.isFinite(result.usage.latencyMs)).toBe(true);
    expect(Number.isFinite(result.usage.estimatedCostUsd)).toBe(true);
  });

  it("rejects extracted facts with empty or irrelevant evidence", async () => {
    const empty = fakeClient(extractionResponse({
      output_parsed: { ...extractionFixture, evidence: [] },
    }));
    await expect(new OpenAIListingProvider(empty.client).extract({ assets: [], note: groundingNote }))
      .rejects.toBeInstanceOf(ProviderOutputError);

    const irrelevant = fakeClient(extractionResponse({
      output_parsed: {
        ...extractionFixture,
        evidence: evidence.map((item) => item.field === "producer" ? { ...item, excerpt: "Germany" } : item),
      },
    }));
    await expect(new OpenAIListingProvider(irrelevant.client).extract({ assets: [], note: groundingNote }))
      .rejects.toBeInstanceOf(ProviderOutputError);
  });

  it("allows the schema-default pack quantity without source evidence", async () => {
    const { client } = fakeClient(extractionResponse({
      output_parsed: {
        ...extractionFixture,
        evidence: evidence.filter((item) => item.field !== "packQuantity"),
      },
    }));

    await expect(new OpenAIListingProvider(client).extract({ assets: [], note: groundingNote }))
      .resolves.toMatchObject({ facts: expect.objectContaining({ packQuantity: 1 }) });
  });

  it("rejects a non-default pack quantity without value-consistent evidence", async () => {
    const { client } = fakeClient(extractionResponse({
      output_parsed: {
        ...extractionFixture,
        facts: { ...facts, packQuantity: 6 },
        evidence: evidence.filter((item) => item.field !== "packQuantity"),
      },
    }));

    await expect(new OpenAIListingProvider(client).extract({ assets: [], note: groundingNote }))
      .rejects.toBeInstanceOf(ProviderOutputError);
  });

  it("still requires evidence for every other non-null fact", async () => {
    const { client } = fakeClient(extractionResponse({
      output_parsed: {
        ...extractionFixture,
        evidence: evidence.filter((item) => item.field !== "producer" && item.field !== "packQuantity"),
      },
    }));

    await expect(new OpenAIListingProvider(client).extract({ assets: [], note: groundingNote }))
      .rejects.toBeInstanceOf(ProviderOutputError);
  });
  it("rejects substring evidence collisions while accepting exact multiword, numeric, and source claims", async () => {
    const collisions = [
      {
        note: `${groundingNote} product classification winery.`,
        facts: { ...facts },
        evidence: evidence.map((item) => item.field === "productType" ? { ...item, excerpt: "winery" } : item),
      },
      {
        note: `${groundingNote} origin Malian.`,
        facts: { ...facts, country: "Mali" },
        evidence: evidence.map((item) => item.field === "country" ? { ...item, excerpt: "Malian" } : item),
      },
      {
        note: `${groundingNote} golden award.`,
        facts: { ...facts, awards: [{ name: "Gold", evidenceId: "note" }] },
        evidence: [...evidence, { field: "awards", sourceAssetId: "note", page: null, excerpt: "golden award", confidence: 1 }],
      },
    ];

    for (const collision of collisions) {
      const { client } = fakeClient(extractionResponse({
        output_parsed: { facts: collision.facts, evidence: collision.evidence, missingFields: ["stockQuantity"] },
      }));
      await expect(new OpenAIListingProvider(client).extract({ assets: [], note: collision.note }))
        .rejects.toBeInstanceOf(ProviderOutputError);
    }

    const positiveNote = `${groundingNote} critic Wine Advocate 95; award Gold Medal.`;
    const { client } = fakeClient(extractionResponse({
      output_parsed: {
        facts: {
          ...facts,
          criticScores: [{ source: "Wine Advocate", score: "95", evidenceId: "note" }],
          awards: [{ name: "Gold Medal", evidenceId: "note" }],
        },
        evidence: [
          ...evidence,
          { field: "criticScores", sourceAssetId: "note", page: null, excerpt: "Wine Advocate 95", confidence: 1 },
          { field: "awards", sourceAssetId: "note", page: null, excerpt: "Gold Medal", confidence: 1 },
        ],
        missingFields: ["stockQuantity"],
      },
    }));
    await expect(new OpenAIListingProvider(client).extract({ assets: [], note: positiveNote }))
      .resolves.toMatchObject({ facts: expect.objectContaining({ volumeMl: 750 }) });
  });
  it("rejects invented evidence references, unbounded excerpts, and non-verbatim note excerpts", async () => {
    for (const badEvidence of [
      [{ ...evidence[0], sourceAssetId: "asset_unknown" }, ...evidence.slice(1)],
      [{ ...evidence[0], excerpt: "x".repeat(501) }, ...evidence.slice(1)],
      [{ ...evidence[0], excerpt: "invented SKU" }, ...evidence.slice(1)],
    ]) {
      const { client } = fakeClient(extractionResponse({
        output_parsed: { ...extractionFixture, evidence: badEvidence },
      }));
      await expect(new OpenAIListingProvider(client).extract({ assets: [], note: groundingNote }))
        .rejects.toBeInstanceOf(ProviderOutputError);
    }
  });

  it("derives missing fields from validated nullable facts instead of trusting the model list", async () => {
    const { client } = fakeClient(extractionResponse({
      output_parsed: {
        ...extractionFixture,
        facts: { ...facts, priceHkd: null },
        evidence: evidence.filter((item) => item.field !== "priceHkd"),
        missingFields: [],
      },
    }));
    const result = await new OpenAIListingProvider(client).extract({ assets: [], note: groundingNote });
    expect(result.missingFields).toEqual(expect.arrayContaining(["priceHkd", "stockQuantity"]));
  });

  it("does not construct the default client until the first provider call", () => {
    const clientFactory = vi.fn();
    expect(() => new OpenAIListingProvider(undefined, { clientFactory })).not.toThrow();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("performs exactly one repair request only for absent parsed output", async () => {
    const { client, parse } = fakeClient(
      { output_parsed: null, usage: {}, output: [] },
      extractionResponse(),
    );
    await expect(new OpenAIListingProvider(client).extract({ assets: [], note: groundingNote }))
      .resolves.toMatchObject({ facts });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(parse.mock.calls[1]?.[0])).toContain("repair");
  });

  it("returns a typed output error after the single repair is exhausted", async () => {
    const { client, parse } = fakeClient(
      { output_parsed: null, output: [] },
      { output_parsed: null, output: [] },
    );
    await expect(new OpenAIListingProvider(client).extract({ assets: [], note: null }))
      .rejects.toBeInstanceOf(ProviderOutputError);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("does not repair refusals or arbitrary API failures and does not leak provider messages", async () => {
    const refusal = fakeClient({
      output_parsed: null,
      output: [{ type: "message", content: [{ type: "refusal", refusal: "private policy detail" }] }],
    });
    await expect(new OpenAIListingProvider(refusal.client).extract({ assets: [], note: null }))
      .rejects.toBeInstanceOf(ProviderRefusalError);
    expect(refusal.parse).toHaveBeenCalledTimes(1);

    const parse = vi.fn().mockRejectedValue(new Error("secret-token-sk-test"));
    const error = await new OpenAIListingProvider({ responses: { parse } })
      .extract({ assets: [], note: null }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(String(error)).not.toContain("secret-token");
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("returns deterministic bilingual claim-safe copy instead of arbitrary model prose", async () => {
    const adversarialListing = {
      ...listingFixture,
      title: { en: "Best award-winning 99-point wine", "zh-Hant": "最佳得獎99分葡萄酒" },
      description: {
        en: "Gold medal winner from France with cherry tasting notes and unmatched quality.",
        "zh-Hant": "法國金獎，櫻桃味，品質無雙。",
      },
      seo: {
        title: { en: "World's best wine", "zh-Hant": "世界最佳葡萄酒" },
        description: { en: "Critic score 99", "zh-Hant": "酒評家99分" },
      },
      tags: ["award-winning", "99-points", "France", "cherry", "best"],
    };
    const { client, parse } = fakeClient({ output_parsed: { listing: adversarialListing }, usage: undefined, output: [] });
    const result = await new OpenAIListingProvider(client, { model: "gpt-5.6-terra" }).generate({
      facts, evidence, profile, imageAssetIds: ["asset_image"],
    });

    expect(parse).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(parse.mock.calls[0]?.[0])).toContain("listing-generation@1.0.0");
    expect(result.listing.title.en).toBe("Demo Estate 2024");
    expect(result.listing.title["zh-Hant"]).toBeTruthy();
    const safeCopy = JSON.stringify({
      title: result.listing.title,
      description: result.listing.description,
      seo: result.listing.seo,
      tags: result.listing.tags,
    }).toLocaleLowerCase();
    for (const unsupported of ["award", "99-point", "gold medal", "france", "cherry", "best", "最佳", "金獎", "櫻桃", "無雙"]) {
      expect(safeCopy).not.toContain(unsupported);
    }
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.estimatedCostUsd).toBe(0);
  });

  it("rejects generated protected facts, image IDs, or unsupported input evidence", async () => {
    const changed = fakeClient({
      output_parsed: { listing: { ...listingFixture, priceHkd: 999, imageAssetIds: ["asset_unknown"] } },
      output: [],
    });
    await expect(new OpenAIListingProvider(changed.client).generate({
      facts, evidence, profile, imageAssetIds: ["asset_image"],
    })).rejects.toBeInstanceOf(ProviderOutputError);

    const unsupported = fakeClient({ output_parsed: { listing: listingFixture }, output: [] });
    await expect(new OpenAIListingProvider(unsupported.client).generate({
      facts,
      evidence: evidence.filter((item) => item.field !== "country"),
      profile,
      imageAssetIds: ["asset_image"],
    })).rejects.toBeInstanceOf(ProviderOutputError);
  });
});