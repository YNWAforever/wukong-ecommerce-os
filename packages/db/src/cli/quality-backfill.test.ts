import { describe, expect, it, vi } from "vitest";
import {
  parseQualityBackfillOptions,
  runQualityBackfill,
} from "./quality-backfill.js";
const url =
  "postgres://wukong_app:synthetic@127.0.0.1:54329/opak_fixes_quality_20261001";
describe("bounded quality backfill", () => {
  it("requires explicit local scope and rejects foreign targets, invalid budgets and unknown arguments", () => {
    for (const target of [
      "postgres://wukong_app:x@remote.example/production",
      "postgres://wukong_app:x@127.0.0.1/wukong",
      "postgres://wukong:x@127.0.0.1/opak_fixes_quality_20261001",
    ])
      expect(() =>
        parseQualityBackfillOptions(["--workspace-id", "synthetic"], target),
      ).toThrow();
    for (const args of [
      [],
      ["--workspace-id", "synthetic", "--max-batches", "0"],
      ["--workspace-id", "synthetic", "--time-budget-ms", "-1"],
      ["--workspace-id", "synthetic", "--unknown", "x"],
    ])
      expect(() => parseQualityBackfillOptions(args, url)).toThrow();
  });
  it("stops at finite batch budget and resumes through the same25-row reconcile with metadata-only progress", async () => {
    let calls = 0;
    const reconcile = vi.fn(async (_assess, options) => {
      expect(options).toEqual({ limit: 25 });
      calls++;
      return {
        assessmentVersion: "opak-current-content-v1",
        projection: {
          state: calls === 3 ? "ready" : "pending",
          asOf: null,
          stale: calls !== 3,
          pendingCount: Math.max(0, 75 - calls * 25),
          failedCount: 0,
        },
        totalListings: 75,
        totalAssessed: calls * 25,
        cleanCount: calls * 25,
      };
    });
    const db = {
      async forWorkspace(ws: string, work: (r: any) => Promise<unknown>) {
        expect(ws).toBe("synthetic");
        return work({
          qualityProjection: { reconcile, async recordCostSnapshot() {} },
          aiRuns: {
            async summarizeOwnedCostMetadata() {
              return {
                knownCostUsd: 1,
                unknownCostRunCount: 0,
                unknownCostReferences: { asOf: "2026-10-01T00:00:00Z" },
              };
            },
          },
        });
      },
    } as never;
    const options = parseQualityBackfillOptions(
      ["--workspace-id", "synthetic", "--max-batches", "2"],
      url,
    );
    const first = await runQualityBackfill(db, options, { now: () => 0 });
    expect(first).toMatchObject({
      completed: false,
      batches: 2,
      pendingCount: 25,
    });
    const next = await runQualityBackfill(db, options, { now: () => 0 });
    expect(next).toMatchObject({
      completed: true,
      batches: 1,
      pendingCount: 0,
    });
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(next).not.toHaveProperty("content");
    expect(next).not.toHaveProperty("prompt");
  });
  it("does not admit another25-row batch after a deadline and reports last committed progress", async () => {
    let ticks = 0;
    const onBatch = vi.fn();
    const reconcile = vi.fn(async () => ({
      assessmentVersion: "opak-current-content-v1",
      projection: {
        state: "pending",
        stale: true,
        pendingCount: 50,
        failedCount: 0,
        asOf: null,
      },
      totalListings: 75,
      totalAssessed: 25,
    }));
    const db = {
      async forWorkspace(_ws: string, work: (r: any) => Promise<unknown>) {
        return work({
          qualityProjection: { reconcile, async recordCostSnapshot() {} },
          aiRuns: {
            async summarizeOwnedCostMetadata() {
              return {
                knownCostUsd: 0,
                unknownCostRunCount: 0,
                unknownCostReferences: { asOf: "2026-10-01T00:00:00Z" },
              };
            },
          },
        });
      },
    } as never;
    const options = parseQualityBackfillOptions(
      ["--workspace-id", "synthetic", "--time-budget-ms", "1000"],
      url,
    );
    expect(
      await runQualityBackfill(db, options, {
        now: () => (ticks++ < 2 ? 0 : 2000),
        onBatch,
      }),
    ).toMatchObject({ completed: false, batches: 1, pendingCount: 50 });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(onBatch).toHaveBeenCalledOnce();
  });
  it("stops starting batches after deadline and propagates global failures", async () => {
    const options = parseQualityBackfillOptions(
      ["--workspace-id", "synthetic", "--time-budget-ms", "1000"],
      url,
    );
    const db = {
      forWorkspace: vi.fn(async () => {
        throw Error("synthetic SQL fault");
      }),
    } as never;
    await expect(
      runQualityBackfill(db, options, { now: () => 0 }),
    ).rejects.toThrow("synthetic SQL fault");
  });
});
