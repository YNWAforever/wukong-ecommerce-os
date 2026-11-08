import { describe, expect, it } from "vitest";

import {
  mapListingRunState,
  readListingRunStatus,
} from "./listing-run-status.js";

describe("mapListingRunState", () => {
  it("passes through every reviewed state", () => {
    for (const state of [
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "outcome_unknown",
      "unavailable",
    ] as const)
      expect(mapListingRunState(state)).toBe(state);
  });

  it("maps a superseded run to cancelled and an unknown state to unavailable", () => {
    expect(mapListingRunState("superseded")).toBe("cancelled");
    expect(mapListingRunState("something_new")).toBe("unavailable");
    // Never guesses success for a state this build cannot prove.
    expect(mapListingRunState("")).toBe("unavailable");
  });
});

describe("readListingRunStatus", () => {
  it("returns the reviewed tool output for a run owned by the listing", async () => {
    const result = await readListingRunStatus(
      {
        async getListingRunStatus(listingId, runId) {
          expect(listingId).toBe("listing-1");
          expect(runId).toBe("run-1");
          return { state: "running" };
        },
      },
      { listingId: "listing-1", runId: "run-1" },
    );
    expect(result).toEqual({
      listingId: "listing-1",
      runId: "run-1",
      state: "running",
    });
  });

  it("is null when the operation is missing or belongs to another listing", async () => {
    const deps = {
      async getListingRunStatus() {
        return null;
      },
    };
    expect(
      await readListingRunStatus(deps, { listingId: "listing-1", runId: "run-1" }),
    ).toBeNull();
  });
});
