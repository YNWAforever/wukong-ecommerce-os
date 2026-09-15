import { afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createDatabase } from "../client.js";
const url =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const database = createDatabase(url, {
  migrationUrl:
    process.env.TEST_DATABASE_ADMIN_URL ??
    "postgres://wukong:wukong@localhost:54329/wukong",
});
const sql = postgres(url, { max: 1 });
afterAll(async () => {
  await sql.end();
  await database.close();
});
it("denies mutation of persisted decisions and isolates another workspace", async () => {
  await database.migrate();
  const workspaceId = "decision-" + randomUUID();
  const decision = await database.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    await r.listingInputs.initialize(
      { listingId: listing.id, actorId: "operator" },
      { workspaceId, actorId: "operator", entityId: listing.id },
      r.audit,
    );
    const suggestion = await r.listingEnrichment.record({
      listingId: listing.id,
      inputRevision: 1,
      baseVersionId: null,
      requestKey: randomUUID(),
      requestDigest: "a".repeat(64),
      payload: {
        url: "https://producer.example",
        identity: {
          producer: "Maker",
          productName: "Wine",
          vintage: 2020,
          volumeMl: 750,
          packQuantity: 1,
          marketVariant: "HK",
        },
        inputContextDigest: "a".repeat(64),
        result: null,
        errorCode: "source_unavailable",
      },
    });
    return r.listingEnrichment.reject({
      listingId: listing.id,
      suggestionId: suggestion!.id,
      inputRevision: 1,
      baseVersionId: null,
      requestKey: randomUUID(),
      requestDigest: "b".repeat(64),
      actorId: "operator",
      selectedFields: ["country"],
    });
  });
  await expect(
    sql.begin(async (tx) => {
      await tx`select set_config('app.workspace_id',${workspaceId},true)`;
      await tx`update listing_enrichment_decisions set actor_id='tampered' where id=${String(decision.id)}`;
    }),
  ).rejects.toMatchObject({ code: "42501" });
  await sql.begin(async (tx) => {
    await tx`select set_config('app.workspace_id','foreign-review',true)`;
    expect(
      await tx`select id from listing_enrichment_decisions where id=${String(decision.id)}`,
    ).toHaveLength(0);
  });
});
