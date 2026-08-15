import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ListingFacts } from "@wukong/core";

import { createDatabase } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const ignoreNotice = (): void => undefined;

const workspaceId = "ws_import";
const otherWorkspaceId = "ws_import_other";
const connectionId = "11111111-1111-4111-8111-111111111111";
const otherConnectionId = "22222222-2222-4222-8222-222222222222";

const factsFixture: ListingFacts = {
  sku: "0001",
  producer: null,
  productType: "wine",
  country: null,
  region: null,
  vintage: null,
  grapeVarieties: [],
  volumeMl: null,
  abvPercent: null,
  packQuantity: 1,
  priceHkd: 100,
  stockQuantity: 6,
  criticScores: [],
  awards: [],
};

describe("platform product repository", () => {
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
        ('${connectionId}', '${workspaceId}', 'import-test.example', 'token'),
        ('${otherConnectionId}', '${otherWorkspaceId}', 'other-test.example', 'token');
    `);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it("inserts a link row and reads it back by remote product id", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: null,
      });
      const upserted = await repositories.platformProducts.upsert({
        connectionId,
        remoteProductId: "aaaaaaaaaaaaaaaaaaaaaa01",
        sku: "0001",
        listingId: draft.id,
        specVersion: "opak-2026-05",
        rawRow: { productId: "aaaaaaaaaaaaaaaaaaaaaa01", sku: "0001" },
        factsPrefill: factsFixture,
        contentDigest: "a".repeat(64),
      });

      expect(upserted.remoteProductId).toBe("aaaaaaaaaaaaaaaaaaaaaa01");
      expect(upserted.listingId).toBe(draft.id);

      const found = await repositories.platformProducts.listByRemoteProductIds(
        connectionId,
        ["aaaaaaaaaaaaaaaaaaaaaa01"],
      );
      expect(found).toHaveLength(1);
      expect(found[0]?.sku).toBe("0001");
      expect(found[0]?.contentDigest).toBe("a".repeat(64));
    });
  });

  it("refreshes the snapshot instead of duplicating the remote product", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: null,
      });
      const base = {
        connectionId,
        remoteProductId: "aaaaaaaaaaaaaaaaaaaaaa02",
        sku: "0002",
        listingId: draft.id,
        specVersion: "opak-2026-05",
        factsPrefill: factsFixture,
      };

      await repositories.platformProducts.upsert({
        ...base,
        rawRow: { sku: "0002", nameZh: "0002" },
        contentDigest: "b".repeat(64),
      });
      await repositories.platformProducts.upsert({
        ...base,
        rawRow: { sku: "0002", nameZh: "示範" },
        contentDigest: "c".repeat(64),
      });

      const found = await repositories.platformProducts.listByRemoteProductIds(
        connectionId,
        ["aaaaaaaaaaaaaaaaaaaaaa02"],
      );
      expect(found).toHaveLength(1);
      expect(found[0]?.contentDigest).toBe("c".repeat(64));
      expect(found[0]?.listingId).toBe(draft.id);
    });
  });

  it("returns an empty list rather than querying when no ids are asked for", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      expect(
        await repositories.platformProducts.listByRemoteProductIds(
          connectionId,
          [],
        ),
      ).toEqual([]);
    });
  });

  it("never returns another workspace's link rows", async () => {
    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      const found = await repositories.platformProducts.listByRemoteProductIds(
        connectionId,
        ["aaaaaaaaaaaaaaaaaaaaaa01"],
      );
      expect(found).toEqual([]);
    });
  });
});
