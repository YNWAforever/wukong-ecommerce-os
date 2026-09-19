import { expect, it } from "vitest";
import * as db from "@wukong/db";
import {
  parseWineStageResult,
  WINE_STAGE_ORDER,
} from "./wine-enrichment-pipeline.js";
import { wineStageDependencyDigest } from "./wine-stage-dependencies.js";
it("shares the exact persisted parser, order and canonical dependency digest through DB", () => {
  expect(db).toHaveProperty("parseWineStageResult");
  expect(db).toHaveProperty("WINE_STAGE_ORDER", WINE_STAGE_ORDER);
  expect(db).toHaveProperty(
    "wineStageDependencyDigest",
    wineStageDependencyDigest,
  );
  const shared = (db as any).parseWineStageResult;
  for (const stage of WINE_STAGE_ORDER) {
    for (const raw of [
      null,
      {},
      { schemaVersion: 1, stage, state: "unknown", code: "fixture" },
      {
        schemaVersion: 1,
        stage,
        state: "succeeded",
        versionId: "00000000-0000-0000-0000-000000000000",
        outcome: "complete",
      },
      {
        schemaVersion: 1,
        stage,
        state: "unknown",
        code: "fixture",
        extra: true,
      },
    ]) {
      const outcome = (fn: typeof parseWineStageResult) => {
        try {
          return { value: fn(raw, stage) };
        } catch (e) {
          return { error: (e as Error).message };
        }
      };
      expect(outcome(shared)).toEqual(outcome(parseWineStageResult));
    }
  }
});
import * as core from "@wukong/core";
import {
  WINE_EXECUTION_SNAPSHOT,
  wineExecutionSnapshotSchema,
} from "@wukong/ai";
it("shares the exact accepted model snapshot and pure historical ownership resolver", () => {
  expect(core).toHaveProperty("wineExecutionSnapshotSchema");
  expect(core).toHaveProperty(
    "WINE_EXECUTION_SNAPSHOT",
    WINE_EXECUTION_SNAPSHOT,
  );
  expect(
    (core as any).wineExecutionSnapshotSchema.parse(WINE_EXECUTION_SNAPSHOT),
  ).toEqual(wineExecutionSnapshotSchema.parse(WINE_EXECUTION_SNAPSHOT));
  expect(db).toHaveProperty("resolveWineGenerationOwnership");
});
