import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import postgres from "postgres";
import { afterAll, expect, it, vi } from "vitest";
import { createDatabase } from "@wukong/db";
import { S3AssetStore, readS3RuntimeConfig } from "@wukong/assets";
import {
  prepareProductShot,
  approveProductShot,
  readProductShot,
} from "../../../../../lib/product-shot-service";
import { requestProductShot } from "../../../../../lib/product-shot-request";
import { createApproveListingHandler } from "../approve/route";
import { createBulkApproveHandler } from "../../bulk-approve/route";
import {
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
} from "../../../../../lib/review-confirmation-keys";
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
const config = readS3RuntimeConfig(process.env),
  store = S3AssetStore.fromConfig(config.bucket, config.client);
const require = createRequire(import.meta.url),
  sharp = createRequire(require.resolve("@wukong/assets"))("sharp");
const deps = { forWorkspace: db.forWorkspace, assetStore: store };
afterAll(async () => {
  await db.close();
  await admin.end();
});
async function fixture() {
  const workspaceId = "shot_review_" + randomUUID(),
    listingId = randomUUID(),
    versionId = randomUUID(),
    actorId = "reviewer_" + randomUUID();
  await admin`insert into workspaces(id,name,profile) values (${workspaceId},'Synthetic','{}')`;
  await admin`insert into users(id,email) values (${actorId},${actorId + "@example.invalid"})`;
  await admin`insert into memberships(workspace_id,user_id,role) values (${workspaceId},${actorId},'reviewer')`;
  await admin`insert into listing_drafts(id,workspace_id,status) values (${listingId},${workspaceId},'in_review')`;
  const content = {
    sku: "SYNTHETIC",
    producer: "Synthetic",
    productType: "wine",
    country: "Germany",
    region: "Mosel",
    vintage: 2024,
    grapeVarieties: ["Riesling"],
    volumeMl: 750,
    abvPercent: 12,
    packQuantity: 1,
    priceHkd: 200,
    stockQuantity: 4,
    criticScores: [],
    awards: [],
    title: { en: "Synthetic", "zh-Hant": "Synthetic" },
    description: { en: "Synthetic", "zh-Hant": "Synthetic" },
    seo: {
      title: { en: "Synthetic", "zh-Hant": "Synthetic" },
      description: { en: "Synthetic", "zh-Hant": "Synthetic" },
    },
    tags: [],
    imageAssetIds: [],
  };
  await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values (${versionId},${workspaceId},${listingId},1,${admin.json(content)},${actorId})`;
  await admin`update listing_drafts set active_version_id=${versionId} where id=${listingId}`;
  const png = await sharp({
    create: { width: 16, height: 32, channels: 4, background: "#a00000ff" },
  })
    .png()
    .toBuffer();
  const digest = createHash("sha256").update(png).digest("hex");
  async function source() {
    const id = randomUUID(),
      key = `ws/${workspaceId}/sources/${id}/input.png`;
    await store.writeObject(workspaceId, key, png, "image/png");
    await admin`insert into source_assets(id,workspace_id,listing_id,storage_key,kind,metadata) values (${id},${workspaceId},${listingId},${key},'image/png','{}')`;
    return id;
  }
  const sourceAssetId = await source();
  const identity = {
    workspaceId,
    listingId,
    actorId,
    sourceAssetId,
    sourceDigest: digest,
    providerVersion: "fake:1.0.0",
    renderVersion: "white-v1",
    explicitFreshAttempt: false,
  };
  const { attemptId } = await db.forWorkspace(workspaceId, (r) =>
    r.productShots.ensure(identity),
  );
  const claimed = await db.forWorkspace(workspaceId, (r) =>
    r.productShots.claim({ attemptId, dailyLimit: 5, now: new Date() }),
  );
  if (claimed.kind !== "claimed") throw new Error("claim failed");
  const cutoutKey = `ws/${workspaceId}/sources/${attemptId}/cutout.png`;
  await store.writeObject(workspaceId, cutoutKey, png, "image/png");
  await db.forWorkspace(workspaceId, async (r) => {
    const asset = await r.sourceAssets.create({
      storageKey: cutoutKey,
      kind: "image/png",
      metadata: {
        role: "product_shot_cutout",
        attemptId,
        sourceAssetId,
        sourceDigest: digest,
        providerVersion: identity.providerVersion,
        renderVersion: identity.renderVersion,
        digest,
        mimeType: "image/png",
        size: png.length,
      },
    });
    await r.sourceAssets.attachToListing(listingId, [asset.id]);
    await r.productShots.saveCutout({
      attemptId,
      leaseToken: claimed.leaseToken,
      assetId: asset.id,
    });
    await r.reviewConfirmations.upsert({
      listingId,
      versionId,
      sourceImportId: null,
      rowDigest: null,
      fieldConfirmations: Object.fromEntries(
        CONFIRMATION_FIELD_KEYS.map((k) => [k, true]),
      ),
      negativeConfirmations: Object.fromEntries(
        CONFIRMATION_NEGATIVE_KEYS.map((k) => [k, true]),
      ),
    });
  });
  const input = {
    workspaceId,
    listingId,
    actorId,
    attemptId,
    expectedVersionId: versionId,
  };
  const routeDeps = {
    sessionContext: {
      resolve: async () => ({
        workspaceId,
        actorId,
        role: "reviewer" as const,
      }),
    },
    getDatabase: () => db,
  };
  return {
    input,
    identity,
    source,
    routeDeps,
    get: () =>
      db.forWorkspace(workspaceId, (r) =>
        r.productShots.currentForListing(listingId),
      ),
  };
}
const req = (body: unknown) =>
  new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify(body),
  });
it("concurrent real database/private S3 prepares converge on one immutable JPEG", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([
    prepareProductShot(f.input, deps),
    prepareProductShot(f.input, deps),
  ]);
  expect(a.candidateDigest).toBe(b.candidateDigest);
  const current = (await f.get())!;
  expect(current.state).toBe("candidate_ready");
  expect(current.callCount).toBe(1);
  const assets = await db.forWorkspace(f.input.workspaceId, (r) =>
    r.sourceAssets.listForListing(f.input.listingId),
  );
  const candidates = assets.filter(
    (a) => (a.metadata as any).role === "product_shot_candidate",
  );
  expect(candidates).toHaveLength(1);
  const bytes = await store.readObject(
    f.input.workspaceId,
    candidates[0]!.storageKey,
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    a.candidateDigest,
  );
  expect([...bytes.slice(0, 2)]).toEqual([255, 216]);
  expect(
    await admin`select action from audit_events where entity_id=${f.input.listingId} and action='product_shot.candidate_saved'`,
  ).toHaveLength(1);
});
it.each(["single", "bulk"] as const)(
  "%s factual approval requires acceptance then promotes and binds the exact persisted JPEG",
  async (mode) => {
    const f = await fixture();
    const view = await prepareProductShot(f.input, deps);
    const item = {
      listingId: f.input.listingId,
      expectedVersionId: f.input.expectedVersionId,
      confirmationLedgerRevision: 0,
    };
    const single = createApproveListingHandler(f.routeDeps),
      bulk = createBulkApproveHandler(f.routeDeps);
    const invoke = () =>
      mode === "single"
        ? single(req({ ...item, background: "brand" }), {
            params: Promise.resolve({ id: f.input.listingId }),
          })
        : bulk(req({ items: [item] }));
    const blocked = await invoke();
    expect(await blocked.json()).toMatchObject(
      mode === "single"
        ? { code: "image_approval_required" }
        : { approved: 0, results: [{ code: "image_approval_required" }] },
    );
    await approveProductShot(
      { ...f.input, candidateDigest: view.candidateDigest! },
      deps,
    );
    const result = await invoke();
    const body = await result.json();
    expect(result.status).toBe(200);
    const version =
      mode === "single" ? body.versionId : body.results[0].versionId;
    expect(version).not.toBe(f.input.expectedVersionId);
    const current = (await f.get())!;
    const snapshot = await db.forWorkspace(f.input.workspaceId, (r) =>
      r.listings.getReviewSnapshot(f.input.listingId),
    );
    expect(snapshot?.listing.status).toBe("approved");
    expect(snapshot?.activeVersion?.content.imageAssetIds).toEqual([
      current.candidate!.assetId,
    ]);
    expect(
      await db.forWorkspace(f.input.workspaceId, (r) =>
        r.productShots.approvedForAsset({
          listingId: f.input.listingId,
          versionId: version,
          assetId: current.candidate!.assetId,
        }),
      ),
    ).toMatchObject({ candidateDigest: view.candidateDigest });
    expect(current.callCount).toBe(1);
  },
);
it("binding failure rolls back factual promotion and candidate version", async () => {
  const f = await fixture();
  const view = await prepareProductShot(f.input, deps);
  await approveProductShot(
    { ...f.input, candidateDigest: view.candidateDigest! },
    deps,
  );
  const failureDb = {
    forWorkspace: ((ws: string, fn: any) =>
      db.forWorkspace(ws, (r) =>
        fn({
          ...r,
          productShots: {
            ...r.productShots,
            bindApprovedVersion: async () => {
              throw new Error("synthetic binding failure");
            },
          },
        }),
      )) as typeof db.forWorkspace,
  };
  const single = createApproveListingHandler({
    ...f.routeDeps,
    getDatabase: () => failureDb,
  });
  const response = await single(
    req({
      expectedVersionId: f.input.expectedVersionId,
      confirmationLedgerRevision: 0,
    }),
    { params: Promise.resolve({ id: f.input.listingId }) },
  );
  expect(response.status).toBe(500);
  const snapshot = await db.forWorkspace(f.input.workspaceId, (r) =>
    r.listings.getReviewSnapshot(f.input.listingId),
  );
  expect(snapshot?.listing.status).toBe("in_review");
  expect(snapshot?.activeVersion?.id).toBe(f.input.expectedVersionId);
  expect(
    await admin`select id from listing_versions where listing_id=${f.input.listingId}`,
  ).toHaveLength(1);
});
it("source replacement rejects in-flight prepare and preserves historical acceptance URL", async () => {
  const f = await fixture();
  const view = await prepareProductShot(f.input, deps);
  await approveProductShot(
    { ...f.input, candidateDigest: view.candidateDigest! },
    deps,
  );
  const candidate = (await f.get())!.candidate!;
  const before = await db.forWorkspace(f.input.workspaceId, (r) =>
    r.productShots.approvedForAsset({
      listingId: f.input.listingId,
      versionId: f.input.expectedVersionId,
      assetId: candidate.assetId,
    }),
  );
  const other = await f.source();
  const queue = vi.fn(async () => {});
  await requestProductShot(
    { ...f.input, sourceAssetId: other },
    { ...deps, providerName: "fake", enqueue: queue },
  );
  await expect(prepareProductShot(f.input, deps)).rejects.toMatchObject({
    code: "selection_changed",
  });
  expect(
    await db.forWorkspace(f.input.workspaceId, (r) =>
      r.productShots.approvedForAsset({
        listingId: f.input.listingId,
        versionId: f.input.expectedVersionId,
        assetId: candidate.assetId,
      }),
    ),
  ).toMatchObject({
    publicationToken: before!.publicationToken,
    revokedAt: null,
  });
  expect((await readProductShot(f.input, deps)).candidatePreviewUrl).toBeNull();
  await requestProductShot(
    { ...f.input, sourceAssetId: f.identity.sourceAssetId },
    { ...deps, providerName: "fake", enqueue: queue },
  );
  expect((await f.get())!.state).toBe("candidate_ready");
  const single = createApproveListingHandler(f.routeDeps);
  expect(
    (
      await single(
        req({
          expectedVersionId: f.input.expectedVersionId,
          confirmationLedgerRevision: 0,
        }),
        { params: Promise.resolve({ id: f.input.listingId }) },
      )
    ).status,
  ).toBe(409);
  expect(queue).toHaveBeenCalledOnce();
});

it("concurrent explicit fresh actions after unknown outcome create only one queued generation", async () => {
  const f = await fixture();
  const { attemptId } = await db.forWorkspace(f.input.workspaceId, (r) =>
    r.productShots.ensure({ ...f.identity, explicitFreshAttempt: true }),
  );
  const claim = await db.forWorkspace(f.input.workspaceId, (r) =>
    r.productShots.claim({ attemptId, dailyLimit: 5, now: new Date() }),
  );
  if (claim.kind !== "claimed") throw new Error("fixture claim failed");
  await db.forWorkspace(f.input.workspaceId, (r) =>
    r.productShots.finishFailure({
      attemptId,
      leaseToken: claim.leaseToken,
      code: "outcome_unknown",
      unknown: true,
    }),
  );
  const enqueue = vi.fn(async () => {});
  const requestDeps = { ...deps, providerName: "fake" as const, enqueue };
  const ordinary = await requestProductShot(f.input, requestDeps);
  expect(ordinary.state).toBe("outcome_unknown");
  expect(enqueue).not.toHaveBeenCalled();
  const results = await Promise.allSettled([
    requestProductShot({ ...f.input, explicitFreshAttempt: true }, requestDeps),
    requestProductShot({ ...f.input, explicitFreshAttempt: true }, requestDeps),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "fresh_attempt_not_allowed" },
  });
  expect(enqueue).toHaveBeenCalledOnce();
  expect(await f.get()).toMatchObject({
    state: "queued",
    callCount: 0,
    generation: 3,
  });
});
