import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, forWorkspace } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const testKey = "A".repeat(43) + "="; // 32 zero bytes, base64 -- matches token-vault's expected shape

describe("ShoplineConnectionRepository.create/update", () => {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined, prepare: false });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });
  const workspaceId = "ws_connection_test";

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
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  beforeEach(async () => {
    await admin.unsafe("TRUNCATE TABLE shopline_connections, workspaces CASCADE");
    await admin.unsafe(
      `INSERT INTO workspaces (id, name, profile) VALUES ($1, 'Test', '{}')`,
      [workspaceId],
    );
  });

  it("creates a connection with an encrypted token", async () => {
    const created = await forWorkspace(database, workspaceId, (repositories) =>
      repositories.shoplineConnections.create({
        shopDomain: "opak.myshopline.com",
        accessToken: "shptok_abc123",
        base64Key: testKey,
      }),
    );
    expect(created.shopDomain).toBe("opak.myshopline.com");
    const [row] = await admin.unsafe(
      `SELECT encrypted_access_token FROM shopline_connections WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(row?.encrypted_access_token).not.toContain("shptok_abc123");
    expect(row?.encrypted_access_token).toMatch(/^v1\./);
  });

  it("rejects creating a second connection for the same workspace", async () => {
    await forWorkspace(database, workspaceId, (repositories) =>
      repositories.shoplineConnections.create({
        shopDomain: "opak.myshopline.com",
        accessToken: "shptok_abc123",
        base64Key: testKey,
      }),
    );
    await expect(
      forWorkspace(database, workspaceId, (repositories) =>
        repositories.shoplineConnections.create({
          shopDomain: "another.myshopline.com",
          accessToken: "shptok_def456",
          base64Key: testKey,
        }),
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it("rotates the token on an existing connection without changing the shop domain", async () => {
    const created = await forWorkspace(database, workspaceId, (repositories) =>
      repositories.shoplineConnections.create({
        shopDomain: "opak.myshopline.com",
        accessToken: "shptok_abc123",
        base64Key: testKey,
      }),
    );
    await forWorkspace(database, workspaceId, (repositories) =>
      repositories.shoplineConnections.update(created.id, {
        accessToken: "shptok_rotated",
        base64Key: testKey,
      }),
    );
    const [row] = await admin.unsafe(
      `SELECT shop_domain, encrypted_access_token FROM shopline_connections WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(row?.shop_domain).toBe("opak.myshopline.com");
    expect(row?.encrypted_access_token).not.toContain("shptok_abc123");
  });
});
