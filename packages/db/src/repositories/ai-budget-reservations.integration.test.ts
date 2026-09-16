import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../index.js";
const url = process.env.TEST_DATABASE_URL!;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  !url.endsWith("/wukong_wine_sdd")
)
  throw new Error("dedicated local fixture required");
const db = createDatabase(url);
afterAll(() => db.close());
async function run(workspaceId: string) {
  return db.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    return r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: 0,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      execution: {},
    });
  });
}
const reserve = (
  workspaceId: string,
  pipelineRunId: string,
  reservedUsd = "3.194880",
) =>
  db.forWorkspace(workspaceId, (r) =>
    r.aiBudgetReservations.reserve({
      pipelineRunId,
      reservedUsd,
      workspaceCapUsd: "10",
      pricingVersion: "fixture",
    }),
  );
it.each(["unknown", "settled"] as const)(
  "charges larger actual spend above %s reservation charge",
  async (state) => {
    const ws = `charge-${randomUUID()}`,
      first = await run(ws);
    await reserve(ws, first.id);
    await db.forWorkspace(ws, async (r) => {
      await r.aiRuns.beginInvocation({
        listingId: first.listingId,
        pipelineRunId: first.id,
        task: "extract",
        stage: "extract",
        callOrdinal: 1,
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        promptVersion: "fixture",
      });
      await r.aiRuns.finalizeInvocation({
        pipelineRunId: first.id,
        stage: "extract",
        callOrdinal: 1,
        status: "failed",
        inputTokens: 10,
        outputTokens: 4,
        estimatedCostUsd: "10.000000",
        usageCertainty: "estimated",
        latencyMs: 1,
      });
      await r.aiBudgetReservations.settle({
        pipelineRunId: first.id,
        outcome: state,
        settledUsd: state === "settled" ? "1.000000" : null,
      });
    });
    const second = await run(ws);
    expect(await reserve(ws, second.id)).toEqual({
      accepted: false,
      state: "budget_blocked",
    });
  },
);
it("keeps the full unknown hold when actual known spend is smaller", async () => {
  const ws = `charge-${randomUUID()}`,
    first = await run(ws);
  await reserve(ws, first.id, "9.000000");
  await db.forWorkspace(ws, (r) =>
    r.aiBudgetReservations.settle({
      pipelineRunId: first.id,
      outcome: "unknown",
      settledUsd: null,
    }),
  );
  const second = await run(ws);
  expect(await reserve(ws, second.id, "1.000000")).toEqual({
    accepted: true,
    state: "held",
  });
  const third = await run(ws);
  expect(await reserve(ws, third.id, "0.000001")).toEqual({
    accepted: false,
    state: "budget_blocked",
  });
});
it("preserves the existing reservation scope for unreserved historical rows", async () => {
  const ws = `charge-${randomUUID()}`,
    historical = await run(ws);
  await db.forWorkspace(ws, (r) =>
    r.aiRuns.append({
      listingId: historical.listingId,
      task: "extract",
      idempotencyKey: randomUUID(),
      provider: "fake",
      model: "fixture",
      promptVersion: "fixture",
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      estimatedCostUsd: 100,
    }),
  );
  const next = await run(ws);
  expect(await reserve(ws, next.id)).toEqual({ accepted: true, state: "held" });
});
