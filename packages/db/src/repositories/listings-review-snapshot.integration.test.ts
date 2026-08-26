import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuditContext, CanonicalListing } from "@wukong/core";
import { createDatabase, forWorkspace } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const workspaceId = "ws_review_snapshot";

/**
 * A listing under active review -- AI extraction has produced a version,
 * but some commercial facts (SKU, price, etc.) are still null pending
 * enrichment or manual entry -- is a completely normal, expected state.
 * The cast is deliberate: this is exactly the shape production data takes
 * before review is complete, which the CanonicalListing type claims can't
 * happen.
 */
const incompleteContent = {
  sku: null,
  producer: null,
  productType: null,
  country: null,
  region: null,
  vintage: null,
  grapeVarieties: [],
  volumeMl: null,
  abvPercent: null,
  packQuantity: 1,
  priceHkd: null,
  stockQuantity: null,
  criticScores: [],
  awards: [],
  title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" },
  description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" },
  seo: {
    title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" },
    description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" },
  },
  tags: [],
  imageAssetIds: [],
} as unknown as CanonicalListing;

describe("getReviewSnapshot on a listing with incomplete facts", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });
  const contextFor = (listingId: string): AuditContext => ({
    workspaceId,
    actorId: "test:review-snapshot",
    entityId: listingId,
  });

  beforeAll(async () => {
    await admin.unsafe(
      "DO $role$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END $role$;",
    );
    await database.migrate();
    await admin.unsafe(`DELETE FROM workspaces WHERE id = '${workspaceId}'`);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  async function seedIncompleteListing(): Promise<{
    listingId: string;
    versionId: string;
  }> {
    const created = await forWorkspace(database, workspaceId, async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const version = await repos.listings.appendVersion(
        listing.id,
        incompleteContent,
        contextFor(listing.id),
        repos.audit,
      );
      return { listingId: listing.id, versionId: version.id };
    });
    await admin`update listing_drafts set status = 'in_review'::listing_status, active_version_id = ${created.versionId} where workspace_id = ${workspaceId} and id = ${created.listingId}`;
    return created;
  }

  it("returns the snapshot instead of throwing", async () => {
    const { listingId } = await seedIncompleteListing();

    const snapshot = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getReviewSnapshot(listingId),
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.activeVersion?.content.sku).toBeNull();
    expect(snapshot?.activeVersion?.content.producer).toBeNull();
    expect(snapshot?.activeVersion?.content.title.en).toBe(
      "Demo Estate Riesling",
    );
  });

  it("still lets requireForPublish reject the same incomplete listing", async () => {
    const { listingId } = await seedIncompleteListing();

    await expect(
      forWorkspace(database, workspaceId, (repos) =>
        repos.listings.requireForPublish(listingId),
      ),
    ).rejects.toThrow("active listing version content is invalid");
  });
});
