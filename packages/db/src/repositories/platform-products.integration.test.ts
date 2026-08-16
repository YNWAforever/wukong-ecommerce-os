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

  it("writes a whole batch in one statement", async () => {
    const written = await database.forWorkspace(
      workspaceId,
      async (repositories) => {
        const draft = await repositories.listings.create({
          target: "shopline",
          note: null,
        });
        return repositories.platformProducts.upsertMany(
          Array.from({ length: 25 }, (_unused, index) => ({
            connectionId,
            remoteProductId: `batch_${index}`,
            sku: `000${index}`,
            listingId: draft.id,
            specVersion: "opak-2026-05",
            rawRow: { sku: `000${index}` },
            factsPrefill: factsFixture,
            contentDigest: "e".repeat(64),
          })),
        );
      },
    );

    expect(written).toHaveLength(25);
    expect(written.every((row) => row.listingId !== null)).toBe(true);
  });

  it("rejects a facts prefill that is not valid canonical facts", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      await expect(
        repositories.platformProducts.upsert({
          connectionId,
          remoteProductId: "bad_facts",
          sku: "0099",
          listingId: null,
          specVersion: "opak-2026-05",
          rawRow: {},
          // Negative stock violates listingFactsSchema; the jsonb $type cast
          // would otherwise let it through unchecked.
          factsPrefill: { ...factsFixture, stockQuantity: -5 },
          contentDigest: "f".repeat(64),
        }),
      ).rejects.toThrow();
    });
  });

  describe("draft deletion", () => {
    it("blocks deleting a draft whose mirror still points at it", async () => {
      const draftId = await database.forWorkspace(
        workspaceId,
        async (repositories) => {
          const draft = await repositories.listings.create({
            target: "shopline",
            note: null,
          });
          await repositories.platformProducts.upsert({
            connectionId,
            remoteProductId: "linked_1",
            sku: "0055",
            listingId: draft.id,
            specVersion: "opak-2026-05",
            rawRow: {},
            factsPrefill: factsFixture,
            contentDigest: "1".repeat(64),
          });
          return draft.id;
        },
      );

      // The RESTRICT is the point: a draft delete must not silently destroy the
      // catalog mirror and the digest that detects real catalog change.
      await expect(
        admin.unsafe(`delete from listing_drafts where id = '${draftId}'`),
      ).rejects.toThrow(/violates foreign key constraint/);

      const detached = await database.forWorkspace(
        workspaceId,
        async (repositories) =>
          repositories.platformProducts.unlinkListing(draftId),
      );
      expect(detached).toBe(1);

      // After the deliberate unlink the draft is deletable and the mirror row
      // survives, which is exactly the workflow the constraint presumes.
      await admin.unsafe(`delete from listing_drafts where id = '${draftId}'`);
      const survivors = await database.forWorkspace(
        workspaceId,
        async (repositories) =>
          repositories.platformProducts.listByRemoteProductIds(connectionId, [
            "linked_1",
          ]),
      );
      expect(survivors).toHaveLength(1);
      expect(survivors[0]?.listingId).toBeNull();
    });

    it("still lets a whole workspace be deleted without unlinking first", async () => {
      // The mirror's own cascade to `workspaces` removes these rows before the
      // draft delete is checked, so RESTRICT never trips. Pinned because the
      // opposite was assumed during review.
      await admin.unsafe(`
        insert into workspaces (id, name, profile) values ('ws_cascade', 'ws_cascade', '{}'::jsonb);
        insert into shopline_connections (id, workspace_id, shop_domain, encrypted_access_token)
          values ('66666666-6666-4666-8666-666666666666', 'ws_cascade', 'c.example', 't');
      `);
      await database.forWorkspace("ws_cascade", async (repositories) => {
        const draft = await repositories.listings.create({
          target: "shopline",
          note: null,
        });
        await repositories.platformProducts.upsert({
          connectionId: "66666666-6666-4666-8666-666666666666",
          remoteProductId: "cascade_1",
          sku: "0077",
          listingId: draft.id,
          specVersion: "opak-2026-05",
          rawRow: {},
          factsPrefill: factsFixture,
          contentDigest: "2".repeat(64),
        });
      });

      await expect(
        admin.unsafe(`delete from workspaces where id = 'ws_cascade'`),
      ).resolves.toBeDefined();
    });
  });

  it("finds a platform product by its linked listing", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: null,
      });

      const created = await repositories.platformProducts.upsert({
        connectionId,
        remoteProductId: "remote_lookup_1",
        sku: "SKU-1",
        listingId: draft.id,
        specVersion: "opak-2026-05",
        rawRow: { productId: "remote_lookup_1", sku: "SKU-1" },
        factsPrefill: factsFixture,
        contentDigest: "b".repeat(64),
      });

      const found = await repositories.platformProducts.getByListingId(
        draft.id,
      );
      expect(found?.id).toBe(created.id);
      expect(found?.remoteProductId).toBe("remote_lookup_1");
    });
  });

  it("returns null when no platform product links to the listing", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: null,
      });

      expect(
        await repositories.platformProducts.getByListingId(draft.id),
      ).toBeNull();
    });
  });
});
