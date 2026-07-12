import { describe, expect, it, vi } from "vitest";
import { PipelineTimeoutError, runListingPipeline } from "./listing-pipeline.js";
import { draftId, listing, makeHarness, makeProvider, workspaceId } from "./pipeline-test-support.js";

describe("listing pipeline recovery contract", () => {
  it("returns null versionId for needs_info", async () => {
    const { deps } = makeHarness({ missingFields: ["priceHkd"] });
    await expect(runListingPipeline({ workspaceId, draftId, activeVersionSequence: 0 }, deps)).resolves.toEqual({ status: "needs_info", versionId: null });
  });

  it("reuses the extraction step after generation failure without duplicate AI telemetry or versions", async () => {
    const { deps, state } = makeHarness();
    const generate = vi.fn()
      .mockRejectedValueOnce(new PipelineTimeoutError())
      .mockResolvedValue({ listing, usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, latencyMs: 1, model: "test-model", promptVersion: "test-v1" } });
    deps.ai = makeProvider({ generateProvider: async (input) => generate(input) });
    const input = { workspaceId, draftId, activeVersionSequence: 0 };
    await expect(runListingPipeline(input, deps, { attempt: 1, maxAttempts: 2 })).rejects.toThrow(PipelineTimeoutError);
    expect(state.status).toBe("processing");
    expect(state.failure).toBeUndefined();
    await expect(runListingPipeline(input, deps, { attempt: 2, maxAttempts: 2 })).resolves.toEqual({ status: "in_review", versionId: "version_1" });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(state.aiRuns.filter((run) => run.task === "extract")).toHaveLength(1);
    expect(state.aiRuns.filter((run) => run.task === "generate")).toHaveLength(1);
    expect(state.versions).toEqual(["version_1"]);
  });

  it("marks the listing failed only on the terminal attempt and stores a sanitized provider error code", async () => {
    const { deps, state } = makeHarness({ extractError: new Error("OpenAI request id sk-test-secret timed out") });
    const input = { workspaceId, draftId, activeVersionSequence: 0 };
    await expect(runListingPipeline(input, deps, { attempt: 1, maxAttempts: 3 })).rejects.toThrow();
    expect(state.status).toBe("processing");
    expect(state.failure).toBeUndefined();
    await expect(runListingPipeline(input, deps, { attempt: 3, maxAttempts: 3 })).rejects.toThrow();
    expect(state.status).toBe("failed");
    expect(state.failure).toBe("provider_timeout");
    expect(state.audits.filter((action) => action === "listing.pipeline_failed")).toHaveLength(1);
  });
});