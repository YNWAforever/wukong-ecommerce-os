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

const workspaceId = "ws_audit_repo";
const otherWorkspaceId = "ws_audit_repo_other";

describe("audit repository — findRelatedToListing", () => {
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

  it("returns only this workspace's audit events for the given listing, newest first", async () => {
    const listingId = await database.forWorkspace(
      workspaceId,
      async (repositories) => {
        const draft = await repositories.listings.create({
          target: "shopline",
          note: "test draft",
        });
        return draft.id;
      },
    );

    // Each audit write happens in its own `forWorkspace` transaction so that
    // Postgres's `now()` — which is fixed for the lifetime of a single
    // transaction — actually advances between the two events. Writing both
    // inside one transaction gives them an identical `created_at`, which
    // makes the newest-first ordering assertion below fall back to a random
    // UUID tiebreak and fail non-deterministically.
    await database.forWorkspace(workspaceId, async (repositories) => {
      await repositories.audit.write({
        workspaceId,
        actorId: "user_1",
        entityId: listingId,
        action: "listing.imported",
        metadata: { remoteProductId: "sku_1" },
      });
    });

    await database.forWorkspace(workspaceId, async (repositories) => {
      await repositories.audit.write({
        workspaceId,
        actorId: "user_1",
        entityId: listingId,
        action: "listing.approved",
        metadata: {},
      });
    });

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      const otherDraft = await repositories.listings.create({
        target: "shopline",
        note: "other workspace draft",
      });
      await repositories.audit.write({
        workspaceId: otherWorkspaceId,
        actorId: "user_2",
        entityId: otherDraft.id,
        action: "listing.imported",
        metadata: {},
      });
    });

    await database.forWorkspace(workspaceId, async (repositories) => {
      const events = await repositories.audit.findRelatedToListing(listingId);
      expect(events.map((event) => event.action)).toEqual([
        "listing.approved",
        "listing.imported",
      ]);
      expect(events.every((event) => event.entityId === listingId)).toBe(true);
    });
  });

  it("never returns another workspace's audit events even for the same listing id", async () => {
    // `entity_id` is a plain text column with no foreign-key constraint, so
    // both workspaces can safely write an audit event against the same
    // manually-chosen id without a real listings row existing for it. This
    // lets us prove the `eq(auditEvents.workspaceId, workspaceId)` filter is
    // load-bearing: if it were dropped, either workspace's query below would
    // return both events instead of just its own.
    const sharedListingId = "10101010-2020-4030-8040-505060607070";

    await database.forWorkspace(workspaceId, async (repositories) => {
      await repositories.audit.write({
        workspaceId,
        actorId: "user_1",
        entityId: sharedListingId,
        action: "listing.imported",
        metadata: {},
      });
    });

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      await repositories.audit.write({
        workspaceId: otherWorkspaceId,
        actorId: "user_2",
        entityId: sharedListingId,
        action: "listing.imported",
        metadata: {},
      });
    });

    await database.forWorkspace(workspaceId, async (repositories) => {
      const events =
        await repositories.audit.findRelatedToListing(sharedListingId);
      expect(events).toHaveLength(1);
      expect(events[0]?.actorId).toBe("user_1");
    });

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      const events =
        await repositories.audit.findRelatedToListing(sharedListingId);
      expect(events).toHaveLength(1);
      expect(events[0]?.actorId).toBe("user_2");
    });
  });

  it("returns an empty array for a listing id with no audit events", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const events = await repositories.audit.findRelatedToListing(
        "00000000-0000-4000-8000-000000000000",
      );
      expect(events).toEqual([]);
    });
  });

  it("rejects a limit outside 1..100", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      await expect(
        repositories.audit.findRelatedToListing("any-id", 0),
      ).rejects.toThrow(/limit must be between 1 and 100/i);
      await expect(
        repositories.audit.findRelatedToListing("any-id", 101),
      ).rejects.toThrow(/limit must be between 1 and 100/i);
    });
  });
});
