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
  const admin = postgres(adminUrl, { max: 1, onnotice: ignoreNotice, prepare: false });
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
    const listingId = await database.forWorkspace(workspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: "test draft",
      });
      await repositories.audit.write({
        workspaceId,
        actorId: "user_1",
        entityId: draft.id,
        action: "listing.imported",
        metadata: { remoteProductId: "sku_1" },
      });
      await repositories.audit.write({
        workspaceId,
        actorId: "user_1",
        entityId: draft.id,
        action: "listing.approved",
        metadata: {},
      });
      return draft.id;
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
    await database.forWorkspace(workspaceId, async (repositories) => {
      const events = await repositories.audit.findRelatedToListing(
        "00000000-0000-4000-8000-000000000000",
      );
      expect(events).toEqual([]);
    });
  });
});
