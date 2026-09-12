import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import postgres from "postgres";
import { afterAll, expect, it, vi } from "vitest";
import { createDatabase } from "@wukong/db";
import { validateProductShotSource } from "@wukong/assets/product-shot-render";
import { S3AssetStore, readS3RuntimeConfig } from "@wukong/assets";
import {
  prepareProductShot,
  approveProductShot,
  readProductShot,
} from "../../../../../lib/product-shot-service";
import {
  attachProductShotSource,
  requestProductShot,
} from "../../../../../lib/product-shot-request";
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
  db = createDatabase(appUrl, {
    publicImageOrigin: "https://images.example.invalid",
  });
const config = readS3RuntimeConfig(process.env),
  store = S3AssetStore.fromConfig(config.bucket, config.client);
const require = createRequire(import.meta.url),
  sharp = createRequire(require.resolve("@wukong/assets"))("sharp");
// The real decoding validator: these cases run against a real store and a real
// image, so they must exercise the path the product-shot route actually uses.
const deps = {
  forWorkspace: db.forWorkspace,
  assetStore: store,
  validateSource: validateProductShotSource,
};
afterAll(async () => {
  await db.close();
  await admin.end();
});
async function fixture(initializeAttempt = true) {
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
  let attemptId: string = randomUUID();
  if (initializeAttempt) {
    ({ attemptId } = await db.forWorkspace(workspaceId, (r) =>
      r.productShots.ensure(identity),
    ));
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
    });
  }
  await db.forWorkspace(workspaceId, async (r) => {
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

async function createUnattachedPng(workspaceId: string, color = "#0055aaff") {
  const bytes = await sharp({
    create: { width: 18, height: 36, channels: 4, background: color },
  })
    .png()
    .toBuffer();
  const assetId = randomUUID();
  const key = `ws/${workspaceId}/sources/${assetId}/replacement.png`;
  await store.writeObject(workspaceId, key, bytes, "image/png");
  const asset = await db.forWorkspace(workspaceId, (r) =>
    r.sourceAssets.create({
      storageKey: key,
      kind: "image/png",
      metadata: { size: bytes.length, mimeType: "image/png" },
    }),
  );
  return { asset, bytes, key };
}
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

it("real scoped attachment preserves copy and history while selecting only the new image job", async () => {
  const f = await fixture();
  const ready = await prepareProductShot(f.input, deps);
  await approveProductShot(
    { ...f.input, candidateDigest: ready.candidateDigest! },
    deps,
  );
  const previous = (await f.get())!;
  const publication = await db.forWorkspace(f.input.workspaceId, (r) =>
    r.productShots.approvedForAsset({
      listingId: f.input.listingId,
      versionId: f.input.expectedVersionId,
      assetId: previous.candidate!.assetId,
    }),
  );
  const before = await db.forWorkspace(f.input.workspaceId, (r) =>
    r.listings.getReviewSnapshot(f.input.listingId),
  );
  const replacement = await createUnattachedPng(f.input.workspaceId);
  const enqueue = vi.fn(async () => ({ accepted: true as const }));
  const result = await attachProductShotSource(
    {
      workspaceId: f.input.workspaceId,
      listingId: f.input.listingId,
      actorId: f.input.actorId,
      sourceAssetId: replacement.asset.id,
      expectedVersionId: f.input.expectedVersionId,
    },
    {
      forWorkspace: db.forWorkspace,
      requestShot: (input) =>
        requestProductShot(input, {
          ...deps,
          providerName: "fake",
          enqueue,
        }),
    },
  );

  expect(result.state).toBe("queued");
  expect(enqueue).toHaveBeenCalledOnce();
  const selected = (await f.get())!;
  expect(selected).toMatchObject({
    state: "queued",
    sourceAssetId: replacement.asset.id,
    candidate: null,
  });
  const after = await db.forWorkspace(f.input.workspaceId, (r) =>
    r.listings.getReviewSnapshot(f.input.listingId),
  );
  expect(after?.activeVersion).toEqual(before?.activeVersion);
  expect(
    await db.forWorkspace(f.input.workspaceId, (r) =>
      r.productShots.approvedForAsset({
        listingId: f.input.listingId,
        versionId: f.input.expectedVersionId,
        assetId: previous.candidate!.assetId,
      }),
    ),
  ).toMatchObject({
    publicationToken: publication!.publicationToken,
    revokedAt: null,
  });
  expect(
    await db.forWorkspace(f.input.workspaceId, (r) =>
      r.sourceAssets.getByIds([replacement.asset.id]),
    ),
  ).toMatchObject([{ listingId: f.input.listingId }]);
  expect(
    await admin`select action,metadata from audit_events where workspace_id=${f.input.workspaceId} and entity_id=${f.input.listingId} and action='product_shot.source_attached'`,
  ).toMatchObject([
    {
      action: "product_shot.source_attached",
      metadata: { sourceAssetId: replacement.asset.id },
    },
  ]);
});

it("real RLS attachment rejects foreign and stale sources without moving either asset", async () => {
  const f = await fixture(false);
  const local = await createUnattachedPng(f.input.workspaceId);
  const foreignWorkspaceId = "shot_foreign_" + randomUUID();
  await admin`insert into workspaces(id,name,profile) values (${foreignWorkspaceId},'Foreign synthetic','{}')`;
  const foreign = await createUnattachedPng(foreignWorkspaceId, "#990055ff");
  const requestShot = vi.fn(async () => ({ state: "queued" }));
  const input = {
    workspaceId: f.input.workspaceId,
    listingId: f.input.listingId,
    actorId: f.input.actorId,
    expectedVersionId: f.input.expectedVersionId,
  };

  await expect(
    attachProductShotSource(
      { ...input, sourceAssetId: foreign.asset.id },
      { forWorkspace: db.forWorkspace, requestShot },
    ),
  ).rejects.toMatchObject({ code: "source_asset_unavailable" });
  await expect(
    attachProductShotSource(
      {
        ...input,
        sourceAssetId: local.asset.id,
        expectedVersionId: randomUUID(),
      },
      { forWorkspace: db.forWorkspace, requestShot },
    ),
  ).rejects.toMatchObject({ code: "version_conflict" });
  expect(requestShot).not.toHaveBeenCalled();
  expect(
    await db.forWorkspace(f.input.workspaceId, (r) =>
      r.sourceAssets.getByIds([local.asset.id]),
    ),
  ).toMatchObject([{ listingId: null }]);
  expect(
    await db.forWorkspace(foreignWorkspaceId, (r) =>
      r.sourceAssets.getByIds([foreign.asset.id]),
    ),
  ).toMatchObject([{ listingId: null }]);
});

it("real attachment fails closed while publishing", async () => {
  const f = await fixture(false);
  const replacement = await createUnattachedPng(f.input.workspaceId);
  await admin`update listing_drafts set status='publishing' where workspace_id=${f.input.workspaceId} and id=${f.input.listingId}`;
  const requestShot = vi.fn(async () => ({ state: "queued" }));
  await expect(
    attachProductShotSource(
      {
        workspaceId: f.input.workspaceId,
        listingId: f.input.listingId,
        actorId: f.input.actorId,
        sourceAssetId: replacement.asset.id,
        expectedVersionId: f.input.expectedVersionId,
      },
      { forWorkspace: db.forWorkspace, requestShot },
    ),
  ).rejects.toMatchObject({ code: "listing_publishing" });
  expect(requestShot).not.toHaveBeenCalled();
  expect(
    await db.forWorkspace(f.input.workspaceId, (r) =>
      r.sourceAssets.getByIds([replacement.asset.id]),
    ),
  ).toMatchObject([{ listingId: null }]);
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

it.each(["single", "bulk"] as const)(
  "%s real approval blocks multiple originals before any attempt exists",
  async (mode) => {
    vi.stubEnv("PRODUCT_SHOT_PROVIDER", "fake");
    try {
      const f = await fixture(false);
      await f.source();
      expect(await f.get()).toBeNull();
      const item = {
        listingId: f.input.listingId,
        expectedVersionId: f.input.expectedVersionId,
        confirmationLedgerRevision: 0,
      };
      const response =
        mode === "single"
          ? await createApproveListingHandler(f.routeDeps)(req(item), {
              params: Promise.resolve({ id: f.input.listingId }),
            })
          : await createBulkApproveHandler(f.routeDeps)(req({ items: [item] }));
      expect(await response.json()).toMatchObject(
        mode === "single"
          ? { code: "image_approval_required" }
          : {
              approved: 0,
              failed: 1,
              results: [{ code: "image_approval_required" }],
            },
      );
      const snapshot = await db.forWorkspace(f.input.workspaceId, (r) =>
        r.listings.getReviewSnapshot(f.input.listingId),
      );
      expect(snapshot?.listing.status).toBe("in_review");
      expect(snapshot?.activeVersion?.id).toBe(f.input.expectedVersionId);
      expect(
        await admin`select id from audit_events where entity_id=${f.input.listingId} and action='listing.approved'`,
      ).toHaveLength(0);
      expect(await f.get()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
