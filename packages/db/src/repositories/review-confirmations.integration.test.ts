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

  const fieldRecords = {
    nameZh: {
      afterDigest: "a".repeat(64),
      before: { column: "nameZh", digest: "b".repeat(64) },
      evidenceDigest: "c".repeat(64),
    },
    summaryEn: {
      afterDigest: "d".repeat(64),
      before: null,
      evidenceDigest: null,
    },
  };

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

  // The dedicated migration-rehearsal harness drops the schema and is skipped
  // in CI. This proves 0027 is replay-safe where CI actually runs it:
  // beforeAll already migrated once, so this is the second application.
  it("adds field_records as a nullable column that survives a repeated migration", async () => {
    await database.migrate();

    const [column] = await admin`
      select is_nullable, data_type
      from information_schema.columns
      where table_name = 'review_confirmations'
        and column_name = 'field_records'`;
    expect(column).toEqual({ is_nullable: "YES", data_type: "jsonb" });

    const constraints = await admin`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'review_confirmations'::regclass
        and conname = 'review_confirmations_field_records_is_object'`;
    expect(constraints).toHaveLength(1);
    // The rule, not just the name: a loosened CHECK kept under the same name
    // must fail here.
    expect(constraints[0]?.definition).toContain(
      "jsonb_typeof(field_records) = 'object'",
    );
  });

  // Fake repositories cannot see a CHECK. Only a real write can.
  it("refuses a field_records value that is not an object", async () => {
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

    // A JSON null literal is not SQL NULL: jsonb_typeof('null'::jsonb) is
    // 'null', so the CHECK refuses it too. The repository must never write one.
    for (const refused of ["[]", "null"]) {
      await expect(
        admin`update review_confirmations
          set field_records = ${refused}::jsonb
          where version_id = ${versionId}`,
      ).rejects.toThrow(/review_confirmations_field_records_is_object/);
    }
  });

  it("stores the per-field record and reads it back without widening getByVersionId", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const { listingId, versionId } = await createDraftAndVersion(
        repositories,
        workspaceId,
      );

      const created = await repositories.reviewConfirmations.upsert({
        ...upsertInputFor(listingId, versionId),
        fieldRecords,
      });

      // Six callers read this shape and one returns it to the browser.
      expect(created).not.toHaveProperty("fieldRecords");
      expect(
        await repositories.reviewConfirmations.getByVersionId(versionId),
      ).not.toHaveProperty("fieldRecords");
      expect(
        await repositories.reviewConfirmations.getFieldRecordsByVersionId(
          versionId,
        ),
      ).toEqual(fieldRecords);
    });
  });

  it("clears the record when a revision is written without one", async () => {
    // The record describes the revision it was written with. Leaving the old
    // one in place would make a previous revision's record look current.
    await database.forWorkspace(workspaceId, async (repositories) => {
      const { listingId, versionId } = await createDraftAndVersion(
        repositories,
        workspaceId,
      );
      await repositories.reviewConfirmations.upsert({
        ...upsertInputFor(listingId, versionId),
        fieldRecords,
      });
      await repositories.reviewConfirmations.upsert(
        upsertInputFor(listingId, versionId),
      );

      expect(
        await repositories.reviewConfirmations.getFieldRecordsByVersionId(
          versionId,
        ),
      ).toBeNull();
    });
  });

  it("never exposes a field record to another workspace", async () => {
    const { versionId } = await database.forWorkspace(
      workspaceId,
      async (repositories) => {
        const { listingId, versionId } = await createDraftAndVersion(
          repositories,
          workspaceId,
        );
        await repositories.reviewConfirmations.upsert({
          ...upsertInputFor(listingId, versionId),
          fieldRecords,
        });
        return { versionId };
      },
    );

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      expect(
        await repositories.reviewConfirmations.getFieldRecordsByVersionId(
          versionId,
        ),
      ).toBeNull();
    });
  });

  it("stores an explicit null record as SQL NULL, which the CHECK allows", async () => {
    const { versionId } = await database.forWorkspace(
      workspaceId,
      async (repositories) => {
        const { listingId, versionId } = await createDraftAndVersion(
          repositories,
          workspaceId,
        );
        await repositories.reviewConfirmations.upsert({
          ...upsertInputFor(listingId, versionId),
          fieldRecords: null,
        });
        return { versionId };
      },
    );

    // Drizzle skips the jsonb encoder for a JS null, so this is SQL NULL rather
    // than the JSON literal the CHECK refuses.
    const [row] = await admin`
      select field_records is null as is_sql_null
      from review_confirmations
      where version_id = ${versionId}`;
    expect(row).toEqual({ is_sql_null: true });
  });
});
