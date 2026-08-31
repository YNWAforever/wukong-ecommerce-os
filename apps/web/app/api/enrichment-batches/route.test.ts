import { describe, expect, it } from "vitest";

import { createEnrichmentBatchHandler } from "./route.js";

const okResult = {
  batchId: "batch_1",
  selected: 42,
  budgetUsd: 5,
  waveSize: 10,
};

function handlerFor(
  role: "viewer" | "operator" | "reviewer" | "admin" | "owner",
  createBatch = async () => okResult,
) {
  return createEnrichmentBatchHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws_opak", actorId: "user_1", role };
      },
    },
    createBatch,
  });
}

const post = (body: unknown) =>
  new Request("http://localhost/api/enrichment-batches", {
    method: "POST",
    body: JSON.stringify(body),
  });

const validBody = {
  label: "zh names",
  gap: "untranslatedName",
  budgetUsd: 5,
  waveSize: 3,
};

describe("POST /api/enrichment-batches", () => {
  it("creates a batch for an operator", async () => {
    const response = await handlerFor("operator")(post(validBody));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      batchId: "batch_1",
      selected: 42,
    });
  });

  it("refuses a viewer without creating anything", async () => {
    let called = 0;
    const handler = handlerFor("viewer", async () => {
      called += 1;
      return okResult;
    });

    expect((await handler(post(validBody))).status).toBe(403);
    expect(called).toBe(0);
  });

  it("rejects an unknown gap", async () => {
    const response = await handlerFor("operator")(
      post({ ...validBody, gap: "notAGap" }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a wave size above the 1-5 cap", async () => {
    const response = await handlerFor("operator")(
      post({ ...validBody, waveSize: 6 }),
    );

    expect(response.status).toBe(400);
  });
});
