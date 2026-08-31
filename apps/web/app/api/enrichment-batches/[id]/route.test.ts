import { describe, expect, it } from "vitest";

import { ApiError } from "../../../../lib/route-support";
import { createGetEnrichmentBatchHandler } from "./route.js";

const okBatch = {
  id: "batch_1",
  label: "zh names",
  budgetUsd: 5,
  waveSize: 3,
  status: "running" as const,
  createdBy: "user_1",
  createdAt: new Date("2026-08-01T00:00:00Z"),
};
const okCounts = {
  pending: 1,
  queued: 0,
  succeeded: 2,
  failed: 0,
  skipped: 0,
};

function handlerFor(
  role: "viewer" | "operator" | "reviewer" | "admin" | "owner",
  getBatch: () => Promise<{
    batch: typeof okBatch;
    counts: typeof okCounts;
  }> = async () => ({
    batch: okBatch,
    counts: okCounts,
  }),
) {
  return createGetEnrichmentBatchHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws_opak", actorId: "user_1", role };
      },
    },
    getBatch,
  });
}

const request = new Request(
  "http://localhost/api/enrichment-batches/batch_1",
  { method: "GET" },
);
const context = { params: Promise.resolve({ id: "batch_1" }) };

describe("GET /api/enrichment-batches/[id]", () => {
  it("returns the batch and its counts for an operator", async () => {
    const response = await handlerFor("operator")(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      batch: { ...okBatch, createdAt: okBatch.createdAt.toISOString() },
      counts: okCounts,
    });
  });

  it("refuses a viewer", async () => {
    const response = await handlerFor("viewer")(request, context);
    expect(response.status).toBe(403);
  });

  it("reports a missing batch as 404", async () => {
    const handler = handlerFor("operator", async () => {
      throw new ApiError(404, "batch_not_found", "No such enrichment batch.");
    });

    const response = await handler(request, context);
    expect(response.status).toBe(404);
  });
});
