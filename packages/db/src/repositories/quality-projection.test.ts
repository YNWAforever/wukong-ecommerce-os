import { describe, expect, it, vi } from "vitest";
import { createQualityProjectionRepository } from "./quality-projection.js";
import { computeCurrentContentGaps } from "../quality-content-assessor.js";
describe("projection scoped boundaries", () => {
  it.each([0, 26, NaN, 1.5])(
    "rejects hydration limits outside25 before SQL (%s)",
    async (limit) => {
      const execute = vi.fn();
      const r = createQualityProjectionRepository(
        { execute } as never,
        "synthetic",
        { assertOpen() {} },
      );
      await expect(
        r.reconcile(computeCurrentContentGaps, { limit }),
      ).rejects.toThrow("limit");
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it("rejects closed scope for reads, reconcile and cost snapshot before SQL", async () => {
    const execute = vi.fn();
    const r = createQualityProjectionRepository(
      { execute } as never,
      "synthetic",
      {
        assertOpen() {
          throw Error("closed");
        },
      },
    );
    await expect(r.read()).rejects.toThrow("closed");
    await expect(r.reconcile(computeCurrentContentGaps)).rejects.toThrow(
      "closed",
    );
    await expect(
      r.recordCostSnapshot({
        knownCostUsd: 0,
        unknownCostRunCount: 0,
        asOf: "2026-10-01T00:00:00Z",
      }),
    ).rejects.toThrow("closed");
    expect(execute).not.toHaveBeenCalled();
  });
});
