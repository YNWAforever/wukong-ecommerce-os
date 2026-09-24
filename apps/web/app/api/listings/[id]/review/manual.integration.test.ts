import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, it, expect } from "vitest";
import { createDatabase } from "@wukong/db";
import { emptyWorkingListing } from "@wukong/core";
import { createReviewListingHandler } from "./route";
const workspaceId = `manual-${randomUUID()}`;
const db = createDatabase(
  process.env.TEST_DATABASE_URL ??
    "postgres://wukong_app:wukong-app-local@localhost:54329/wukong",
  {
    migrationUrl:
      process.env.TEST_DATABASE_ADMIN_URL ??
      "postgres://wukong:wukong@localhost:54329/wukong",
  },
);
beforeAll(() => db.migrate());
afterAll(() => db.close());
it("promotes the first manual version under revision and null base CAS without AI", async () => {
  const id = await db.forWorkspace(workspaceId, async (r) => {
    const d = await r.listings.create({ target: "shopline" });
    await r.listingInputs.initialize(
      { listingId: d.id, actorId: "human" },
      { workspaceId, actorId: "human", entityId: d.id },
      r.audit,
    );
    return d.id;
  });
  const run = createReviewListingHandler({
    sessionContext: {
      resolve: async () => ({
        workspaceId,
        actorId: "human",
        role: "operator",
      }),
    },
    getDatabase: () => db,
  });
  const text = { en: "Manual copy", "zh-Hant": "人工內容" };
  const content = {
    ...emptyWorkingListing(),
    packQuantity: 1,
    title: text,
    description: text,
    seo: { title: text, description: text },
  };
  const request = () =>
    new Request(`https://test/api/listings/${id}/review`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseVersionId: null,
        expectedInputRevision: 1,
        content,
      }),
    });
  const response = await run(request(), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  const snapshot = await db.forWorkspace(workspaceId, (r) =>
    r.listings.getReviewSnapshot(id),
  );
  expect(snapshot?.listing.status).toBe("in_review");
  expect(snapshot?.activeVersion?.content.title.en).toBe("Manual copy");
  expect(
    (await run(request(), { params: Promise.resolve({ id }) })).status,
  ).toBe(409);
  const current = await db.forWorkspace(workspaceId, (r) =>
    r.listingInputs.getCurrent(id),
  );
  expect(current?.revision).toBe(2);
  expect(current?.fieldStates["title.en"]?.owner).toBe("operator");
});
