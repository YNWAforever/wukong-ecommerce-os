import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDatabase } from "@wukong/db";
import {
  S3AssetStore,
  readS3RuntimeConfig,
} from "../../../assets/src/index.js";
import { ProductShotProviderError } from "../../../ai/src/index.js";
import { createProductShotRuntime } from "../../../../apps/worker/src/cloudflare-runtime.js";
import {
  runProductShot,
  ProductShotBusyError,
} from "../../../../apps/worker/src/product-shot-pipeline.js";
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL,
  appUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !appUrl)
  throw new Error("Explicit isolated test database URLs required");
const admin = postgres(adminUrl, {
    max: 2,
    prepare: false,
    onnotice: () => {},
  }),
  db = createDatabase(appUrl);
const storage = readS3RuntimeConfig(process.env),
  store = S3AssetStore.fromConfig(storage.bucket, storage.client);
beforeAll(async () => {
  expect((await admin`select 1 as connected`)[0]!.connected).toBe(1);
});
afterAll(async () => {
  await db.close();
  await admin.end();
});
async function fixture() {
  const workspaceId = "shot_worker_" + randomUUID(),
    listingId = randomUUID(),
    actorId = "actor_" + randomUUID(),
    sourceAssetId = randomUUID();
  await admin`insert into workspaces(id,name,profile) values (${workspaceId},'Synthetic','{}')`;
  await admin`insert into users(id,email) values (${actorId},${actorId + "@example.invalid"})`;
  await admin`insert into memberships(workspace_id,user_id,role) values (${workspaceId},${actorId},'operator')`;
  await admin`insert into listing_drafts(id,workspace_id,status) values (${listingId},${workspaceId},'received')`;
  const runtime = createProductShotRuntime(
    { PRODUCT_SHOT_PROVIDER: "fake" } as never,
    { databaseFactory: () => db, assetStoreFactory: () => store },
  );
  const provider = runtime.dependencies.providerFor({
    providerVersion: "fake:1.0.0",
    renderVersion: "white-v1",
  } as never);
  const result = await provider.generateProductShot({ assets: [] }),
    key = `ws/${workspaceId}/sources/${sourceAssetId}/input.png`;
  await store.writeObject(workspaceId, key, result.cutoutPng, "image/png");
  await admin`insert into source_assets(id,workspace_id,listing_id,storage_key,kind,metadata) values (${sourceAssetId},${workspaceId},${listingId},${key},'image/png','{}')`;
  const { attemptId } = await db.forWorkspace(workspaceId, (r) =>
    r.productShots.ensure({
      workspaceId,
      listingId,
      actorId,
      sourceAssetId,
      sourceDigest: createHash("sha256").update(result.cutoutPng).digest("hex"),
      providerVersion: "fake:1.0.0",
      renderVersion: "white-v1",
      explicitFreshAttempt: false,
    }),
  );
  const generateProductShot = vi.fn(async () => result);
  const deps = {
    ...runtime.dependencies,
    providerFor: () => ({ generateProductShot }),
  };
  const job = {
    kind: "product_shot" as const,
    workspaceId,
    draftId: listingId,
    attemptId,
  };
  return {
    job,
    actorId,
    deps,
    generateProductShot,
    get: () =>
      db.forWorkspace(workspaceId, (r) => r.productShots.get(attemptId)),
  };
}
it("commits one billed attempt and one private cutout across concurrent real-DB/S3 deliveries", async () => {
  const f = await fixture();
  const deliveries = await Promise.allSettled([
    runProductShot(f.job, f.deps),
    runProductShot(f.job, f.deps),
  ]);
  for (const delivery of deliveries)
    if (delivery.status === "rejected")
      expect(delivery.reason).toBeInstanceOf(ProductShotBusyError);
  await runProductShot(f.job, f.deps);
  expect(f.generateProductShot).toHaveBeenCalledOnce();
  expect(await f.get()).toMatchObject({ state: "cutout_ready", callCount: 1 });
  expect(
    await admin`select action from audit_events where entity_id=${f.job.draftId} and action='product_shot.cutout_saved'`,
  ).toHaveLength(1);
});
it("retains timeout as outcome_unknown across real repository redelivery", async () => {
  const f = await fixture();
  f.generateProductShot.mockRejectedValueOnce(
    new ProductShotProviderError("outcome_unknown"),
  );
  await runProductShot(f.job, f.deps);
  await runProductShot(f.job, f.deps);
  expect(await f.get()).toMatchObject({
    state: "outcome_unknown",
    callCount: 1,
  });
  expect(f.generateProductShot).toHaveBeenCalledOnce();
});

it("reconciles expired historical A once after selecting B without another provider call", async () => {
  const f = await fixture();
  const now = new Date();
  const claim = await db.forWorkspace(f.job.workspaceId, (r) =>
    r.productShots.claim({
      attemptId: f.job.attemptId,
      dailyLimit: 5,
      now,
    }),
  );
  expect(claim.kind).toBe("claimed");
  const a = (await f.get())!;
  const sourceB = randomUUID();
  const key = `ws/${f.job.workspaceId}/sources/${sourceB}/input.png`;
  await admin`insert into source_assets(id,workspace_id,listing_id,storage_key,kind,metadata) values (${sourceB},${f.job.workspaceId},${f.job.draftId},${key},'image/png','{}')`;
  const b = await db.forWorkspace(f.job.workspaceId, (r) =>
    r.productShots.ensure({
      workspaceId: f.job.workspaceId,
      listingId: f.job.draftId,
      actorId: f.actorId,
      sourceAssetId: sourceB,
      sourceDigest: a.sourceDigest,
      providerVersion: a.providerVersion,
      renderVersion: a.renderVersion,
      explicitFreshAttempt: false,
    }),
  );
  expect(b.attemptId).not.toBe(a.attemptId);
  f.deps.now = () => new Date(+a.leaseExpiresAt! + 1);
  await Promise.all([
    runProductShot(f.job, f.deps),
    runProductShot(f.job, f.deps),
  ]);
  await runProductShot(f.job, f.deps);
  expect(await f.get()).toMatchObject({
    state: "outcome_unknown",
    callCount: 1,
    leaseToken: null,
  });
  expect(
    await db.forWorkspace(f.job.workspaceId, (r) =>
      r.productShots.currentForListing(f.job.draftId),
    ),
  ).toMatchObject({ attemptId: b.attemptId, state: "queued", callCount: 0 });
  expect(
    await admin`select action from audit_events where entity_id=${f.job.draftId} and action='product_shot.outcome_unknown'`,
  ).toHaveLength(1);
  expect(
    await admin`select action from audit_events where entity_id=${f.job.draftId} and action='product_shot.dispatched'`,
  ).toHaveLength(1);
  expect(f.generateProductShot).not.toHaveBeenCalled();
});
