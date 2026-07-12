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

const evidence = [
  { field: "producer", sourceAssetId: "note", page: null, excerpt: "Demo Estate", confidence: 1 },
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

function fakeClient(...responses: unknown[]) {
  const parse = vi.fn();
  for (const response of responses) parse.mockResolvedValueOnce(response);
  return { client: { responses: { parse } }, parse };
}

describe("OpenAIListingProvider", () => {
  it("uses Responses structured parsing, multimodal HTTPS inputs, configured model, and deterministic telemetry", async () => {
    const { client, parse } = fakeClient({
      output_parsed: extractionFixture,
      usage: { input_tokens: 100, output_tokens: 50 },
      output: [],
    });
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
      note: "Demo Estate",
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

  it.each([
    ["unsupported MIME", { id: "asset", mimeType: "text/plain", readUrl: "https://assets.example/a.txt" }],
    ["non-HTTPS URL", { id: "asset", mimeType: "image/png", readUrl: "http://assets.example/a.png" }],
    ["local URL", { id: "asset", mimeType: "application/pdf", readUrl: "file:///secret.pdf" }],
  ])("rejects %s before an API request", async (_label, asset) => {
    const { client, parse } = fakeClient();
    const provider = new OpenAIListingProvider(client);
    await expect(provider.extract({ assets: [asset], note: null })).rejects.toBeInstanceOf(UnsupportedAssetError);
    expect(parse).not.toHaveBeenCalled();
  });

  it("applies the documented long-context pricing multipliers deterministically", async () => {
    const { client } = fakeClient({
      output_parsed: extractionFixture,
      usage: { input_tokens: 300_000, output_tokens: 100_000 },
      output: [],
    });
    const result = await new OpenAIListingProvider(client).extract({ assets: [], note: "Demo Estate" });
    expect(result.usage.estimatedCostUsd).toBe(3.75);
  });

  it("rejects invented evidence references and note excerpts", async () => {
    const { client } = fakeClient({
      output_parsed: {
        ...extractionFixture,
        evidence: [{ ...evidence[0], sourceAssetId: "asset_unknown", excerpt: "invented" }],
      },
      output: [],
    });
    const provider = new OpenAIListingProvider(client);
    await expect(provider.extract({ assets: [], note: "Demo Estate" })).rejects.toBeInstanceOf(ProviderOutputError);
  });

  it("derives missing fields from validated nullable facts instead of trusting the model list", async () => {
    const { client } = fakeClient({
      output_parsed: {
        ...extractionFixture,
        facts: { ...facts, priceHkd: null },
        missingFields: [],
      },
      output: [],
    });
    const result = await new OpenAIListingProvider(client).extract({ assets: [], note: "Demo Estate" });
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
      { output_parsed: extractionFixture, usage: {}, output: [] },
    );
    const provider = new OpenAIListingProvider(client);
    await expect(provider.extract({ assets: [], note: "Demo Estate" })).resolves.toMatchObject({ facts });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(parse.mock.calls[1]?.[0])).toContain("repair");
  });

  it("returns a typed output error after the single repair is exhausted", async () => {
    const { client, parse } = fakeClient(
      { output_parsed: null, output: [] },
      { output_parsed: null, output: [] },
    );
    const provider = new OpenAIListingProvider(client);
    await expect(provider.extract({ assets: [], note: null })).rejects.toBeInstanceOf(ProviderOutputError);
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
    const provider = new OpenAIListingProvider({ responses: { parse } });
    const error = await provider.extract({ assets: [], note: null }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(String(error)).not.toContain("secret-token");
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("generates a runtime-validated bilingual listing grounded in supplied facts and image IDs", async () => {
    const { client, parse } = fakeClient({ output_parsed: { listing: listingFixture }, usage: undefined, output: [] });
    const provider = new OpenAIListingProvider(client, { model: "gpt-5.6-terra" });
    const result = await provider.generate({
      facts,
      evidence,
      profile: {
        name: "Opak Cellar",
        currency: "HKD",
        locales: ["en", "zh-Hant"],
        tone: "clear and restrained",
        claimPolicy: ["No invented claims"],
        requiredFields: ["sku", "producer"],
      },
      imageAssetIds: ["asset_image"],
    });

    expect(parse).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(parse.mock.calls[0]?.[0])).toContain("listing-generation@1.0.0");
    expect(result.listing).toEqual(listingFixture);
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.estimatedCostUsd).toBe(0);
  });

  it("rejects generated protected facts or image IDs not present in the input", async () => {
    const { client } = fakeClient({
      output_parsed: { listing: { ...listingFixture, priceHkd: 999, imageAssetIds: ["asset_unknown"] } },
      output: [],
    });
    const provider = new OpenAIListingProvider(client);
    await expect(provider.generate({
      facts,
      evidence,
      profile: {
        name: "Opak Cellar", currency: "HKD", locales: ["en", "zh-Hant"], tone: "plain", claimPolicy: [], requiredFields: [],
      },
      imageAssetIds: ["asset_image"],
    })).rejects.toBeInstanceOf(ProviderOutputError);
  });
});
