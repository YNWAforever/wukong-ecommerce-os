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
const workspaceId = "ws_edit_review";

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
const editedContent: CanonicalListing = {
  ...listingContent,
  title: {
    en: "Demo Estate Riesling Kabinett",
    "zh-Hant": "Demo Estate Riesling Kabinett",
  },
};

/**
 * `editReview` used to default every unhandled status to `in_review`. That let a
 * reviewer's Save land while a SHOPLINE delivery was already in flight, which
 * both skips the workflow state machine and orphans the remote product.
 */
describe("listing review edits guard in-flight states", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });
  // Repositories and audit writers are bound to one workspace scope, so each
  // test builds them inside the scope it uses. Only the context is plain data.
  const contextFor = (listingId: string): AuditContext => ({
    workspaceId,
    actorId: "test:edit-review",
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

  async function seedListing(
    status: string,
  ): Promise<{ listingId: string; versionId: string }> {
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
    await admin`update listing_drafts set status = ${status}::listing_status, active_version_id = ${created.versionId} where workspace_id = ${workspaceId} and id = ${created.listingId}`;
    return created;
  }

  /**
   * A blocking compliance flag must not be erasable by an ordinary Save.
   *
   * Flags are stored against the version they were raised on, and every edit
   * appends a new version. `approveListing` refuses only on an OPEN BLOCKING
   * flag it can see (`packages/core/src/review.ts`), and it reads them off the
   * ACTIVE version -- so an edit that carried nothing forward left the new
   * version with an empty flag set and the gate simply opened. The edit did not
   * even have to touch the flagged field.
   *
   * `listing-approval.ts` already calls `replaceFlags(newVersion.id,
   * snapshot.flags)` wherever it appends a version. This path was the one that
   * did not.
   */
  it("carries compliance flags onto the version an edit creates", async () => {
    const { listingId, versionId } = await seedListing("in_review");
    await admin`insert into compliance_flags (workspace_id, listing_version_id, code, severity, status, details) values (${workspaceId}, ${versionId}, 'rating_without_evidence', 'blocking', 'open', ${admin.json({ id: "flag_1", field: "description" })})`;

    const version = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.editReview(
        listingId,
        versionId,
        editedContent,
        ["title"],
        contextFor(listingId),
        repos.audit,
      ),
    );

    const carried =
      await admin`select code, severity, status, details from compliance_flags where workspace_id = ${workspaceId} and listing_version_id = ${version.id}`;
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({
      code: "rating_without_evidence",
      severity: "blocking",
      status: "open",
    });
    // The gate reads from the active version, so this is what approval sees.
    const snapshot = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getReviewSnapshot(listingId),
    );
    expect(snapshot?.flags).toHaveLength(1);
    expect(snapshot?.flags[0]).toMatchObject({
      severity: "blocking",
      status: "open",
    });
  });

  it("keeps a resolved flag resolved rather than reopening it", async () => {
    // Carrying must not lose the resolution either: re-raising a flag an
    // operator has already answered would block a listing they had cleared.
    const { listingId, versionId } = await seedListing("in_review");
    await admin`insert into compliance_flags (workspace_id, listing_version_id, code, severity, status, details, resolved_at) values (${workspaceId}, ${versionId}, 'rating_without_evidence', 'blocking', 'resolved', ${admin.json({ id: "flag_2", field: "description", resolutionReason: "Score verified against the importer sheet." })}, now())`;

    const version = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.editReview(
        listingId,
        versionId,
        editedContent,
        ["title"],
        contextFor(listingId),
        repos.audit,
      ),
    );

    const carried =
      await admin`select status, details from compliance_flags where workspace_id = ${workspaceId} and listing_version_id = ${version.id}`;
    expect(carried[0]?.status).toBe("resolved");
    expect(
      (carried[0]?.details as { resolutionReason?: string })?.resolutionReason,
    ).toBe("Score verified against the importer sheet.");
  });

  it("refuses an edit while a SHOPLINE delivery is in flight", async () => {
    const { listingId, versionId } = await seedListing("publishing");

    await expect(
      forWorkspace(database, workspaceId, (repos) =>
        repos.listings.editReview(
          listingId,
          versionId,
          editedContent,
          ["title"],
          contextFor(listingId),
          repos.audit,
        ),
      ),
    ).rejects.toThrow("listing is publishing");

    const after = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getById(listingId),
    );
    expect(after?.status).toBe("publishing");
    expect(after?.activeVersionId).toBe(versionId);
  });

  it("refuses an edit while the worker owns the listing", async () => {
    const { listingId, versionId } = await seedListing("processing");

    await expect(
      forWorkspace(database, workspaceId, (repos) =>
        repos.listings.editReview(
          listingId,
          versionId,
          editedContent,
          ["title"],
          contextFor(listingId),
          repos.audit,
        ),
      ),
    ).rejects.toThrow("listing is processing");
  });

  it("still reopens an approved listing so ordinary review edits keep working", async () => {
    const { listingId, versionId } = await seedListing("approved");

    const version = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.editReview(
        listingId,
        versionId,
        editedContent,
        ["title"],
        contextFor(listingId),
        repos.audit,
      ),
    );

    const after = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getById(listingId),
    );
    expect(after?.status).toBe("reopened");
    expect(after?.activeVersionId).toBe(version.id);
  });

  it("reopens rather than re-reviews after a failed publish", async () => {
    const { listingId, versionId } = await seedListing("publish_failed");

    await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.editReview(
        listingId,
        versionId,
        editedContent,
        ["title"],
        contextFor(listingId),
        repos.audit,
      ),
    );

    const after = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getById(listingId),
    );
    expect(after?.status).toBe("reopened");
  });

  it.each(["approved", "published", "publish_failed"])(
    "reopens %s when its current confirmation ledger changes",
    async (status) => {
      const { listingId, versionId } = await seedListing(status);
      const result = await forWorkspace(database, workspaceId, (repos) =>
        repos.listings.invalidateApprovalForConfirmationChange(
          listingId,
          versionId,
          contextFor(listingId),
          repos.audit,
        ),
      );
      const after = await forWorkspace(database, workspaceId, (repos) =>
        repos.listings.getById(listingId),
      );
      expect(result).toBe("reopened");
      expect(after?.status).toBe("reopened");
      expect(after?.activeVersionId).toBe(versionId);
    },
  );

  it("fails closed while publishing and keeps the in-flight status", async () => {
    const { listingId, versionId } = await seedListing("publishing");
    const result = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.invalidateApprovalForConfirmationChange(
        listingId,
        versionId,
        contextFor(listingId),
        repos.audit,
      ),
    );
    const after = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getById(listingId),
    );
    expect(result).toBe("publishing");
    expect(after?.status).toBe("publishing");
  });

  it("rejects a confirmation write observed against a superseded version", async () => {
    const { listingId } = await seedListing("approved");
    await expect(
      forWorkspace(database, workspaceId, (repos) =>
        repos.listings.invalidateApprovalForConfirmationChange(
          listingId,
          "00000000-0000-4000-8000-000000000999",
          contextFor(listingId),
          repos.audit,
        ),
      ),
    ).resolves.toBe("stale");
  });
});
