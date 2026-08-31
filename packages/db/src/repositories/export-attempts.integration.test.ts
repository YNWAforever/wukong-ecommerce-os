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

const workspaceId = "ws_export_attempts";
const otherWorkspaceId = "ws_export_attempts_other";

describe("export attempts repository", () => {
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

  const manifest = [
    {
      listingId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      outcome: "included" as const,
    },
    {
      listingId: "33333333-3333-4333-8333-333333333333",
      versionId: null,
      outcome: "excluded_no_op" as const,
      reason: "no_op",
    },
  ];

  it("creates an export attempt, and a repeat with the same idempotency key returns the same row", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const created = await repositories.exportAttempts.ensure({
        idempotencyKey: "key_1",
        requestedBy: "user_1",
        manifest,
        rowCount: 1,
        specVersion: "bulk-form-v1",
      });
      expect(created.rowCount).toBe(1);
      expect(created.manifest).toEqual(manifest);

      const repeat = await repositories.exportAttempts.ensure({
        idempotencyKey: "key_1",
        requestedBy: "user_1",
        manifest,
        rowCount: 1,
        specVersion: "bulk-form-v1",
      });
      expect(repeat.id).toBe(created.id);

      const found = await repositories.exportAttempts.getById(created.id);
      expect(found?.id).toBe(created.id);
    });
  });

  it("throws instead of silently returning a stale row when a repeat call's idempotency key collides with a different request", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      await repositories.exportAttempts.ensure({
        idempotencyKey: "key_collision",
        requestedBy: "user_1",
        manifest,
        rowCount: 1,
        specVersion: "bulk-form-v1",
      });

      await expect(
        repositories.exportAttempts.ensure({
          idempotencyKey: "key_collision",
          requestedBy: "user_1",
          manifest,
          rowCount: 2,
          specVersion: "bulk-form-v1",
        }),
      ).rejects.toThrow(/idempotency key does not match/i);

      await expect(
        repositories.exportAttempts.ensure({
          idempotencyKey: "key_collision",
          requestedBy: "user_1",
          manifest,
          rowCount: 1,
          specVersion: "bulk-form-v2",
        }),
      ).rejects.toThrow(/idempotency key does not match/i);
    });
  });

  it("throws when a repeat call's manifest disagrees entry-by-entry even though rowCount and specVersion both match", async () => {
    // Reproduces the exact scenario a rowCount/specVersion-only check would
    // miss: a reviewer resubmits the same listing/version set after fixing
    // freshnessAttested. If content was already in sync, every listing is
    // excluded both times -- attempt 1 as "not_attested" (freshness check
    // failed), attempt 2 as "excluded_no_op" (freshness check passed, but
    // there was nothing to write). Same rowCount (0), same specVersion, but
    // the stored manifest and the new one disagree on why each listing was
    // excluded -- that disagreement must still be caught.
    const notAttestedManifest = [
      {
        listingId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        outcome: "excluded_stale" as const,
        reason: "not_attested",
      },
    ];
    const noOpManifest = [
      {
        listingId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        outcome: "excluded_no_op" as const,
        reason: "excluded_no_op",
      },
    ];

    await database.forWorkspace(workspaceId, async (repositories) => {
      await repositories.exportAttempts.ensure({
        idempotencyKey: "key_manifest_collision",
        requestedBy: "user_1",
        manifest: notAttestedManifest,
        rowCount: 0,
        specVersion: "bulk-form-v1",
      });

      await expect(
        repositories.exportAttempts.ensure({
          idempotencyKey: "key_manifest_collision",
          requestedBy: "user_1",
          manifest: noOpManifest,
          rowCount: 0,
          specVersion: "bulk-form-v1",
        }),
      ).rejects.toThrow(/idempotency key does not match/i);
    });
  });

  it("does not throw when a repeat call's manifest has the same entries in a different array order", async () => {
    // The idempotency key is derived from the sorted listing/version set, so
    // two calls naming the same set in a different array order -- e.g. one
    // reconstructed from a Set/Map, or a UI re-render -- hash to the same
    // key and are the same request by the key's own definition. The
    // comparison must normalize order before comparing, or this legitimate
    // retry path would incorrectly throw a false idempotency-key mismatch.
    const forward = manifest;
    const reversed = [...manifest].reverse();

    await database.forWorkspace(workspaceId, async (repositories) => {
      const created = await repositories.exportAttempts.ensure({
        idempotencyKey: "key_reordered",
        requestedBy: "user_1",
        manifest: forward,
        rowCount: 1,
        specVersion: "bulk-form-v1",
      });

      const repeat = await repositories.exportAttempts.ensure({
        idempotencyKey: "key_reordered",
        requestedBy: "user_1",
        manifest: reversed,
        rowCount: 1,
        specVersion: "bulk-form-v1",
      });
      expect(repeat.id).toBe(created.id);
    });
  });

  it("never exposes an export attempt to another workspace", async () => {
    const created = await database.forWorkspace(workspaceId, (repositories) =>
      repositories.exportAttempts.ensure({
        idempotencyKey: "key_2",
        requestedBy: "user_1",
        manifest,
        rowCount: 1,
        specVersion: "bulk-form-v1",
      }),
    );

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      expect(await repositories.exportAttempts.getById(created.id)).toBeNull();
    });
  });
});
