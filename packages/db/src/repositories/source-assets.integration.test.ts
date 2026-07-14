import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, forWorkspace, type WorkspaceRepositories } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";

describe("source asset repository", () => {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined, prepare: false });
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

  it("persists an unattached asset and hides it from another workspace", async () => {
    const asset = await forWorkspace(database, "ws_assets", (repos) =>
      repos.sourceAssets.create({
        storageKey: "ws/ws_assets/sources/a/file.pdf",
        kind: "application/pdf",
        metadata: { size: 1200, mimeType: "application/pdf", sha256: "a".repeat(64) },
      }),
    );

    expect(asset.listingId).toBeNull();
    await expect(
      forWorkspace(database, "ws_other", (repos) =>
        repos.sourceAssets.getByIds([asset.id]),
      ),
    ).resolves.toEqual([]);
  });

  it("associates an owned asset with a received SHOPLINE listing", async () => {
    const result = await forWorkspace(database, "ws_associate", async (repos) => {
      const asset = await repos.sourceAssets.create({
        storageKey: "ws/ws_associate/sources/a/image.png",
        kind: "image/png",
        metadata: { size: 3, mimeType: "image/png", sha256: "b".repeat(64) },
      });
      const listing = await repos.listings.create({ target: "shopline" });
      await repos.sourceAssets.attachToListing(listing.id, [asset.id]);
      return { listing, asset: (await repos.sourceAssets.getByIds([asset.id]))[0] };
    });

    expect(result.listing).toMatchObject({ status: "received", target: "shopline" });
    expect(result.asset?.listingId).toBe(result.listing.id);
  });

  it("closes escaped source asset repositories with the workspace scope", async () => {
    let escaped: WorkspaceRepositories | undefined;
    await forWorkspace(database, "ws_closed_assets", async (repos) => {
      escaped = repos;
      await repos.listings.create({ target: "shopline" });
    });

    await expect(escaped!.sourceAssets.getByIds([])).rejects.toThrow(
      /workspace scope is closed/i,
    );
  });
});
