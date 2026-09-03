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

const workspaceId = "ws_import_results";
const otherWorkspaceId = "ws_import_results_other";
const listingId = "11111111-1111-4111-8111-111111111111";

describe("import results repository", () => {
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
    await admin.unsafe(`
      INSERT INTO listing_drafts (id, workspace_id) VALUES
        ('${listingId}', '${workspaceId}');
    `);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it("creates an import result and reads it back via listForWorkspace", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const created = await repositories.importResults.create({
        listingId,
        exportAttemptId: null,
        outcome: "accepted",
        rejectReason: null,
        recordedBy: "user_1",
      });
      expect(created.outcome).toBe("accepted");
      expect(created.exportAttemptId).toBeNull();

      const listed = await repositories.importResults.listForWorkspace();
      expect(listed.map((row) => row.id)).toContain(created.id);
    });
  });

  it("stores a reject reason for a rejected outcome", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const created = await repositories.importResults.create({
        listingId,
        exportAttemptId: null,
        outcome: "rejected",
        rejectReason: "SKU already exists on another product",
        recordedBy: "user_1",
      });
      expect(created.outcome).toBe("rejected");
      expect(created.rejectReason).toBe(
        "SKU already exists on another product",
      );
    });
  });

  it("never exposes an import result to another workspace", async () => {
    const created = await database.forWorkspace(workspaceId, (repositories) =>
      repositories.importResults.create({
        listingId,
        exportAttemptId: null,
        outcome: "accepted",
        rejectReason: null,
        recordedBy: "user_1",
      }),
    );

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      const listed = await repositories.importResults.listForWorkspace();
      expect(listed.map((row) => row.id)).not.toContain(created.id);
    });
  });

  it("enforces the limit bounds on listForWorkspace", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      await expect(
        repositories.importResults.listForWorkspace(0),
      ).rejects.toThrow(/limit must be between 1 and 100/i);
      await expect(
        repositories.importResults.listForWorkspace(101),
      ).rejects.toThrow(/limit must be between 1 and 100/i);
    });
  });

  it("rejects a listingId that does not exist in this workspace (FK restrict)", async () => {
    // The failing insert has to be the thing that makes the *whole*
    // forWorkspace transaction reject, not something caught and swallowed
    // inside its callback: once a statement inside a Postgres transaction
    // violates a constraint, the transaction is aborted and every later
    // statement (including the implicit COMMIT that a callback resolving
    // "successfully" would trigger) fails too. Catching the rejection with
    // `expect(...).rejects` *inside* the callback would let the callback
    // resolve, and the doomed COMMIT that follows would then surface as an
    // unhandled rejection instead of a clean assertion. Mirrors the only
    // other FK-restrict assertion in this codebase
    // (platform-products.integration.test.ts), which keeps the failing call
    // outside any forWorkspace wrapper for the same reason.
    await expect(
      database.forWorkspace(workspaceId, (repositories) =>
        repositories.importResults.create({
          listingId: "99999999-9999-4999-8999-999999999999",
          exportAttemptId: null,
          outcome: "accepted",
          rejectReason: null,
          recordedBy: "user_1",
        }),
      ),
    ).rejects.toThrow();
  });

  it("links to a real export_attempts row in the same workspace", async () => {
    const exportAttemptId = "33333333-3333-4333-8333-333333333333";
    await admin.unsafe(`
      INSERT INTO export_attempts
        (id, workspace_id, idempotency_key, requested_by, manifest, row_count, spec_version, created_at)
      VALUES
        ('${exportAttemptId}', '${workspaceId}', 'idem_import_results_same_ws', 'user_1', '[]'::jsonb, 0, 'opak-2026-05', now());
    `);

    await database.forWorkspace(workspaceId, async (repositories) => {
      const created = await repositories.importResults.create({
        listingId,
        exportAttemptId,
        outcome: "accepted",
        rejectReason: null,
        recordedBy: "user_1",
      });
      expect(created.exportAttemptId).toBe(exportAttemptId);

      const listed = await repositories.importResults.listForWorkspace();
      const found = listed.find((row) => row.id === created.id);
      expect(found?.exportAttemptId).toBe(exportAttemptId);
    });
  });

  it("rejects an exportAttemptId that belongs to another workspace (FK restrict)", async () => {
    const otherExportAttemptId = "44444444-4444-4444-8444-444444444444";
    await admin.unsafe(`
      INSERT INTO export_attempts
        (id, workspace_id, idempotency_key, requested_by, manifest, row_count, spec_version, created_at)
      VALUES
        ('${otherExportAttemptId}', '${otherWorkspaceId}', 'idem_import_results_other_ws', 'user_1', '[]'::jsonb, 0, 'opak-2026-05', now());
    `);

    // Same "keep the failing call outside any forWorkspace wrapper" reasoning
    // as the listingId FK-restrict test above: this must reject the whole
    // transaction, not be caught inside the callback.
    await expect(
      database.forWorkspace(workspaceId, (repositories) =>
        repositories.importResults.create({
          listingId,
          exportAttemptId: otherExportAttemptId,
          outcome: "accepted",
          rejectReason: null,
          recordedBy: "user_1",
        }),
      ),
    ).rejects.toThrow();
  });
});
