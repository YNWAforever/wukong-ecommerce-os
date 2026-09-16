import { describe, expect, it } from "vitest";
import { OpenCodeGoListingProvider } from "./opencode-go-listing-provider.js";
import type { PhysicalInvocationRecord } from "./listing-provider-errors.js";
const extraction = {
  facts: {
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
  },
  evidence: [],
  missingFields: [],
};
const envelope = (extra: Record<string, unknown> = {}) => ({
  model: "deepseek-v4.1-flash",
  choices: [
    {
      finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify(extraction) },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
  ...extra,
});
function setup(responses: unknown[]) {
  const sent: Request[] = [];
  const events: PhysicalInvocationRecord[] = [];
  const provider = new OpenCodeGoListingProvider({
    apiKey: "synthetic",
    model: "deepseek-v4.1-flash",
    sessionId: "run-123",
    invocationObserver: async (e) => {
      events.push(e);
    },
    fetch: async (input, init) => {
      sent.push(new Request(input, init));
      const result = responses.shift();
      return result instanceof Response ? result : Response.json(result);
    },
  });
  return { provider, sent, events };
}
describe("OpenCode Go listing adapter", () => {
  it("uses the Go endpoint, honest identity, stable session, JSON schema prompt and estimated accounting", async () => {
    const { provider, sent, events } = setup([envelope()]);
    const result = await provider.extract({
      assets: [
        {
          id: "asset",
          mimeType: "image/png",
          readUrl:
            "https://assets.example.test/private.png?signature=synthetic",
        },
      ],
      note: null,
    });
    expect(sent[0]!.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(sent[0]!.headers.get("user-agent")).toBe(
      "WukongEcommerceOS/1.0 (listing-processing)",
    );
    expect(sent[0]!.headers.get("x-opencode-session")).toBe("run-123");
    const body = await sent[0]!.json();
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body).not.toHaveProperty("provider");
    expect(body.messages[1].content).toContainEqual({
      type: "image_url",
      image_url: {
        url: "https://assets.example.test/private.png?signature=synthetic",
      },
    });
    expect(JSON.stringify(body.messages)).toContain("required");
    expect(result.usage.estimatedCostUsd).toBeCloseTo(0.00009, 8);
    expect(events.at(-1)?.usage).toMatchObject({
      certainty: "estimated",
      inputTokens: 100,
      outputTokens: 50,
    });
  });
  it.each([undefined, "other-model"])(
    "fails closed on response model %s without a repair",
    async (model) => {
      const { provider, sent, events } = setup([envelope({ model })]);
      await expect(
        provider.extract({ assets: [], note: null }),
      ).rejects.toThrow(/model identity/);
      expect(sent).toHaveLength(1);
      expect(events.at(-1)?.usage).toMatchObject({
        certainty: "unknown",
        costUsd: null,
      });
    },
  );
  it("retains unknown accounting for missing usage", async () => {
    const { provider, events } = setup([envelope({ usage: undefined })]);
    await expect(provider.extract({ assets: [], note: null })).rejects.toThrow(
      /usage/,
    );
    expect(events.at(-1)?.usage.certainty).toBe("unknown");
  });
  it("does not replay authentication failures", async () => {
    const { provider, sent } = setup([
      Response.json(
        { error: { code: "invalid_api_key", message: "denied" } },
        { status: 401 },
      ),
    ]);
    await expect(
      provider.extract({ assets: [], note: null }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });
  it("bounds malformed JSON repair and keeps one session", async () => {
    const bad = envelope({
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "{}" },
        },
      ],
    });
    const { provider, sent } = setup([bad, envelope()]);
    await provider.extract({ assets: [], note: null });
    expect(sent).toHaveLength(2);
    expect(sent.map((r) => r.headers.get("x-opencode-session"))).toEqual([
      "run-123",
      "run-123",
    ]);
  });
});
