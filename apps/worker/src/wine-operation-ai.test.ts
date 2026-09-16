import { describe, expect, it, vi } from "vitest";
import { WINE_EXECUTION_SNAPSHOT } from "@wukong/ai";
import {
  createWineBudgetSnapshot,
  wineEnrichmentPolicySchema,
} from "@wukong/core";
import { operationAI, operationAIForFlow } from "./operation-ai.js";

export function acceptedRun(): any {
  return {
    id: "run",
    listingId: "draft",
    inputRevision: 1,
    acceptedAt: new Date().toISOString(),
    execution: {
      schemaVersion: 1,
      flowVersion: "wine-enrichment-v1",
      wineMode: "copy",
      wineGo: structuredClone(WINE_EXECUTION_SNAPSHOT),
      wineBudget: createWineBudgetSnapshot("copy"),
      wineEnrichment: wineEnrichmentPolicySchema.parse({
        enabled: true,
        allowedDomains: ["wine.test"],
      }),
      wineAcquisition: {
        schemaVersion: 1,
        deadlineAt: new Date(Date.now() + 800000).toISOString(),
        policyVersion: "wine-enrichment@1",
        rulesVersion: "wine-grounding@1",
        allowedDomains: ["wine.test"],
      },
    },
  };
}
export function generationRequest(
  workspaceId = "w",
  operationId = "run",
  inputRevision = 1,
): any {
  return {
    schemaVersion: 1,
    binding: { workspaceId, operationId, inputRevision },
    claims: [],
    current: null,
    lockedPaths: [],
    tone: "neutral",
    claimPolicy: [],
    section: null,
  };
}
export function emptyCandidate(): any {
  return {
    schemaVersion: 1,
    content: {
      title: { en: "", "zh-Hant": "" },
      sections: [],
      seo: {
        title: { en: "", "zh-Hant": "" },
        description: { en: "", "zh-Hant": "" },
      },
      tags: [],
    },
    annotations: [],
  };
}
export function response(
  content: any = emptyCandidate(),
  overrides = {},
): Response {
  return Response.json({
    model: "deepseek-v4.1-flash",
    usage: { prompt_tokens: 100, completion_tokens: 50 },
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(content) },
      },
    ],
    ...overrides,
  });
}
function setup(run = acceptedRun(), admit = async () => ({ claimed: true })) {
  const finish = vi.fn(async (_coordinates: any, _completion: any) => true),
    fetch = vi.fn(async () => response());
  const db = {
    forWorkspace: async (_w: string, f: any) =>
      f({ wineGoInvocations: { admit, finish } }),
  };
  const env = {
    OPENCODE_GO_API_KEY: "synthetic",
    AI_PROVIDER: "fake",
    LISTING_PAID_OPERATIONS_ENABLED: "false",
  };
  const create = () =>
    operationAIForFlow(db as never, env as never, "w", run, { fetch });
  return { create, fetch, finish, db, env, run };
}
describe("stored wine flow factory", () => {
  it("dispatches accepted wine before legacy guards and drains after flags disable", async () => {
    const s = setup(),
      selected = s.create();
    expect(selected.flowVersion).toBe("wine-enrichment-v1");
    if (selected.flowVersion !== "wine-enrichment-v1")
      throw new Error("wine expected");
    await selected.provider.generate(generationRequest());
    expect(s.finish).toHaveBeenCalledWith(
      { workspaceId: "w", runId: "run", inputRevision: 1 },
      expect.objectContaining({
        stage: "generation",
        callOrdinal: 1,
        status: "succeeded",
        estimatedCostUsd: "0.000090",
      }),
    );
    expect(() =>
      operationAI(s.db as never, s.env as never, "w", s.run),
    ).toThrow(/wine.*dispatch/i);
  });
  it("awaits committed admission before HTTP and freezes run/request binding", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup(acceptedRun(), async () => {
      await gate;
      return { claimed: true };
    });
    const selected = s.create();
    if (selected.flowVersion !== "wine-enrichment-v1") throw Error();
    const request = generationRequest();
    const pending = selected.provider.generate(request);
    s.run.id = "changed";
    request.binding.operationId = "changed";
    await Promise.resolve();
    expect(s.fetch).not.toHaveBeenCalled();
    release();
    await pending;
    expect(s.finish.mock.calls[0]?.[0]).toEqual({
      workspaceId: "w",
      runId: "run",
      inputRevision: 1,
    });
  });
  it("rejects foreign copy and check bindings without admission or HTTP", async () => {
    const admit = vi.fn(async () => ({ claimed: true })),
      s = setup(acceptedRun(), admit);
    const selected = s.create();
    if (selected.flowVersion !== "wine-enrichment-v1") throw Error();
    await expect(
      selected.provider.generate(generationRequest("other")),
    ).rejects.toThrow(/binding/);
    await expect(
      selected.provider.check({
        request: generationRequest("w", "other"),
        candidate: emptyCandidate(),
      }),
    ).rejects.toThrow(/binding/);
    expect(admit).not.toHaveBeenCalled();
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it("denied durable admission is terminal", async () => {
    const s = setup(acceptedRun(), async () => ({ claimed: false }));
    const selected = s.create();
    if (selected.flowVersion !== "wine-enrichment-v1") throw Error();
    await expect(
      selected.provider.generate(generationRequest()),
    ).rejects.toThrow(/admission/);
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it("a failed terminal commit never launches a schema repair", async () => {
    const s = setup();
    s.fetch.mockImplementation(async () => response({}));
    s.finish.mockResolvedValue(false);
    const selected = s.create();
    if (selected.flowVersion !== "wine-enrichment-v1") throw Error();
    await expect(
      selected.provider.generate(generationRequest()),
    ).rejects.toThrow(/terminal state/);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.finish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ schemaRepairEligible: true, status: "failed" }),
    );
  });
  it.each([
    (e: any) => (e.wineGo.promptVersions.check = "future"),
    (e: any) => (e.wineGo.model = "other"),
    (e: any) => (e.wineBudget = { ...e.wineBudget, mode: "full" }),
    (e: any) => {
      e.wineEnrichment = structuredClone(e.wineEnrichment);
      delete e.wineEnrichment.maxInputTokens;
    },
    (e: any) => (e.wineAcquisition.rulesVersion = "other"),
    (e: any) =>
      (e.wineAcquisition.deadlineAt = new Date(
        Date.now() + 1000000,
      ).toISOString()),
  ])(
    "rejects malformed stored snapshot before constructing provider",
    (mutate) => {
      const run = acceptedRun();
      mutate(run.execution);
      const s = setup(run);
      expect(s.create).toThrow();
      expect(s.fetch).not.toHaveBeenCalled();
    },
  );
  it("keeps fake legacy provider shape and rejects unknown marked flows", () => {
    const s = setup();
    s.run.execution = { provider: "fake" };
    const selected = s.create();
    expect(selected.flowVersion).toBe("legacy");
    expect(selected.provider.extract).toBeTypeOf("function");
    s.run.execution.flowVersion = "future-flow";
    expect(s.create).toThrow(/flow/);
  });
});
