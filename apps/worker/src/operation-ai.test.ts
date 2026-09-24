import { describe, it, expect, vi } from "vitest";
const calls = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@wukong/ai", async (original) => {
  const actual = await original<typeof import("@wukong/ai")>();
  return {
    ...actual,
    OpenAIListingProvider: class {
      constructor(
        _client: unknown,
        private config: any,
      ) {}
      async extract() {
        const base = {
          ordinal: 1,
          phase: "request",
          diagnostic: {
            category: "internal",
            retryable: false,
            httpStatus: null,
            providerCode: null,
            requestId: null,
          },
          usage: {
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            certainty: "unknown",
          },
        };
        await this.config.invocationObserver({ ...base, outcome: "started" });
        calls.fetch();
        await this.config.invocationObserver({ ...base, outcome: "api_error" });
        throw new actual.ProviderApiError("transport failed");
      }
    },
  };
});
import { LISTING_PROMPT_VERSIONS } from "@wukong/core";
import { operationAI } from "./operation-ai.js";
function fixture(claimed = true) {
  calls.fetch.mockClear();
  const run = {
    id: "run",
    listingId: "draft",
    execution: {
      promptVersions: LISTING_PROMPT_VERSIONS,
      provider: "openai",
      aiPolicy: {
        provider: "openai",
        model: "gpt-4o",
        pricingVersion: "reviewed",
        runCeilingUsd: "2",
        budgetCapUsd: "10",
        maxOutputTokens: 1000,
        maxInputTokens: 128000,
        inputUsdPerMillion: 2.5,
        outputUsdPerMillion: 10,
      },
    },
  };
  const repos = {
    listings: { lockReviewState: vi.fn().mockResolvedValue(undefined) },
    pipelineRuns: {
      getCurrentOperation: vi
        .fn()
        .mockResolvedValue({ ...run, executionState: "running" }),
    },
    aiRuns: {
      beginInvocation: vi.fn().mockResolvedValue({ claimed }),
      finalizeInvocation: vi.fn().mockResolvedValue(undefined),
    },
  };
  const db = {
    forWorkspace: vi.fn(async (_ws: string, work: any) => work(repos)),
  };
  const env = {
    AI_PROVIDER: "openai",
    LISTING_PAID_OPERATIONS_ENABLED: "true",
    OPENAI_API_KEY: "local-test-key",
  };
  return { run, repos, db, env };
}
describe("physical invocation runtime", () => {
  it("commits pending identity before the call and records unknown transport usage", async () => {
    const { run, repos, db, env } = fixture();
    const provider = operationAI(
      db as never,
      env as never,
      "workspace",
      run as never,
    );
    await expect(
      provider.extract({ assets: [], note: "note" }),
    ).rejects.toThrow("transport failed");
    expect(
      repos.aiRuns.beginInvocation.mock.invocationCallOrder[0],
    ).toBeLessThan(calls.fetch.mock.invocationCallOrder[0]!);
    expect(repos.aiRuns.finalizeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineRunId: "run",
        stage: "extract",
        callOrdinal: 1,
        status: "failed",
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
        usageCertainty: "unknown",
      }),
    );
  });
  it("observes cancellation under the listing lock before physical-call admission", async () => {
    const { run, repos, db, env } = fixture();
    repos.listings.lockReviewState.mockImplementation(async () => {
      repos.pipelineRuns.getCurrentOperation.mockResolvedValue({
        ...run,
        executionState: "cancelled",
      });
    });
    await expect(
      operationAI(db as never, env as never, "workspace", run as never).extract(
        { assets: [], note: null },
      ),
    ).rejects.toThrow("no longer active");
    expect(repos.listings.lockReviewState).toHaveBeenCalledWith(run.listingId);
    expect(repos.aiRuns.beginInvocation).not.toHaveBeenCalled();
    expect(calls.fetch).not.toHaveBeenCalled();
  });
  it("never repeats an already recorded physical call", async () => {
    const { run, repos, db, env } = fixture(false);
    await expect(
      operationAI(db as never, env as never, "workspace", run as never).extract(
        { assets: [], note: null },
      ),
    ).rejects.toThrow("already recorded");
    expect(calls.fetch).not.toHaveBeenCalled();
    expect(repos.aiRuns.finalizeInvocation).not.toHaveBeenCalled();
  });
  it("refuses a queued prompt version the runtime cannot execute", () => {
    const { run, db, env } = fixture();
    expect(() =>
      operationAI(db as never, env as never, "workspace", {
        ...run,
        execution: {
          ...run.execution,
          promptVersions: { extraction: "old", generation: "old" },
        },
      } as never),
    ).toThrow("prompt versions");
    expect(calls.fetch).not.toHaveBeenCalled();
  });
  it("blocks paid work until explicitly enabled", () => {
    const { run, db, env } = fixture();
    expect(() =>
      operationAI(
        db as never,
        { ...env, LISTING_PAID_OPERATIONS_ENABLED: "false" } as never,
        "workspace",
        run as never,
      ),
    ).toThrow("not configured");
    expect(calls.fetch).not.toHaveBeenCalled();
  });
});
it("uses immutable Go policy and session while recording the physical request", async () => {
  const { run, db, repos, env } = fixture();
  run.execution.provider = "opencode-go";
  Object.assign(run.execution.aiPolicy, {
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    maxInputTokens: 1048576,
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 1.2,
  });
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json(
        { error: { code: "invalid_api_key", message: "denied" } },
        { status: 401 },
      );
    },
  );
  try {
    await expect(
      operationAI(
        db as never,
        {
          ...env,
          AI_PROVIDER: "opencode-go",
          OPENCODE_GO_API_KEY: "go-test",
        } as never,
        "workspace",
        run as never,
      ).extract({ assets: [], note: null }),
    ).rejects.toThrow("request failed");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("x-opencode-session")).toBe(run.id);
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer go-test");
    expect(repos.aiRuns.beginInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
      }),
    );
    expect(repos.aiRuns.finalizeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ httpStatus: 401, usageCertainty: "unknown" }),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
