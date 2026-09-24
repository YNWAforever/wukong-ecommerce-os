import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDatabase } from "@wukong/db";
import { emptyWorkingListing } from "@wukong/core";
import { createReviewConfirmationsHandler } from "./route";
const workspaceId = `review-cas-${randomUUID()}`;
const database = createDatabase(
  process.env.TEST_DATABASE_URL ??
    "postgres://wukong_app:wukong-app-local@localhost:54329/wukong",
  {
    migrationUrl:
      process.env.TEST_DATABASE_ADMIN_URL ??
      "postgres://wukong:wukong@localhost:54329/wukong",
  },
);
beforeAll(() => database.migrate());
afterAll(() => database.close());
it("serializes competing saved-version confirmations and invalidates them on a new source note", async () => {
  const fixture = await database.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const context = { workspaceId, actorId: "operator", entityId: listing.id };
    await r.listingInputs.initialize(
      { listingId: listing.id, actorId: "operator" },
      context,
      r.audit,
    );
    const text = { en: "Manual copy", "zh-Hant": "人工內容" };
    const version = await r.listings.promoteManual(
      listing.id,
      {
        ...emptyWorkingListing(),
        packQuantity: 1,
        title: text,
        description: text,
        seo: { title: text, description: text },
      },
      context,
      r.audit,
      [],
    );
    return { listing, version, context };
  });
  const handler = createReviewConfirmationsHandler({
    sessionContext: {
      resolve: async () => ({
        workspaceId,
        actorId: "reviewer",
        role: "reviewer",
      }),
    },
    getDatabase: () => database,
  });
  const request = () =>
    new Request("https://test", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        versionId: fixture.version.id,
        expectedRevision: null,
        fieldConfirmations: { title: true },
        negativeConfirmations: { no_medical_claims: true },
      }),
    });
  const routeContext = { params: Promise.resolve({ id: fixture.listing.id }) };
  const responses = await Promise.all([
    handler(request(), routeContext),
    handler(request(), routeContext),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  await database.forWorkspace(workspaceId, (r) =>
    r.listingInputs.save(
      {
        listingId: fixture.listing.id,
        actorId: "operator",
        expectedInputRevision: 1,
        baseVersionId: fixture.version.id,
        operationKey: randomUUID(),
        requestDigest: "e".repeat(64),
        note: "New source facts",
        changes: [],
      },
      fixture.context,
      r.audit,
    ),
  );
  const ledger = await database.forWorkspace(workspaceId, (r) =>
    r.reviewConfirmations.getByVersionId(fixture.version.id),
  );
  expect(ledger?.fieldConfirmations).toEqual({});
  expect(ledger?.negativeConfirmations).toEqual({});
  expect(ledger?.revision).toBe(1);
  expect(
    await database.forWorkspace(workspaceId, (r) =>
      r.reviewConfirmations.getFieldRecordsByVersionId(fixture.version.id),
    ),
  ).toBeNull();
});
