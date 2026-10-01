import { readFile } from "node:fs/promises";
import { contentFields } from "@wukong/core";
import { describe, expect, it, vi } from "vitest";
import {
  boundedResponsesClient,
  freshTransportState,
  createMaintenanceProvider,
} from "./opak-maintenance-live.js";
import {
  adaptAuditFixtures,
  type LiveConfig,
} from "./eval-opak-maintenance.js";
const config: LiveConfig = {
  apiKey: "synthetic",
  model: "synthetic-2026-01-01",
  pricingVersion: "synthetic-v1",
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
  maxInputTokens: 10000,
  maxOutputTokens: 4096,
  maxRequests: 2,
  budgetUsd: 1,
};
const request = {
  model: config.model,
  max_output_tokens: config.maxOutputTokens,
  input: "synthetic",
};
describe("physical request budget fence", () => {
  it("blocks insufficient per-call budget or input bound before transport", async () => {
    const parse = vi.fn(),
      transport = { responses: { parse } };
    for (const input of [
      { ...config, budgetUsd: 0.001 },
      { ...config, maxInputTokens: 10 },
    ]) {
      const state = freshTransportState();
      await expect(
        boundedResponsesClient(input, transport, state).responses.parse(
          request,
        ),
      ).rejects.toThrow();
      expect(state.requests).toBe(0);
    }
    expect(parse).not.toHaveBeenCalled();
  });
  it("counts schema repair as another physical request and disables hidden SDK retries", async () => {
    const parse = vi.fn().mockResolvedValue({
        output_parsed: null,
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
      state = freshTransportState();
    const client = boundedResponsesClient(
      config,
      { responses: { parse } },
      state,
    );
    await client.responses.parse(request, { maxRetries: 5 });
    await client.responses.parse(request);
    await expect(client.responses.parse(request)).rejects.toThrow();
    expect(parse).toHaveBeenCalledTimes(2);
    expect(parse.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 0 });
    expect(state).toMatchObject({
      requests: 2,
      costUsd: 0.00024,
      stopReason: "request_cap",
      unknownCost: false,
    });
  });
  it("does not perform schema repair after unknown usage or assume API errors are free", async () => {
    for (const parse of [
      vi.fn().mockResolvedValue({ output_parsed: null }),
      vi.fn().mockRejectedValue(new Error("private provider content")),
    ]) {
      const state = freshTransportState(),
        client = boundedResponsesClient(
          config,
          { responses: { parse } },
          state,
        );
      try {
        await client.responses.parse(request);
      } catch {
        /* API attempt remains uncertain. */
      }
      await expect(client.responses.parse(request)).rejects.toThrow();
      expect(parse).toHaveBeenCalledTimes(1);
      expect(state.unknownCost).toBe(true);
      expect(state.requests).toBe(1);
    }
  });
  it("halts before repair after response token bounds are exceeded", async () => {
    const parse = vi.fn().mockResolvedValue({
        output_parsed: null,
        usage: { input_tokens: 10001, output_tokens: 10 },
      }),
      state = freshTransportState();
    const client = boundedResponsesClient(
      config,
      { responses: { parse } },
      state,
    );
    await client.responses.parse(request);
    await expect(client.responses.parse(request)).rejects.toThrow();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(state.stopReason).toBe("input_bound");
    expect(state.unknownCost).toBe(false);
  });
});

describe("existing provider adapter with fake transport", () => {
  const item = async () =>
    adaptAuditFixtures(
      JSON.parse(
        await readFile(
          new URL("../fixtures/opak-maintenance-v1.json", import.meta.url),
          "utf8",
        ),
      ),
    ).cases[0]!;
  it("blocks actual provider repair on unknown usage without treating it as zero", async () => {
    const parse = vi.fn().mockResolvedValue({ output_parsed: null });
    const provider = await createMaintenanceProvider(
      { ...config, maxInputTokens: 100000 },
      { transport: { responses: { parse } } },
    );
    const result = await provider.evaluate(await item());
    expect(parse).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      providerRequests: 1,
      costUsd: null,
      costCertainty: "unknown",
      failure: "unknown_cost",
    });
  });
  it("never sends expected answers and projects actual generated copy onto the authoritative eight fields", async () => {
    const target = await item();
    target.expectedFacts.producer = "EXPECTED-GOLD-SENTINEL";
    target.sources = [
      { id: "AI01:label", digest: "synthetic", text: "Synthetic Estate" },
    ];
    const facts = {
      sku: null,
      producer: "Synthetic Estate",
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
    const localized = { en: "Synthetic Estate", "zh-Hant": "Synthetic Estate" };
    const parse = vi
      .fn()
      .mockResolvedValueOnce({
        output_parsed: {
          facts,
          evidence: [
            {
              field: "producer",
              sourceAssetId: "note",
              page: null,
              excerpt: "Synthetic Estate",
              confidence: 1,
            },
          ],
          missingFields: [],
        },
        usage: { input_tokens: 100, output_tokens: 10 },
      })
      .mockResolvedValueOnce({
        output_parsed: {
          listing: {
            ...facts,
            title: localized,
            description: localized,
            seo: { title: localized, description: localized },
            tags: [],
            imageAssetIds: [],
          },
        },
        usage: { input_tokens: 100, output_tokens: 10 },
      });
    const provider = await createMaintenanceProvider(
      { ...config, maxInputTokens: 100000 },
      { transport: { responses: { parse } } },
    );
    const result = await provider.evaluate(target);
    expect(result.failure).toBeUndefined();
    expect(result.providerRequests).toBe(2);
    expect(Object.keys(result.candidate!.patch).sort()).toEqual(
      [...contentFields].sort(),
    );
    expect(result.candidate?.facts.producer).toBe("Synthetic Estate");
    expect(JSON.stringify(parse.mock.calls)).not.toContain(
      "EXPECTED-GOLD-SENTINEL",
    );
    expect(result.costUsd).toBeCloseTo(0.00024);
    expect(result.costCertainty).toBe("estimated");
  });
});
