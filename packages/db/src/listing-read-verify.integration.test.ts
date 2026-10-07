import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuditContext, CanonicalListing } from "@wukong/core";
import { createDatabase, forWorkspace } from "./index.js";
import { verifyListingReads } from "./listing-read-verify.js";

const url = process.env.PRODREC_DATABASE_ADMIN_URL;
const enabled = Boolean(url) && process.env.PRODREC_DISPOSABLE === "yes";

if (enabled) {
  const target = new URL(url!);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.pathname !== "/prod_recovery_test"
  ) {
    throw new Error("Refusing non-isolated production-recovery test target");
  }
}

const workspaceId = "ws_prodrec_reads";
const listingContent: CanonicalListing = {
  sku: "PRODREC-001",
  producer: "Demo Estate",
  productType: "wine",
  country: "Germany",
  region: "Mosel",
  vintage: 2024,
  grapeVarieties: ["Riesling"],
  volumeMl: 750,
  abvPercent: 12.5,
  packQuantity: 1,
  priceHkd: 288,
  stockQuantity: 4,
  criticScores: [],
  awards: [],
  title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" },
  description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" },
  seo: {
    title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" },
    description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" },
  },
  tags: ["Riesling"],
  imageAssetIds: [],
};

describe.skipIf(!enabled)("listing read verifier (disposable Postgres)", () => {
  const admin = postgres(url ?? "postgres://unused@localhost/unused", {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = createDatabase(url ?? "postgres://unused@localhost/unused", {
    migrationUrl: url,
  });

  const contextFor = (listingId: string): AuditContext => ({
    workspaceId,
    actorId: "test:prodrec",
    entityId: listingId,
  });

  async function seedListing(withVersion: boolean): Promise<string> {
    const seeded = await forWorkspace(database, workspaceId, async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const version = withVersion
        ? await repos.listings.appendVersion(
            listing.id,
            listingContent,
            contextFor(listing.id),
            repos.audit,
          )
        : null;
      return { listingId: listing.id, versionId: version?.id ?? null };
    });
    // After commit: the admin connection cannot see the uncommitted listing.
    if (seeded.versionId) {
      const updated =
        await admin`update listing_drafts set active_version_id = ${seeded.versionId} where workspace_id = ${workspaceId} and id = ${seeded.listingId}`;
      expect(updated.count).toBe(1);
    }
    return seeded.listingId;
  }

  const counts = async () => {
    const [row] = await admin`
      select (select count(*) from listing_drafts) as drafts,
             (select count(*) from listing_versions) as versions,
             (select count(*) from audit_events) as audits`;
    return row;
  };

  beforeAll(async () => {
    const [target] = await admin`select current_database() as name`;
    expect(target?.name).toBe("prod_recovery_test");
    await admin.unsafe(
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC",
    );
    await database.migrate();
    await admin`insert into workspaces(id,name,profile) values(${workspaceId},'Prodrec','{}')`;
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it("passes a listing with an active version on the full schema", async () => {
    const listingId = await seedListing(true);
    await expect(
      verifyListingReads(database, [{ workspaceId, listingId }]),
    ).resolves.toEqual({ checked: 1, failures: [] });
  });

  it("treats a listing with no version and no run as healthy", async () => {
    const listingId = await seedListing(false);
    await expect(
      verifyListingReads(database, [{ workspaceId, listingId }]),
    ).resolves.toEqual({ checked: 1, failures: [] });
  });

  it("changes no rows while it reads", async () => {
    const listingId = await seedListing(true);
    const before = await counts();
    await verifyListingReads(database, [{ workspaceId, listingId }]);
    expect(await counts()).toEqual(before);
  });

  it("reports the snapshot read when 0046's column is missing", async () => {
    const listingId = await seedListing(true);
    await admin.unsafe(
      "ALTER TABLE listing_versions DROP COLUMN source_import_id CASCADE",
    );
    const report = await verifyListingReads(database, [
      { workspaceId, listingId },
    ]);
    expect(report.checked).toBe(1);
    expect(report.failures).toContainEqual({
      listingId,
      call: "getReviewSnapshot",
      code: "42703",
    });
  });
});
