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

const workspaceId = "ws_source_import";
const otherWorkspaceId = "ws_source_import_other";
const connectionId = "33333333-3333-4333-8333-333333333333";
const otherConnectionId = "44444444-4444-4444-8444-444444444444";

describe("source import repository", () => {
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
      INSERT INTO shopline_connections (id, workspace_id, shop_domain, encrypted_access_token) VALUES
        ('${connectionId}', '${workspaceId}', 'source-import-test.example', 'token'),
        ('${otherConnectionId}', '${otherWorkspaceId}', 'source-import-other.example', 'token');
    `);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  const inputFor = (overrides: { connectionId: string }) => ({
    connectionId: overrides.connectionId,
    filename: "opak-export.xlsx",
    workbookSha256: "a".repeat(64),
    headerContractSha256: "b".repeat(64),
    sheetName: "Default",
    rowCount: 2,
    merchantAttestedExportAt: new Date("2026-08-01T00:00:00Z"),
    importerId: "user_1",
    specVersion: "opak-2026-05",
  });

  it("creates a row and reads it back by id", async () => {
    const created = await database.forWorkspace(workspaceId, (repositories) =>
      repositories.sourceImports.create(inputFor({ connectionId })),
    );

    expect(created.filename).toBe("opak-export.xlsx");
    expect(created.headerContractSha256).toBe("b".repeat(64));

    const found = await database.forWorkspace(workspaceId, (repositories) =>
      repositories.sourceImports.getById(created.id),
    );
    expect(found?.id).toBe(created.id);
  });

  it("never returns another workspace's source import row", async () => {
    const created = await database.forWorkspace(workspaceId, (repositories) =>
      repositories.sourceImports.create(inputFor({ connectionId })),
    );

    const found = await database.forWorkspace(
      otherWorkspaceId,
      (repositories) => repositories.sourceImports.getById(created.id),
    );
    expect(found).toBeNull();
  });
});
