import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type WorkspaceRepositories } from "../index.js";
const db = createDatabase(process.env.TEST_DATABASE_URL!, {
  migrationUrl: process.env.TEST_DATABASE_ADMIN_URL!,
});
async function run(r: WorkspaceRepositories) {
  const listing = await r.listings.create({ target: "shopline" });
  return r.pipelineRuns.acceptOperation({
    listingId: listing.id,
    inputRevision: 1,
    baseVersionId: null,
    activeVersionSequence: 0,
    requestKey: randomUUID(),
    requestDigest: randomUUID(),
    execution: {},
  });
}
describe("integer search credit reservations", () => {
  beforeAll(() => db.migrate());
  afterAll(() => db.close());
  it("serializes concurrent workspace admission", async () => {
    const ws = `search-${randomUUID()}`;
    const ids = await db.forWorkspace(ws, async (r) => [
      (await run(r)).id,
      (await run(r)).id,
    ]);
    const results = await Promise.all(
      ids.map((pipelineRunId) =>
        db.forWorkspace(ws, (r) =>
          r.searchBudgetReservations.reserve({
            pipelineRunId,
            reservedCredits: 5,
            workspaceCapCredits: 5,
            policyVersion: "v1",
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.accepted)).toHaveLength(1);
  });
  it("releases unused slots, settles measured credits, and never releases unknown", async () => {
    await db.forWorkspace(`search-${randomUUID()}`, async (r) => {
      const first = await run(r);
      const second = await run(r);
      const reserve = (pipelineRunId: string) =>
        r.searchBudgetReservations.reserve({
          pipelineRunId,
          reservedCredits: 5,
          workspaceCapCredits: 5,
          policyVersion: "v1",
        });
      expect((await reserve(first.id)).accepted).toBe(true);
      expect(await r.searchBudgetReservations.settleFromCalls(first.id)).toBe(
        "settled",
      );
      expect((await reserve(second.id)).accepted).toBe(true);
      await r.wineEnrichment.beginSearchCall({
        runId: second.id,
        slot: "basic_1",
        maximumCredits: 1,
        requestDigest: "a",
      });
      expect(await r.searchBudgetReservations.settleFromCalls(second.id)).toBe(
        "unknown",
      );
      const third = await run(r);
      expect((await reserve(third.id)).accepted).toBe(false);
    });
  });
  it("rolls both provider reservations back when admission fails", async () => {
    const ws = `search-${randomUUID()}`;
    const id = await db.forWorkspace(ws, async (r) => (await run(r)).id);
    await expect(
      db.forWorkspace(ws, async (r) => {
        expect(
          (
            await r.aiBudgetReservations.reserve({
              pipelineRunId: id,
              reservedUsd: "1",
              workspaceCapUsd: "10",
              pricingVersion: "v1",
            })
          ).accepted,
        ).toBe(true);
        if (
          !(
            await r.searchBudgetReservations.reserve({
              pipelineRunId: id,
              reservedCredits: 5,
              workspaceCapCredits: 0,
              policyVersion: "v1",
            })
          ).accepted
        )
          throw new Error("dual_budget_denied");
      }),
    ).rejects.toThrow("dual_budget_denied");
    await db.forWorkspace(ws, async (r) => {
      expect(
        (
          await r.aiBudgetReservations.reserve({
            pipelineRunId: id,
            reservedUsd: "10",
            workspaceCapUsd: "10",
            pricingVersion: "v1",
          })
        ).accepted,
      ).toBe(true);
    });
  });
});
