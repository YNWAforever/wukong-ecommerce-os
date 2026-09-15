import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { createDatabase } from "@wukong/db";
import { MemoryAssetStore } from "@wukong/assets";
import {
  requestProductShot,
  acceptSourceWithoutDecoding,
} from "../../../../../lib/product-shot-request";
const workspaceId = `image-no-text-${randomUUID()}`;
const database = createDatabase(
  process.env.TEST_DATABASE_URL ??
    "postgres://wukong_app:wukong-app-local@localhost:54329/wukong",
  {
    migrationUrl:
      process.env.TEST_DATABASE_ADMIN_URL ??
      "postgres://wukong:wukong@localhost:54329/wukong",
  },
);
const admin = postgres(
  process.env.TEST_DATABASE_ADMIN_URL ??
    "postgres://wukong:wukong@localhost:54329/wukong",
  { max: 1, prepare: false },
);
beforeAll(async () => {
  await database.migrate();
  await admin`insert into workspaces(id,name,profile) values (${workspaceId},'Synthetic','{}')`;
  await admin`insert into users(id,email) values (${workspaceId},${workspaceId + "@example.invalid"})`;
  await admin`insert into memberships(workspace_id,user_id,role) values (${workspaceId},${workspaceId},'operator')`;
});
afterAll(async () => {
  await database.close();
  await admin.end();
});
it("keeps one source-digest image attempt before text and rejects stale revision", async () => {
  const store = new MemoryAssetStore();
  const bytes = new Uint8Array([1, 2, 3]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const f = await database.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const source = await r.sourceAssets.create({
      storageKey: `ws/${workspaceId}/sources/${randomUUID()}/image.png`,
      kind: "image/png",
      metadata: { sha256: digest, size: 3, mimeType: "image/png" },
    });
    await r.sourceAssets.attachToListing(listing.id, [source.id]);
    const context = { workspaceId, actorId: workspaceId, entityId: listing.id };
    await r.listingInputs.initialize(
      { listingId: listing.id, actorId: workspaceId },
      context,
      r.audit,
    );
    return { listing, source, context };
  });
  await store.writeObject(workspaceId, f.source.storageKey, bytes, "image/png");
  const enqueue = vi.fn(async () => ({ accepted: true }));
  const deps = {
    forWorkspace: database.forWorkspace,
    assetStore: store,
    providerName: "fake" as const,
    enqueue,
    validateSource: acceptSourceWithoutDecoding,
  };
  const input = {
    workspaceId,
    listingId: f.listing.id,
    actorId: workspaceId,
    expectedVersionId: null,
    expectedInputRevision: 1,
  };
  const first = await requestProductShot(input, deps);
  expect(first.state).toBe("queued");
  expect((await requestProductShot(input, deps)).attemptId).toBe(
    first.attemptId,
  );
  await database.forWorkspace(workspaceId, (r) =>
    r.listingInputs.save(
      {
        listingId: f.listing.id,
        actorId: workspaceId,
        expectedInputRevision: 1,
        baseVersionId: null,
        operationKey: randomUUID(),
        requestDigest: "b".repeat(64),
        note: "Corrected",
        changes: [],
      },
      f.context,
      r.audit,
    ),
  );
  await expect(requestProductShot(input, deps)).rejects.toMatchObject({
    code: "input_revision_conflict",
  });
  expect(enqueue).toHaveBeenCalledTimes(2);
  expect(
    (
      await database.forWorkspace(workspaceId, (r) =>
        r.listings.getById(f.listing.id),
      )
    )?.activeVersionId,
  ).toBeNull();
});
