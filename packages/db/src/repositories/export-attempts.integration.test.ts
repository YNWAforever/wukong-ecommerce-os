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

  it("reports wasCreated: true on the first insert and wasCreated: false on a repeat with the same idempotency key", async () => {
    // A caller (the export route) gates a one-time side effect -- writing an
    // audit event -- on this flag, so it must actually distinguish "this
    // call's own INSERT won" from "this call found an existing row", not
    // just always report true.
    await database.forWorkspace(workspaceId, async (repositories) => {
      const created = await repositories.exportAttempts.ensure({
        idempotencyKey: "key_was_created",
        requestedBy: "user_1",
        manifest,
        rowCount: 1,
        specVersion: "bulk-form-v1",
      });
      expect(created.wasCreated).toBe(true);

      const repeat = await repositories.exportAttempts.ensure({
        idempotencyKey: "key_was_created",
        requestedBy: "user_1",
        manifest,
        rowCount: 1,
        specVersion: "bulk-form-v1",
      });
      expect(repeat.id).toBe(created.id);
      expect(repeat.wasCreated).toBe(false);
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

  it("lists workspace export attempts newest first, isolated per workspace, with limit bounds enforced", async () => {
    // A workspace dedicated to just this test, not the shared `workspaceId`
    // every other test in this file also writes into -- reusing that shared
    // workspace here would make `toEqual` below flaky against whatever rows
    // earlier tests happened to leave behind.
    const listWorkspaceId = "ws_export_attempts_list";
    const otherListWorkspaceId = "ws_export_attempts_list_other";
    await admin.unsafe(`
      INSERT INTO workspaces (id, name, profile) VALUES
        ('${listWorkspaceId}', '${listWorkspaceId}', '{}'::jsonb),
        ('${otherListWorkspaceId}', '${otherListWorkspaceId}', '{}'::jsonb);
    `);

    const ids: string[] = [];
    await database.forWorkspace(listWorkspaceId, async (repositories) => {
      for (let index = 0; index < 3; index += 1) {
        const attempt = await repositories.exportAttempts.ensure({
          idempotencyKey: `list_order_${index}`,
          requestedBy: "user_1",
          manifest,
          rowCount: 1,
          specVersion: "bulk-form-v1",
        });
        ids.push(attempt.id);
      }
    });
    // All three rows were inserted inside one transaction, so they would
    // otherwise share the exact same `now()` -- backdate them to distinct,
    // known instants so newest-first ordering is unambiguous.
    for (const [index, id] of ids.entries()) {
      const backdated = new Date(Date.now() - (ids.length - index) * 60_000);
      await admin.unsafe(
        "UPDATE export_attempts SET created_at = $1 WHERE id = $2",
        [backdated, id],
      );
    }

    const otherId = await database.forWorkspace(
      otherListWorkspaceId,
      async (repositories) =>
        (
          await repositories.exportAttempts.ensure({
            idempotencyKey: "other_list_order",
            requestedBy: "user_1",
            manifest,
            rowCount: 1,
            specVersion: "bulk-form-v1",
          })
        ).id,
    );

    await database.forWorkspace(listWorkspaceId, async (repositories) => {
      const listed = await repositories.exportAttempts.listForWorkspace();
      expect(listed.map((attempt) => attempt.id)).toEqual([...ids].reverse());
      expect(listed.map((attempt) => attempt.id)).not.toContain(otherId);
      expect(listed.every((attempt) => attempt.createdAt instanceof Date)).toBe(
        true,
      );

      await expect(
        repositories.exportAttempts.listForWorkspace(0),
      ).rejects.toThrow(/limit must be between 1 and 100/i);
      await expect(
        repositories.exportAttempts.listForWorkspace(101),
      ).rejects.toThrow(/limit must be between 1 and 100/i);
    });
  });

  it("breaks a created_at tie deterministically by id when several export attempts share one transaction's now()", async () => {
    // database.forWorkspace wraps every call in one Postgres transaction, and
    // Postgres's now() is fixed for the whole transaction (transaction-start
    // time, not per-statement) -- so all three attempts created below get the
    // exact same created_at with no backdating involved. This is the real
    // production shape (e.g. one export request that ensures several
    // attempts in a single call), not a test artifact: without an id
    // tiebreaker, ORDER BY created_at DESC alone would leave these three in
    // an arbitrary order.
    const created = await database.forWorkspace(
      workspaceId,
      async (repositories) => {
        const attempts = [];
        for (let index = 0; index < 3; index += 1) {
          attempts.push(
            await repositories.exportAttempts.ensure({
              idempotencyKey: `tie_order_${index}`,
              requestedBy: "user_1",
              manifest,
              rowCount: 1,
              specVersion: "bulk-form-v1",
            }),
          );
        }
        return attempts;
      },
    );
    expect(
      new Set(created.map((attempt) => attempt.createdAt.getTime())).size,
    ).toBe(1);
    const ids = created.map((attempt) => attempt.id);

    const listed = await database.forWorkspace(workspaceId, (repositories) =>
      repositories.exportAttempts.listForWorkspace(),
    );
    const tied = listed.filter((attempt) => ids.includes(attempt.id));
    expect(tied.map((attempt) => attempt.id)).toEqual(
      [...ids].sort().reverse(),
    );
  });
});
