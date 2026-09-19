import { afterEach, expect, it, vi } from "vitest";
import { createWineQueueRuntime } from "./wine-queue-runtime.js";
it("constructs copy runtime without Tavily or eager storage/research setup", () => {
  const database = { forWorkspace: vi.fn(), close: vi.fn() } as never;
  const assetStoreFactory = vi.fn(() => {
    throw Error("must be lazy");
  });
  expect(() =>
    createWineQueueRuntime({ OPENCODE_GO_API_KEY: "synthetic" } as never, {
      databaseFactory: () => database,
      assetStoreFactory,
    }),
  ).not.toThrow();
  expect(assetStoreFactory).not.toHaveBeenCalled();
});

const ports = vi.hoisted(() => ({
  claim: vi.fn(),
  afterCommit: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("./wine-enrichment-runtime.js", () => ({
  createWineStageStore: () => ({ claim: ports.claim }),
}));
vi.mock("./wine-verification-handler.js", () => ({
  createWineEvidenceStageHandlers: () => ({
    afterCommit: ports.afterCommit,
    execute: ports.execute,
  }),
}));
import { consumeWineMessage } from "./wine-consumer.js";
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it.each(["send", "mark"])(
  "preserves actual postcommit failure through %s failure and successful recovery",
  async (failure) => {
    const job = {
      schemaVersion: 2 as const,
      flowVersion: "wine-enrichment-v1" as const,
      workspaceId: "ws",
      draftId: "10000000-0000-4000-8000-000000000001",
      runId: "10000000-0000-4000-8000-000000000002",
      inputRevision: 1,
      activeVersionSequence: 0,
      stage: "verification" as const,
    };
    ports.claim.mockResolvedValue({
      status: "duplicate",
      committed: {
        context: { run: { execution: { wineMode: "full" } } },
        result: { state: "succeeded" },
      },
    });
    ports.afterCommit
      .mockRejectedValueOnce(Error("PRIVATE_HOOK"))
      .mockResolvedValue(undefined);
    const send = vi.fn(async () => undefined),
      mark = vi.fn(async () => undefined),
      attempted = vi.fn(async () => undefined);
    (failure === "send" ? send : mark).mockRejectedValueOnce(
      Error("PRIVATE_DISPATCH"),
    );
    const database = {
      forWorkspace: async (
        _ws: string,
        work: (r: unknown) => Promise<unknown>,
      ) =>
        work({
          pipelineRuns: { getOperation: async () => null },
          dispatchOutbox: {
            pending: async () => [
              { id: "outbox", payload: { ...job, stage: "generation" } },
            ],
            markDispatched: mark,
            markAttempted: attempted,
          },
        }),
      close: vi.fn(async () => undefined),
    };
    const env = {
      OPENCODE_GO_API_KEY: "synthetic",
      TAVILY_API_KEY: "synthetic",
      WEBSITE_FETCH_BASE_URL: "https://callback.test",
      QUEUE_INGRESS_SECRET: "synthetic",
      LISTING_QUEUE: { send },
    };
    const config = {
      databaseFactory: () => database as never,
      assetStoreFactory: () => ({}) as never,
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => {}),
      error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await consumeWineMessage(job, env as never, config)).toEqual({
      retryAfterSeconds: 30,
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual({
      event: "wine.delivery_retry",
      stage: "verification",
      code: "runtime_or_dispatch_failed",
      diagnostic: "post_commit_failed",
    });
    expect(info).not.toHaveBeenCalled();
    expect(await consumeWineMessage(job, env as never, config)).toBe("ack");
    expect(JSON.parse(String(info.mock.calls[0]![0]))).toEqual({
      event: "wine.stage_delivery",
      stage: "verification",
      status: "duplicate",
    });
    expect(ports.execute).not.toHaveBeenCalled();
    expect(ports.afterCommit).toHaveBeenCalledTimes(2);
    expect(mark).toHaveBeenCalledTimes(failure === "mark" ? 2 : 1);
    expect(
      JSON.stringify([...info.mock.calls, ...error.mock.calls]),
    ).not.toContain("PRIVATE");
  },
);
