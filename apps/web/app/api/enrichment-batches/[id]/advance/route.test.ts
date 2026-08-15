import { describe, expect, it } from "vitest";

import { createAdvanceEnrichmentBatchHandler } from "./route.js";

function handlerFor(
  role: "viewer" | "operator" | "reviewer" | "admin" | "owner",
  status: "running" | "completed" | "budget_exhausted" = "running",
  onAdvance: () => void = () => {},
) {
  return createAdvanceEnrichmentBatchHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws_opak", actorId: "user_1", role };
      },
    },
    advanceBatch: async () => {
      onAdvance();
      return {
        batchId: "batch_1",
        status,
        enqueued: status === "running" ? 2 : 0,
        spentUsd: 1.5,
        budgetUsd: 5,
      };
    },
  });
}

const request = new Request(
  "http://localhost/api/enrichment-batches/batch_1/advance",
  { method: "POST" },
);
const context = { params: Promise.resolve({ id: "batch_1" }) };

describe("POST /api/enrichment-batches/[id]/advance", () => {
  it("advances for an operator and reports the wave", async () => {
    const response = await handlerFor("operator")(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enqueued: 2,
      status: "running",
    });
  });

  it("reports an exhausted budget without failing the request", async () => {
    const response = await handlerFor("operator", "budget_exhausted")(
      request,
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "budget_exhausted",
      enqueued: 0,
    });
  });

  // The counter is the point of this case: a role check that ran after the
  // service call would still answer 403, so only "nothing was advanced" proves
  // the check gates the mutation.
  it("refuses a viewer without advancing anything", async () => {
    let called = 0;
    const handler = handlerFor("viewer", "running", () => {
      called += 1;
    });

    expect((await handler(request, context)).status).toBe(403);
    expect(called).toBe(0);
  });
});
