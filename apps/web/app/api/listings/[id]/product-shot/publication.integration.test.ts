import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
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
  db = createDatabase(appUrl, {
    migrationUrl: adminUrl,
    publicImageOrigin: "https://images.example.invalid",
  });
const config = readS3RuntimeConfig(process.env),
  store = S3AssetStore.fromConfig(config.bucket, config.client);
const require = createRequire(import.meta.url),
  sharp = createRequire(require.resolve("@wukong/assets"))("sharp");
const deps = { forWorkspace: db.forWorkspace, assetStore: store };
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

import { createPublishedImageHandler } from "../../../../../lib/product-image-publication";
import { createApproveProductShotHandler } from "./approve/route";
import {
  resolveListingImageUrls,
  ASSET_EXPORT_READ_TTL_MS,
} from "@wukong/assets";
beforeAll(() => db.migrate());
const publicHandler = createPublishedImageHandler({
  lookupPublishedImage: db.lookupPublishedImage,
  readObject: (workspaceId, key) => store.readObject(workspaceId, key),
});
const requestImage = (token: string, method = "GET") =>
  publicHandler(
    new Request("https://localhost/product-images/" + token + ".jpg", {
      method,
    }),
    { params: Promise.resolve({ file: token + ".jpg" }) },
  );
it("serves exact historical final JPEGs beyond signing TTL and revokes new exports", async () => {
  const f = await fixture();
  const view = await prepareProductShot(f.input, deps);
  const image = (await f.get())!.candidate!;
  const resolve = () =>
    db.forWorkspace(f.input.workspaceId, async (r) =>
      resolveListingImageUrls({
        workspaceId: f.input.workspaceId,
        draftId: f.input.listingId,
        imageAssetIds: [image.assetId],
        sourceAssets: r.sourceAssets,
        assetStore: store,
        publication: {
          versionId: f.input.expectedVersionId,
          resolveApprovedProductImage: (value) =>
            r.productShots.resolveApprovedProductImage(value),
        },
      }),
    );
  await expect(resolve()).rejects.toThrow("image_approval_required");
  const original = await db.forWorkspace(f.input.workspaceId, (r) =>
    r.productShots.approve({
      ...f.input,
      candidateDigest: view.candidateDigest!,
    }),
  );
  await expect(resolve()).rejects.toThrow("image_approval_required");
  const approve = createApproveListingHandler(f.routeDeps);
  const response = await approve(
    new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        expectedVersionId: f.input.expectedVersionId,
        confirmationLedgerRevision: 0,
      }),
    }),
    { params: Promise.resolve({ id: f.input.listingId }) },
  );
  expect(response.status).toBe(200);
  const promotedVersion = (await response.json()).versionId;
  const published = await db.forWorkspace(f.input.workspaceId, (r) =>
    r.productShots.approvedForAsset({
      listingId: f.input.listingId,
      versionId: promotedVersion,
      assetId: image.assetId,
    }),
  );
  expect(published!.publicationToken).not.toBe(original.publicationToken);
  const date = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.now() + ASSET_EXPORT_READ_TTL_MS + 86400000);
  try {
    for (const token of [
      original.publicationToken,
      published!.publicationToken,
    ])
      for (const method of ["GET", "HEAD"]) {
        const r = await requestImage(token, method);
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toBe("image/jpeg");
        expect(r.headers.get("cache-control")).toBe("no-store");
        expect(r.headers.get("x-content-type-options")).toBe("nosniff");
        expect(r.headers.get("location")).toBeNull();
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (method === "GET")
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(
            image.digest,
          );
        else expect(bytes.byteLength).toBe(0);
      }
  } finally {
    date.mockRestore();
  }
  expect(
    await db.forWorkspace(f.input.workspaceId, (r) =>
      r.productShots.resolveApprovedProductImage({
        workspaceId: f.input.workspaceId,
        listingId: f.input.listingId,
        versionId: promotedVersion,
        assetId: image.assetId,
      }),
    ),
  ).toBe(published!.publicUrl);
  const newSource = await f.source();
  await db.forWorkspace(f.input.workspaceId, (r) =>
    r.productShots.ensure({ ...f.identity, sourceAssetId: newSource }),
  );
  await expect(
    db.forWorkspace(f.input.workspaceId, (r) =>
      r.productShots.resolveApprovedProductImage({
        workspaceId: f.input.workspaceId,
        listingId: f.input.listingId,
        versionId: promotedVersion,
        assetId: image.assetId,
      }),
    ),
  ).rejects.toThrow("image_approval_required");
  expect((await requestImage(published!.publicationToken)).status).toBe(200);
  await db.forWorkspace(f.input.workspaceId, (r) =>
    r.productShots.revoke({
      publicationToken: published!.publicationToken,
      actorId: f.input.actorId,
    }),
  );
  expect((await requestImage(published!.publicationToken)).status).toBe(404);
  expect((await requestImage(original.publicationToken)).status).toBe(200);
  expect((await requestImage("x".repeat(43))).status).toBe(404);
});

it("adjacent product-shot approval still requires a server session", async () => {
  const getDatabase = vi.fn(),
    getAssetStore = vi.fn();
  const route = createApproveProductShotHandler({
    sessionContext: { resolve: async () => null },
    getDatabase,
    getAssetStore,
  });
  expect(
    (
      await route(
        new Request(
          "https://localhost/api/listings/" +
            randomUUID() +
            "/product-shot/approve",
          { method: "POST", body: "{}" },
        ),
        { params: Promise.resolve({ id: randomUUID() }) },
      )
    ).status,
  ).toBe(401);
  expect(getDatabase).not.toHaveBeenCalled();
  expect(getAssetStore).not.toHaveBeenCalled();
});

import { createCloudflareRuntime } from "../../../../../../worker/src/cloudflare-runtime";
import { consumeShoplineMessage } from "../../../../../../worker/src/shopline-consumer";
import {
  hashCanonicalListing,
  shoplinePublishIdempotencyKey,
  type CommerceConnector,
} from "@wukong/shopline";
import type { Database, WorkspaceRepositories } from "@wukong/db";

async function queuedImageFixture() {
  const f = await fixture();
  const view = await prepareProductShot(f.input, deps);
  await approveProductShot(
    { ...f.input, candidateDigest: view.candidateDigest! },
    deps,
  );
  const response = await createApproveListingHandler(f.routeDeps)(
    new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        expectedVersionId: f.input.expectedVersionId,
        confirmationLedgerRevision: 0,
      }),
    }),
    { params: Promise.resolve({ id: f.input.listingId }) },
  );
  expect(response.status).toBe(200);
  const versionId = (await response.json()).versionId as string;
  const connectionId = randomUUID();
  await admin`insert into shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) values (${connectionId},${f.input.workspaceId},'synthetic.invalid','synthetic-only')`;
  const key = shoplinePublishIdempotencyKey(
    f.input.workspaceId,
    versionId,
    "create",
  );
  const candidate = (await f.get())!.candidate!;
  const publication = await db.forWorkspace(f.input.workspaceId, async (r) => {
    const listing = await r.listings.requireForPublish(f.input.listingId);
    await r.publishJobs.ensure({
      listingId: f.input.listingId,
      versionId,
      connectionId,
      idempotencyKey: key,
      payloadDigest: hashCanonicalListing(listing.activeVersion!.content),
    });
    await r.publishJobs.markQueued(key);
    return r.productShots.approvedForAsset({
      listingId: f.input.listingId,
      versionId,
      assetId: candidate.assetId,
    });
  });
  const replacement = await f.source();
  const change = (kind: string) =>
    db.forWorkspace(f.input.workspaceId, async (r) => {
      if (kind === "selection")
        await r.productShots.ensure({
          ...f.identity,
          sourceAssetId: replacement,
        });
      else
        await r.productShots.revoke({
          publicationToken: publication!.publicationToken,
          actorId: f.input.actorId,
        });
    });
  return {
    f,
    key,
    change,
    job: {
      workspaceId: f.input.workspaceId,
      draftId: f.input.listingId,
      versionId,
      connectionId,
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fakePublishConnector() {
  return {
    verifyConnection: vi.fn(async () => ({ merchantId: "synthetic" })),
    createProduct: vi.fn(async () => ({ remoteProductId: "synthetic-remote" })),
    updateProduct: vi.fn(async () => {}),
    getProductStatus: vi.fn(async () => ({ exists: false, status: null })),
  } satisfies CommerceConnector;
}
it.each(["selection", "revocation"])(
  "holds the real worker publication lock through its publish claim against %s",
  async (kind) => {
    const x = await queuedImageFixture();
    const reached = deferred(),
      release = deferred();
    let resolved = false,
      paused = false,
      changed = false;
    const database = {
      forWorkspace: <T>(
        ws: string,
        work: (r: WorkspaceRepositories) => Promise<T>,
      ) =>
        db.forWorkspace(ws, (r) =>
          work({
            ...r,
            shoplineConnections: {
              ...r.shoplineConnections,
              async getById(id: string) {
                if (resolved && !paused) {
                  paused = true;
                  reached.resolve();
                  await release.promise;
                }
                return r.shoplineConnections.getById(id);
              },
            },
          }),
        ),
      close: async () => {},
    } as Database;
    const runtime = createCloudflareRuntime(
      { AI_PROVIDER: "fake", PRODUCT_SHOT_PROVIDER: "fake" } as never,
      {
        databaseFactory: () => database,
        assetStoreFactory: () => store,
        providerFactory: () => ({}) as never,
      },
    );
    const connector = fakePublishConnector();
    const publishing = consumeShoplineMessage(x.job, {} as never, {
      createRuntime: () => ({
        ...runtime,
        async resolveImageUrls(
          ...args: Parameters<typeof runtime.resolveImageUrls>
        ) {
          const urls = await runtime.resolveImageUrls(...args);
          resolved = true;
          return urls;
        },
      }),
      connectorFactory: async () => connector,
    });
    await Promise.race([
      reached.promise,
      publishing.then(() => {
        throw new Error("Worker completed before the preparation barrier");
      }),
    ]);
    const mutation = x.change(kind).then(() => {
      changed = true;
    });
    let observed = "pending";
    try {
      await expect
        .poll(async () => {
          const waits =
            await admin`select pid from pg_stat_activity where datname=current_database() and cardinality(pg_blocking_pids(pid)) > 0`;
          observed = changed
            ? "committed"
            : waits.length
              ? "blocked"
              : "pending";
          return observed;
        })
        .not.toBe("pending");
      expect(observed).toBe("blocked");
      expect(connector.createProduct).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([publishing, mutation]);
    }
    expect(connector.createProduct).toHaveBeenCalledOnce();
    expect(
      await db.forWorkspace(x.job.workspaceId, (r) =>
        r.publishJobs.getByIdempotencyKey(x.key),
      ),
    ).toMatchObject({ status: "published", leaseToken: null });
  },
);
it.each(["selection", "revocation"])(
  "rejects %s committed before worker publication preparation without a connector call",
  async (kind) => {
    const x = await queuedImageFixture();
    await x.change(kind);
    const runtime = createCloudflareRuntime(
      { AI_PROVIDER: "fake", PRODUCT_SHOT_PROVIDER: "fake" } as never,
      {
        databaseFactory: () =>
          ({
            forWorkspace: db.forWorkspace,
            close: async () => {},
          }) as Database,
        assetStoreFactory: () => store,
        providerFactory: () => ({}) as never,
      },
    );
    const connector = fakePublishConnector();
    expect(
      await consumeShoplineMessage(x.job, {} as never, {
        createRuntime: () => runtime,
        connectorFactory: async () => connector,
      }),
    ).toBe("ack");
    expect(connector.createProduct).not.toHaveBeenCalled();
    const job = await db.forWorkspace(x.job.workspaceId, (r) =>
      r.publishJobs.getByIdempotencyKey(x.key),
    );
    expect(job).toMatchObject({
      status: "failed",
      error: "not_approved",
      leaseToken: null,
    });
  },
);
