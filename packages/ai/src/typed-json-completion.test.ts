import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as api from "./index.js";
import type { PhysicalInvocationRecord } from "./listing-provider-errors.js";

const schema = z.object({ value: z.string() }).strict();
const envelope = (content = '{"value":"grounded"}', extra = {}) => ({
  model: "deepseek-v4.1-flash",
  usage: { prompt_tokens: 100, completion_tokens: 50 },
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
  ...extra,
});
function setup(
  responses: unknown[],
  backend: "opencode-go" | "openrouter" = "opencode-go",
  rejectStart = false,
) {
  const requests: Request[] = [];
  const events: PhysicalInvocationRecord[] = [];
  const client = new api.TypedJsonCompletionClient({
    backend,
    apiKey: "synthetic",
    sessionId: "immutable-run",
    model: backend === "opencode-go" ? "deepseek-v4.1-flash" : "vendor/model",
    invocationObserver: async (event) => {
      events.push(event);
      if (rejectStart && event.outcome === "started")
        throw new Error("admission denied");
    },
    fetch: async (input, init) => {
      expect(events.at(-1)?.outcome).toBe("started");
      requests.push(new Request(input, init));
      return Response.json(responses.shift());
    },
  });
  const complete = () =>
    client.complete(
      [{ role: "system", content: "test-role@1.0.0" }],
      schema,
      "test_output",
      "test-role@1.0.0",
      () => {},
    );
  return { client, complete, requests, events };
}
describe("reusable typed JSON completion", () => {
  it("exports an independent typed completion client", () => {
    expect(api).toHaveProperty(
      "TypedJsonCompletionClient",
      expect.any(Function),
    );
  });
  it("preserves Go transport, schema, stable session and usage", async () => {
    const { complete, requests, events } = setup([envelope()]);
    const result = await complete();
    expect(result.parsed).toEqual({ value: "grounded" });
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      model: "deepseek-v4.1-flash",
      promptVersion: "test-role@1.0.0",
    });
    expect(result.usage.estimatedCostUsd).toBeCloseTo(0.00009);
    expect(requests[0]!.url).toBe(
      "https://opencode.ai/zen/go/v1/chat/completions",
    );
    expect(requests[0]!.headers.get("x-opencode-session")).toBe(
      "immutable-run",
    );
    const body = await requests[0]!.json();
    expect(body).toMatchObject({
      model: "deepseek-v4.1-flash",
      max_tokens: 4096,
      response_format: { type: "json_object" },
    });
    expect(body).not.toHaveProperty("provider");
    expect(JSON.stringify(body.messages)).toContain("test-role@1.0.0");
    expect(JSON.stringify(body.messages)).toContain("required");
    expect(events.map((e) => e.outcome)).toEqual(["started", "response"]);
  });
  it("preserves OpenRouter strict schema and measured cost", async () => {
    const { complete, requests, events } = setup(
      [
        envelope(undefined, {
          model: "vendor/model",
          usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.01 },
        }),
      ],
      "openrouter",
    );
    expect((await complete()).usage.estimatedCostUsd).toBe(0.01);
    const body = await requests[0]!.json();
    expect(requests[0]!.url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(body).toMatchObject({
      response_format: { type: "json_schema" },
      provider: { require_parameters: true },
    });
    expect(events.at(-1)?.usage.certainty).toBe("measured");
  });
  it("records each bounded repair separately with accumulated usage", async () => {
    const { complete, requests, events } = setup([envelope("{"), envelope()]);
    expect((await complete()).usage.inputTokens).toBe(200);
    expect(events.map((e) => [e.ordinal, e.phase, e.outcome])).toEqual([
      [1, "request", "started"],
      [1, "request", "invalid_output"],
      [2, "repair", "started"],
      [2, "repair", "response"],
    ]);
    expect(requests.map((r) => r.headers.get("x-opencode-session"))).toEqual([
      "immutable-run",
      "immutable-run",
    ]);
  });
  it("stops after one unsuccessful schema repair", async () => {
    const { complete, requests } = setup([
      envelope("{}"),
      envelope("{}"),
      envelope(),
    ]);
    await expect(complete()).rejects.toThrow(/bounded repair/);
    expect(requests).toHaveLength(2);
  });
  it.each([
    [envelope(undefined, { model: "other-model" }), /model identity/],
    [envelope(undefined, { usage: undefined }), /usage/],
    [
      envelope(undefined, {
        choices: [
          {
            finish_reason: "length",
            message: { role: "assistant", content: "{" },
          },
        ],
      }),
      /incomplete/,
    ],
    [
      envelope(undefined, {
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "", refusal: "no" },
          },
        ],
      }),
      /refused/,
    ],
  ])("never repairs terminal integrity failures", async (response, error) => {
    const { complete, requests } = setup([response, envelope()]);
    await expect(complete()).rejects.toThrow(error as RegExp);
    expect(requests).toHaveLength(1);
  });
  it("does not perform I/O when durable admission fails", async () => {
    const { complete, requests } = setup([envelope()], "opencode-go", true);
    await expect(complete()).rejects.toThrow("admission denied");
    expect(requests).toHaveLength(0);
  });
  it("treats semantic validation rejection as terminal", async () => {
    const { client, requests, events } = setup([envelope(), envelope()]);
    await expect(
      client.complete([], schema, "test_output", "test@1", () => {
        throw new Error("unknown evidence ID");
      }),
    ).rejects.toThrow("unknown evidence ID");
    expect(requests).toHaveLength(1);
    expect(events.at(-1)?.outcome).toBe("invalid_output");
  });
});
