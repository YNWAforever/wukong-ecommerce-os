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
const workspaceId = "ws_promote_approve";

const listingContent: CanonicalListing = {
  sku: "OPAK-001",
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

describe("promoteAndApprove", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });
  const contextFor = (listingId: string): AuditContext => ({
    workspaceId,
    actorId: "test:promote-approve",
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

  async function seedInReview(): Promise<{
    listingId: string;
    activeVersionId: string;
  }> {
    const created = await forWorkspace(database, workspaceId, async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const version = await repos.listings.appendVersion(
        listing.id,
        listingContent,
        contextFor(listing.id),
        repos.audit,
      );
      return { listingId: listing.id, versionId: version.id };
    });
    await admin`update listing_drafts set status = 'in_review', active_version_id = ${created.versionId} where workspace_id = ${workspaceId} and id = ${created.listingId}`;
    return { listingId: created.listingId, activeVersionId: created.versionId };
  }

  async function seedReopened(): Promise<{
    listingId: string;
    activeVersionId: string;
  }> {
    const created = await forWorkspace(database, workspaceId, async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const version = await repos.listings.appendVersion(
        listing.id,
        listingContent,
        contextFor(listing.id),
        repos.audit,
      );
      return { listingId: listing.id, versionId: version.id };
    });
    await admin`update listing_drafts set status = 'reopened', active_version_id = ${created.versionId} where workspace_id = ${workspaceId} and id = ${created.listingId}`;
    return { listingId: created.listingId, activeVersionId: created.versionId };
  }

  it("promotes a freshly-appended version to active and approves it in one step", async () => {
    const { listingId, activeVersionId } = await seedInReview();
    const newVersion = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.appendVersion(
        listingId,
        { ...listingContent, imageAssetIds: ["asset_flattened_1"] },
        contextFor(listingId),
        repos.audit,
      ),
    );

    await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.promoteAndApprove(
        listingId,
        activeVersionId,
        newVersion.id,
        contextFor(listingId),
        repos.audit,
      ),
    );

    const after = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getById(listingId),
    );
    expect(after?.status).toBe("approved");
    expect(after?.activeVersionId).toBe(newVersion.id);
  });

  it("refuses when the active version has changed since baseVersionId was read", async () => {
    const { listingId } = await seedInReview();
    const staleVersionId = "00000000-0000-4000-8000-000000000099";
    // A genuinely fresh, never-active version -- distinct from the currently
    // active one, so this doesn't collide with the `activeVersionId ===
    // newVersionId` no-op short circuit and actually exercises staleness.
    const newVersion = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.appendVersion(
        listingId,
        listingContent,
        contextFor(listingId),
        repos.audit,
      ),
    );

    await expect(
      forWorkspace(database, workspaceId, (repos) =>
        repos.listings.promoteAndApprove(
          listingId,
          staleVersionId,
          newVersion.id,
          contextFor(listingId),
          repos.audit,
        ),
      ),
    ).rejects.toThrow("active listing version changed");

    const after = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getById(listingId),
    );
    expect(after?.status).toBe("in_review");
  });

  it("writes a listing.approved audit event with the new version's id", async () => {
    const { listingId, activeVersionId } = await seedInReview();
    const newVersion = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.appendVersion(
        listingId,
        listingContent,
        contextFor(listingId),
        repos.audit,
      ),
    );

    await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.promoteAndApprove(
        listingId,
        activeVersionId,
        newVersion.id,
        contextFor(listingId),
        repos.audit,
      ),
    );

    const events =
      await admin`select action, metadata from audit_events where workspace_id = ${workspaceId} and action = 'listing.approved' order by created_at desc limit 1`;
    expect(events[0]?.metadata).toMatchObject({ versionId: newVersion.id });
  });

  /**
   * `editReview` puts an approved listing back into `reopened` on a review
   * edit, so "edit an already-approved listing, then re-approve" lands here
   * with a true starting status of `reopened`. The guarded UPDATE used to
   * check the WHERE clause against the *projected* intermediate status
   * (`in_review`) rather than the row's actual persisted status, so this
   * always failed with zero rows matched -- unconditionally, not just under
   * concurrent interference.
   */
  it("promotes and approves from a reopened listing", async () => {
    const { listingId, activeVersionId } = await seedReopened();
    const newVersion = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.appendVersion(
        listingId,
        { ...listingContent, imageAssetIds: ["asset_flattened_2"] },
        contextFor(listingId),
        repos.audit,
      ),
    );

    await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.promoteAndApprove(
        listingId,
        activeVersionId,
        newVersion.id,
        contextFor(listingId),
        repos.audit,
      ),
    );

    const after = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getById(listingId),
    );
    expect(after?.status).toBe("approved");
    expect(after?.activeVersionId).toBe(newVersion.id);
  });

  it("is a safe no-op when retried with the same base and new version", async () => {
    const { listingId, activeVersionId } = await seedInReview();
    const newVersion = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.appendVersion(
        listingId,
        listingContent,
        contextFor(listingId),
        repos.audit,
      ),
    );

    await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.promoteAndApprove(
        listingId,
        activeVersionId,
        newVersion.id,
        contextFor(listingId),
        repos.audit,
      ),
    );

    // The real retry shape: the exact same call repeated, with the original
    // (now-stale) baseVersionId still in hand -- not a caller that re-reads
    // current state first. The `activeVersionId === newVersionId` short
    // circuit must fire before the baseVersionId staleness check does.
    await expect(
      forWorkspace(database, workspaceId, (repos) =>
        repos.listings.promoteAndApprove(
          listingId,
          activeVersionId,
          newVersion.id,
          contextFor(listingId),
          repos.audit,
        ),
      ),
    ).resolves.toBeUndefined();

    const after = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getById(listingId),
    );
    expect(after?.status).toBe("approved");
    expect(after?.activeVersionId).toBe(newVersion.id);
  });

  it("re-approves an already-approved listing by promoting a different version", async () => {
    const { listingId, activeVersionId } = await seedInReview();
    const firstVersion = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.appendVersion(
        listingId,
        { ...listingContent, imageAssetIds: ["asset_flattened_1"] },
        contextFor(listingId),
        repos.audit,
      ),
    );
    await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.promoteAndApprove(
        listingId,
        activeVersionId,
        firstVersion.id,
        contextFor(listingId),
        repos.audit,
      ),
    );

    // Listing is now `approved` with `firstVersion` active. Re-approving with
    // a different background choice mints a brand new version and calls
    // promoteAndApprove again -- baseVersionId here is the already-approved
    // active version, not one still in `in_review`.
    const secondVersion = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.appendVersion(
        listingId,
        { ...listingContent, imageAssetIds: ["asset_flattened_2"] },
        contextFor(listingId),
        repos.audit,
      ),
    );

    await expect(
      forWorkspace(database, workspaceId, (repos) =>
        repos.listings.promoteAndApprove(
          listingId,
          firstVersion.id,
          secondVersion.id,
          contextFor(listingId),
          repos.audit,
        ),
      ),
    ).resolves.toBeUndefined();

    const after = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getById(listingId),
    );
    expect(after?.status).toBe("approved");
    expect(after?.activeVersionId).toBe(secondVersion.id);

    const events =
      await admin`select action, metadata from audit_events where workspace_id = ${workspaceId} and action = 'listing.approved' order by created_at desc limit 1`;
    expect(events[0]?.metadata).toMatchObject({ versionId: secondVersion.id });
  });

  it("lets exactly one of two concurrent promotions win", async () => {
    const { listingId, activeVersionId } = await seedInReview();
    const [candidateA, candidateB] = await forWorkspace(
      database,
      workspaceId,
      async (repos) => {
        const a = await repos.listings.appendVersion(
          listingId,
          { ...listingContent, imageAssetIds: ["asset_flattened_a"] },
          contextFor(listingId),
          repos.audit,
        );
        const b = await repos.listings.appendVersion(
          listingId,
          { ...listingContent, imageAssetIds: ["asset_flattened_b"] },
          contextFor(listingId),
          repos.audit,
        );
        return [a, b];
      },
    );

    // Separate transactions, in flight at the same time: the guarded UPDATE
    // is the only thing standing between them and both promotions landing.
    const [first, second] = await Promise.allSettled([
      forWorkspace(database, workspaceId, (repos) =>
        repos.listings.promoteAndApprove(
          listingId,
          activeVersionId,
          candidateA.id,
          contextFor(listingId),
          repos.audit,
        ),
      ),
      forWorkspace(database, workspaceId, (repos) =>
        repos.listings.promoteAndApprove(
          listingId,
          activeVersionId,
          candidateB.id,
          contextFor(listingId),
          repos.audit,
        ),
      ),
    ]);

    const outcomes = [first, second];
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const after = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getById(listingId),
    );
    expect(after?.status).toBe("approved");
    expect([candidateA.id, candidateB.id]).toContain(after?.activeVersionId);
  });
});
