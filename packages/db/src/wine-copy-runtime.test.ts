import { expect, it } from "vitest";
import * as db from "./index.js";
import type { ListingOperation } from "./repositories/listing-operations.js";
it("selects the real search-free three-stage chain and rejects invalid modes", () => {
  expect(db).toHaveProperty("wineStageOrder");
  const order = (db as any).wineStageOrder;
  for (const mode of ["copy", "section"])
    expect(order(mode)).toEqual([
      "generation",
      "quality_check",
      "commit_candidate",
    ]);
  for (const mode of ["full", "research"])
    expect(order(mode)).toBe(db.WINE_STAGE_ORDER);
  expect(() => order("bogus")).toThrow();
});
it("binds compact copy dependencies only in search-free stage hashes", () => {
  const run = {
    id: "run",
    execution: { wineMode: "copy", wineCopy: { dependencyDigest: "a" } },
  } as unknown as ListingOperation;
  const first = db.wineStageDependencyDigest(run, []);
  run.execution.wineCopy = { dependencyDigest: "b" };
  expect(db.wineStageDependencyDigest(run, [])).not.toBe(first);
  for (const mode of ["full", "research"]) {
    run.execution.wineMode = mode;
    const original = db.wineStageDependencyDigest(run, []);
    run.execution.wineCopy = { dependencyDigest: "c" };
    expect(db.wineStageDependencyDigest(run, [])).toBe(original);
    const e = run.execution;
    expect(original).toBe(
      db.listingInputDigest({
        runId: run.id,
        inputDigest: e.wineInputDigest,
        sourceDigest: e.wineSourceDigest,
        mode: e.wineMode,
        budget: e.wineBudget,
        go: e.wineGo,
        policy: e.wineEnrichment,
        dependencies: [],
      }),
    );
  }
});
