import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuditContext, CanonicalListing } from "@wukong/core";

import { createDatabase, type WorkspaceRepositories } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const ignoreNotice = (): void => undefined;

const workspaceId = "ws_review_confirmations";
const otherWorkspaceId = "ws_review_confirmations_other";

const listingContent: CanonicalListing = {
  sku: "OPAK-001",
  producer: "Opak",
  productType: "wine",
  country: "Germany",
  region: "Mosel",
  vintage: 2024,
  grapeVarieties: ["Riesling"],
  volumeMl: 750,
  abvPercent: 12.5,
  packQuantity: 1,
  priceHkd: 288,
  stockQuantity: null,
  criticScores: [],
  awards: [],
  title: { en: "Opak Riesling", "zh-Hant": "Opak 雷司令" },
  description: { en: "Dry wine", "zh-Hant": "乾身葡萄酒" },
  seo: {
    title: { en: "Opak Riesling", "zh-Hant": "Opak 雷司令" },
    description: { en: "Dry wine", "zh-Hant": "乾身葡萄酒" },
  },
  tags: ["wine"],
  imageAssetIds: [],
};

describe("review confirmations repository", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: ignoreNotice,
    prepare: false,
  });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });

  beforeAll(async () => {
    await admin.unsafe(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN
          CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
        END IF;
      END
      $role$;
    `);
    await database.migrate();
    await admin.unsafe("TRUNCATE TABLE workspaces, users CASCADE");
    await admin.unsafe(`
      INSERT INTO workspaces (id, name, profile) VALUES
        ('${workspaceId}', '${workspaceId}', '{}'::jsonb),
        ('${otherWorkspaceId}', '${otherWorkspaceId}', '{}'::jsonb);
    `);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  // review_confirmations has composite FKs to both listing_drafts and
  // listing_versions, so a test row needs a real draft and a real version --
  // a bare made-up UUID would raise a foreign-key violation on insert.
  const createDraftAndVersion = async (
    repositories: WorkspaceRepositories,
    scopedWorkspaceId: string,
  ) => {
    const listing = await repositories.listings.create({
      target: "shopline",
      note: null,
    });
    const context: AuditContext = {
      workspaceId: scopedWorkspaceId,
      actorId: "test:review-confirmations",
      entityId: listing.id,
    };
    const version = await repositories.listings.appendVersion(
      listing.id,
      listingContent,
      context,
      repositories.audit,
    );
    return { listingId: listing.id, versionId: version.id };
  };

  const upsertInputFor = (listingId: string, versionId: string) => ({
    listingId,
    versionId,
    fieldConfirmations: { nameZh: true, seoTitleEn: false },
    negativeConfirmations: { priceUnchanged: true, noImageChange: false },
    sourceImportId: null,
    rowDigest: null,
  });

  it("creates a confirmation, reads it back, and increments revision on upsert", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const { listingId, versionId } = await createDraftAndVersion(
        repositories,
        workspaceId,
      );

      const created = await repositories.reviewConfirmations.upsert(
        upsertInputFor(listingId, versionId),
      );
      expect(created.revision).toBe(0);
      expect(created.fieldConfirmations).toEqual({
        nameZh: true,
        seoTitleEn: false,
      });

      const updated = await repositories.reviewConfirmations.upsert({
        ...upsertInputFor(listingId, versionId),
        fieldConfirmations: { nameZh: true, seoTitleEn: true },
      });
      expect(updated.revision).toBe(1);
      expect(updated.fieldConfirmations).toEqual({
        nameZh: true,
        seoTitleEn: true,
      });

      const found =
        await repositories.reviewConfirmations.getByVersionId(versionId);
      expect(found?.revision).toBe(1);
    });
  });

  it("never exposes a confirmation to another workspace", async () => {
    const { versionId } = await database.forWorkspace(
      workspaceId,
      async (repositories) => {
        const { listingId, versionId } = await createDraftAndVersion(
          repositories,
          workspaceId,
        );
        await repositories.reviewConfirmations.upsert(
          upsertInputFor(listingId, versionId),
        );
        return { versionId };
      },
    );

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      expect(
        await repositories.reviewConfirmations.getByVersionId(versionId),
      ).toBeNull();
    });
  });
});
