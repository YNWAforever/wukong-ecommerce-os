import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const ignoreNotice = (): void => undefined;

const workspaceId = "ws_review_confirmations";
const otherWorkspaceId = "ws_review_confirmations_other";

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

  const upsertInputFor = (versionId: string) => ({
    listingId: "11111111-1111-4111-8111-111111111111",
    versionId,
    fieldConfirmations: { nameZh: true, seoTitleEn: false },
    negativeConfirmations: { priceUnchanged: true, noImageChange: false },
    sourceImportId: null,
    rowDigest: null,
  });

  it("creates a confirmation, reads it back, and increments revision on upsert", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const created = await repositories.reviewConfirmations.upsert(
        upsertInputFor("22222222-2222-4222-8222-222222222222"),
      );
      expect(created.revision).toBe(0);
      expect(created.fieldConfirmations).toEqual({
        nameZh: true,
        seoTitleEn: false,
      });

      const updated = await repositories.reviewConfirmations.upsert({
        ...upsertInputFor("22222222-2222-4222-8222-222222222222"),
        fieldConfirmations: { nameZh: true, seoTitleEn: true },
      });
      expect(updated.revision).toBe(1);
      expect(updated.fieldConfirmations).toEqual({
        nameZh: true,
        seoTitleEn: true,
      });

      const found = await repositories.reviewConfirmations.getByVersionId(
        "22222222-2222-4222-8222-222222222222",
      );
      expect(found?.revision).toBe(1);
    });
  });

  it("never exposes a confirmation to another workspace", async () => {
    await database.forWorkspace(workspaceId, (repositories) =>
      repositories.reviewConfirmations.upsert(
        upsertInputFor("33333333-3333-4333-8333-333333333333"),
      ),
    );

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      expect(
        await repositories.reviewConfirmations.getByVersionId(
          "33333333-3333-4333-8333-333333333333",
        ),
      ).toBeNull();
    });
  });
});
