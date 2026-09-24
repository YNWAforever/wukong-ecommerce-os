import { expect, it, vi } from "vitest";
import { runPersistedListingOperation } from "./listing-operation-pipeline.js";
it("legacy envelope cannot execute or settle a persisted wine run", async () => {
  const run = {
    id: "run",
    listingId: "draft",
    inputRevision: 1,
    activeVersionSequence: 0,
    executionState: "queued",
    execution: { flowVersion: "wine-enrichment-v1" },
  };
  const settle = vi.fn(),
    execute = vi.fn();
  await expect(
    runPersistedListingOperation(
      {
        workspaceId: "ws",
        runId: "run",
        draftId: "draft",
        inputRevision: 1,
        activeVersionSequence: 0,
      } as never,
      {
        withWorkspace: async (_ws: unknown, fn: Function) =>
          fn({ operations: { get: async () => run } }),
        settleOperation: settle,
      } as never,
      {},
      execute,
    ),
  ).rejects.toThrow("operation envelope mismatch");
  expect(settle).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
