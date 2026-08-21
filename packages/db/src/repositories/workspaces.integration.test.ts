import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, forWorkspace } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";

describe("WorkspaceRepository.updateProfile", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
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
    await admin.unsafe("TRUNCATE TABLE workspaces CASCADE");
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  const baseProfile = {
    name: "Test Workspace",
    currency: "HKD" as const,
    locales: ["en", "zh-Hant"] as const,
    tone: "clear",
    claimPolicy: [] as string[],
    requiredFields: [] as string[],
  };

  it("persists a new brand background color and requireProfile reflects it", async () => {
    await admin.unsafe(
      `INSERT INTO workspaces (id, name, profile) VALUES ('ws_brand_color', 'Test Workspace', '{}'::jsonb)`,
    );
    await forWorkspace(database, "ws_brand_color", async (repos) => {
      await repos.workspaces.updateProfile({
        ...baseProfile,
        brandBackgroundColor: "#1a2b3c",
      });
      const profile = await repos.workspaces.requireProfile();
      expect(profile.brandBackgroundColor).toBe("#1a2b3c");
    });
  });

  it("rejects a malformed color", async () => {
    await admin.unsafe(
      `INSERT INTO workspaces (id, name, profile) VALUES ('ws_bad_color', 'Test Workspace', '{}'::jsonb)`,
    );
    await forWorkspace(database, "ws_bad_color", async (repos) => {
      await expect(
        repos.workspaces.updateProfile({
          ...baseProfile,
          brandBackgroundColor: "not-a-color",
        } as never),
      ).rejects.toThrow();
    });
  });
});
