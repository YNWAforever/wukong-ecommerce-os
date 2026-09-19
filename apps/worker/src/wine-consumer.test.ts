import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  close: vi.fn(async () => {}),
}));
vi.mock("./wine-queue-runtime.js", () => ({
  createWineQueueRuntime: () => mocks,
}));
import { consumeWineMessage } from "./wine-consumer.js";
const job = {
  schemaVersion: 2,
  flowVersion: "wine-enrichment-v1",
  workspaceId: "ws",
  draftId: "10000000-0000-4000-8000-000000000001",
  runId: "10000000-0000-4000-8000-000000000002",
  inputRevision: 1,
  activeVersionSequence: 0,
  stage: "verification",
};
afterEach(() => vi.restoreAllMocks());
it.each(["post_commit_skipped", "post_commit_oversized", "post_commit_failed"])(
  "surfaces bounded %s while acknowledging committed work",
  async (code) => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.deliver.mockResolvedValue({
      status: "advanced",
      nextStage: "generation",
      postCommitDiagnostic: { code },
    });
    expect(await consumeWineMessage(job, {} as never)).toBe("ack");
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
      event: "wine.stage_delivery",
      stage: "verification",
      status: "advanced",
      diagnostic: code,
    });
  },
);
it("does not log raw provider/runtime exceptions or turn cleanup failure into replay", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.deliver.mockRejectedValue(Error("PRIVATE_PROVIDER_BODY"));
  mocks.close.mockRejectedValueOnce(Error("PRIVATE_CLEANUP"));
  expect(await consumeWineMessage(job, {} as never)).toEqual({
    retryAfterSeconds: 30,
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
});
