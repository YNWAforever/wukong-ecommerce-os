import { describe, expect, it, vi } from "vitest";
import { createAiRunRepository } from "./ai-runs.js";
describe("safe live owned AI cost metadata", () => {
  it("keeps only known stage categories, bounded owned identifiers and observation time", async () => {
    const execute = vi.fn(async () => [
      {
        known: "1.250000",
        unknown: 2,
        as_of: "2026-10-01T00:00:00Z",
        items: [
          {
            aiRunId: "owned1",
            listingId: "listing1",
            pipelineRunId: null,
            batchId: null,
            stage: "extract",
            createdAt: "2026-10-01T00:00:00Z",
            input: { private: "not returned" },
          },
          {
            aiRunId: "owned2",
            listingId: "listing1",
            pipelineRunId: null,
            batchId: null,
            stage: "arbitrary-private-label",
            createdAt: "2026-10-01T00:00:00Z",
          },
        ],
      },
    ]);
    const result = await createAiRunRepository(
      { execute } as never,
      "workspace",
      { assertOpen() {} },
    ).summarizeOwnedCostMetadata();
    expect(result).toMatchObject({
      knownCostUsd: 1.25,
      unknownCostRunCount: 2,
      unknownCostReferences: { limit: 25, total: 2, hasMore: false },
    });
    expect(
      result.unknownCostReferences.items.map((item) => item.stage),
    ).toEqual(["extract", null]);
    expect(JSON.stringify(result)).not.toContain("arbitrary-private-label");
    expect(JSON.stringify(result)).not.toContain("not returned");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("propagates global query failure and rejects malformed empty observations", async () => {
    const error = Object.assign(Error("synthetic schema fault"), {
      code: "42P01",
    });
    await expect(
      createAiRunRepository(
        {
          execute: async () => {
            throw error;
          },
        } as never,
        "workspace",
        { assertOpen() {} },
      ).summarizeOwnedCostMetadata(),
    ).rejects.toBe(error);
    await expect(
      createAiRunRepository({ execute: async () => [] } as never, "workspace", {
        assertOpen() {},
      }).summarizeOwnedCostMetadata(),
    ).rejects.toThrow("observation missing");
  });
  it("rejects a closed scope before SQL", async () => {
    const execute = vi.fn();
    const r = createAiRunRepository({ execute } as never, "workspace", {
      assertOpen() {
        throw Error("closed");
      },
    });
    await expect(r.summarizeOwnedCostMetadata()).rejects.toThrow("closed");
    expect(execute).not.toHaveBeenCalled();
  });
});
