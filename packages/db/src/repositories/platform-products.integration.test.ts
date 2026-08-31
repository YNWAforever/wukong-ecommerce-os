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
        origin: "import",
        sku: "0001",
        listingId: draft.id,
        specVersion: "opak-2026-05",
        rawRow: { productId: "aaaaaaaaaaaaaaaaaaaaaa01", sku: "0001" },
        factsPrefill: factsFixture,
        contentDigest: "a".repeat(64),
        sourceImportId: null,
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
        origin: "import",
        sku: "0002",
        listingId: draft.id,
        specVersion: "opak-2026-05",
        factsPrefill: factsFixture,
        sourceImportId: null,
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
            origin: "import",
            sku: `000${index}`,
            listingId: draft.id,
            specVersion: "opak-2026-05",
            rawRow: { sku: `000${index}` },
            factsPrefill: factsFixture,
            contentDigest: "e".repeat(64),
            sourceImportId: null,
          })),
        );
      },
    );

    expect(written).toHaveLength(25);
    expect(written.every((row) => row.listingId !== null)).toBe(true);
  });

  it("stamps and round-trips a source import id through upsert", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const sourceImport = await repositories.sourceImports.create({
        connectionId,
        filename: "opak-export.xlsx",
        workbookSha256: "d".repeat(64),
        headerContractSha256: "e".repeat(64),
        sheetName: "Default",
        rowCount: 1,
        merchantAttestedExportAt: new Date("2026-08-01T00:00:00Z"),
        importerId: "user_1",
        specVersion: "opak-2026-05",
      });

      await repositories.platformProducts.upsert({
        connectionId,
        remoteProductId: "aaaaaaaaaaaaaaaaaaaaaa09",
        origin: "import",
        sku: "0009",
        listingId: null,
        specVersion: "opak-2026-05",
        rawRow: { productId: "aaaaaaaaaaaaaaaaaaaaaa09" },
        factsPrefill: null,
        contentDigest: "f".repeat(64),
        sourceImportId: sourceImport.id,
      });

      const found = await repositories.platformProducts.listByRemoteProductIds(
        connectionId,
        ["aaaaaaaaaaaaaaaaaaaaaa09"],
      );
      expect(found[0]?.sourceImportId).toBe(sourceImport.id);
    });
  });

  it("rejects a facts prefill that is not valid canonical facts", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      await expect(
        repositories.platformProducts.upsert({
          connectionId,
          remoteProductId: "bad_facts",
          origin: "import",
          sku: "0099",
          listingId: null,
          specVersion: "opak-2026-05",
          rawRow: {},
          // Negative stock violates listingFactsSchema; the jsonb $type cast
          // would otherwise let it through unchecked.
          factsPrefill: { ...factsFixture, stockQuantity: -5 },
          contentDigest: "f".repeat(64),
          sourceImportId: null,
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
            origin: "import",
            sku: "0055",
            listingId: draft.id,
            specVersion: "opak-2026-05",
            rawRow: {},
            factsPrefill: factsFixture,
            contentDigest: "1".repeat(64),
            sourceImportId: null,
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
          origin: "import",
          sku: "0077",
          listingId: draft.id,
          specVersion: "opak-2026-05",
          rawRow: {},
          factsPrefill: factsFixture,
          contentDigest: "2".repeat(64),
          sourceImportId: null,
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
        origin: "import",
        sku: "SKU-1",
        listingId: draft.id,
        specVersion: "opak-2026-05",
        rawRow: { productId: "remote_lookup_1", sku: "SKU-1" },
        factsPrefill: factsFixture,
        contentDigest: "b".repeat(64),
        sourceImportId: null,
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

  it("upserts a create-origin row with every import-specific field null", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: null,
      });

      const created = await repositories.platformProducts.upsert({
        connectionId,
        remoteProductId: "remote_created_1",
        origin: "created",
        sku: null,
        listingId: draft.id,
        specVersion: null,
        rawRow: null,
        factsPrefill: null,
        contentDigest: null,
        sourceImportId: null,
      });

      expect(created.origin).toBe("created");
      expect(created.sku).toBeNull();
      expect(created.specVersion).toBeNull();
      expect(created.rawRow).toBeNull();
      expect(created.factsPrefill).toBeNull();
      expect(created.contentDigest).toBeNull();

      const found = await repositories.platformProducts.getByListingId(
        draft.id,
      );
      expect(found?.origin).toBe("created");
    });
  });

  it("preserves an import-origin row's import fields when re-upserted with the same values", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: null,
      });

      const importInput = {
        connectionId,
        remoteProductId: "remote_import_1",
        origin: "import" as const,
        sku: "SKU-IMPORT-1",
        listingId: draft.id,
        specVersion: "opak-2026-05",
        rawRow: { productId: "remote_import_1", sku: "SKU-IMPORT-1" },
        factsPrefill: factsFixture,
        contentDigest: "c".repeat(64),
        sourceImportId: null,
      };
      await repositories.platformProducts.upsert(importInput);

      // Simulate the worker's update-path upsert: re-supplies the same
      // import fields it read back from getByListingId, unchanged.
      const reUpserted =
        await repositories.platformProducts.upsert(importInput);

      expect(reUpserted.origin).toBe("import");
      expect(reUpserted.sku).toBe("SKU-IMPORT-1");
      expect(reUpserted.rawRow).toEqual({
        productId: "remote_import_1",
        sku: "SKU-IMPORT-1",
      });
      expect(reUpserted.contentDigest).toBe("c".repeat(64));
    });
  });

  it("actually nulls out previously non-null import fields on re-upsert, not just leaves them unchanged", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: null,
      });

      // Start with a fully-populated import-origin row.
      await repositories.platformProducts.upsert({
        connectionId,
        remoteProductId: "remote_flip_to_null_1",
        origin: "import",
        sku: "SKU-FLIP-1",
        listingId: draft.id,
        specVersion: "opak-2026-05",
        rawRow: { productId: "remote_flip_to_null_1", sku: "SKU-FLIP-1" },
        factsPrefill: factsFixture,
        contentDigest: "d".repeat(64),
        sourceImportId: null,
      });

      // Re-upsert the SAME conflict key with the import-specific fields now
      // explicitly null, simulating a switch to a "created"-origin row. This
      // exercises `.onConflictDoUpdate` actually writing NULL over a
      // previously non-null column, not merely leaving an unchanged value.
      const flipped = await repositories.platformProducts.upsert({
        connectionId,
        remoteProductId: "remote_flip_to_null_1",
        origin: "created",
        sku: null,
        listingId: draft.id,
        specVersion: null,
        rawRow: null,
        factsPrefill: null,
        contentDigest: null,
        sourceImportId: null,
      });

      expect(flipped.origin).toBe("created");
      expect(flipped.sku).toBeNull();
      expect(flipped.specVersion).toBeNull();
      expect(flipped.rawRow).toBeNull();
      expect(flipped.factsPrefill).toBeNull();
      expect(flipped.contentDigest).toBeNull();

      // Re-fetch independently of the upsert's own `.returning()` to prove
      // the row was actually written this way, not just echoed back.
      const found = await repositories.platformProducts.getByListingId(
        draft.id,
      );
      expect(found?.origin).toBe("created");
      expect(found?.sku).toBeNull();
      expect(found?.specVersion).toBeNull();
      expect(found?.rawRow).toBeNull();
      expect(found?.factsPrefill).toBeNull();
      expect(found?.contentDigest).toBeNull();
    });
  });

  it("upsertMany's excluded.* conflict path nulls fields and keeps rows independent on a real conflict", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const draftA = await repositories.listings.create({
        target: "shopline",
        note: null,
      });
      const draftB = await repositories.listings.create({
        target: "shopline",
        note: null,
      });
      const draftC = await repositories.listings.create({
        target: "shopline",
        note: null,
      });

      // Phase 1: seed three rows, all import-origin with real non-null
      // values, at fixed (connectionId, remoteProductId) keys. This alone
      // is a fresh INSERT and proves nothing about the ON CONFLICT branch —
      // it only sets up the conflict that phase 2 exercises.
      await repositories.platformProducts.upsertMany([
        {
          connectionId,
          remoteProductId: "batch_conflict_1",
          origin: "import",
          sku: "SKU-BATCH-1-OLD",
          listingId: draftA.id,
          specVersion: "opak-2026-05",
          rawRow: { productId: "batch_conflict_1", sku: "SKU-BATCH-1-OLD" },
          factsPrefill: factsFixture,
          contentDigest: "e".repeat(64),
          sourceImportId: null,
        },
        {
          connectionId,
          remoteProductId: "batch_conflict_2",
          origin: "import",
          sku: "SKU-BATCH-2-OLD",
          listingId: draftB.id,
          specVersion: "opak-2026-05",
          rawRow: { productId: "batch_conflict_2", sku: "SKU-BATCH-2-OLD" },
          factsPrefill: factsFixture,
          contentDigest: "f".repeat(64),
          sourceImportId: null,
        },
        {
          connectionId,
          remoteProductId: "batch_conflict_3",
          origin: "import",
          sku: "SKU-BATCH-3-OLD",
          listingId: draftC.id,
          specVersion: "opak-2026-05",
          rawRow: { productId: "batch_conflict_3", sku: "SKU-BATCH-3-OLD" },
          factsPrefill: factsFixture,
          contentDigest: "1".repeat(64),
          sourceImportId: null,
        },
      ]);

      // Phase 2: re-upsert the SAME (connectionId, remoteProductId) keys in
      // one batch, each row diverging differently, to genuinely exercise the
      // `excluded.<col>` ON CONFLICT DO UPDATE branch:
      //   - row 1 flips to "created" with its import fields now explicit null
      //   - row 2 stays "import" but gets different non-null values
      //   - row 3 stays "import" and keeps the same values (control)
      const written = await repositories.platformProducts.upsertMany([
        {
          connectionId,
          remoteProductId: "batch_conflict_1",
          origin: "created",
          sku: null,
          listingId: draftA.id,
          specVersion: null,
          rawRow: null,
          factsPrefill: null,
          contentDigest: null,
          sourceImportId: null,
        },
        {
          connectionId,
          remoteProductId: "batch_conflict_2",
          origin: "import",
          sku: "SKU-BATCH-2-NEW",
          listingId: draftB.id,
          specVersion: "opak-2026-06",
          rawRow: { productId: "batch_conflict_2", sku: "SKU-BATCH-2-NEW" },
          factsPrefill: factsFixture,
          contentDigest: "2".repeat(64),
          sourceImportId: null,
        },
        {
          connectionId,
          remoteProductId: "batch_conflict_3",
          origin: "import",
          sku: "SKU-BATCH-3-OLD",
          listingId: draftC.id,
          specVersion: "opak-2026-05",
          rawRow: { productId: "batch_conflict_3", sku: "SKU-BATCH-3-OLD" },
          factsPrefill: factsFixture,
          contentDigest: "1".repeat(64),
          sourceImportId: null,
        },
      ]);

      expect(written).toHaveLength(3);
      const byRemoteId = new Map(
        written.map((row) => [row.remoteProductId, row]),
      );

      const flipped = byRemoteId.get("batch_conflict_1");
      expect(flipped?.origin).toBe("created");
      expect(flipped?.sku).toBeNull();
      expect(flipped?.specVersion).toBeNull();
      expect(flipped?.rawRow).toBeNull();
      expect(flipped?.factsPrefill).toBeNull();
      expect(flipped?.contentDigest).toBeNull();

      const updated = byRemoteId.get("batch_conflict_2");
      expect(updated?.origin).toBe("import");
      expect(updated?.sku).toBe("SKU-BATCH-2-NEW");
      expect(updated?.specVersion).toBe("opak-2026-06");
      expect(updated?.rawRow).toEqual({
        productId: "batch_conflict_2",
        sku: "SKU-BATCH-2-NEW",
      });
      expect(updated?.contentDigest).toBe("2".repeat(64));

      const unchanged = byRemoteId.get("batch_conflict_3");
      expect(unchanged?.origin).toBe("import");
      expect(unchanged?.sku).toBe("SKU-BATCH-3-OLD");
      expect(unchanged?.contentDigest).toBe("1".repeat(64));

      // Re-fetch independently of upsertMany's own `.returning()` to prove
      // the ON CONFLICT branch actually wrote these values to the table,
      // per row, rather than collapsing the batch to one shared value.
      const refetched =
        await repositories.platformProducts.listByRemoteProductIds(
          connectionId,
          ["batch_conflict_1", "batch_conflict_2", "batch_conflict_3"],
        );
      const refetchedByRemoteId = new Map(
        refetched.map((row) => [row.remoteProductId, row]),
      );

      const refetchedFlipped = refetchedByRemoteId.get("batch_conflict_1");
      expect(refetchedFlipped?.origin).toBe("created");
      expect(refetchedFlipped?.sku).toBeNull();
      expect(refetchedFlipped?.specVersion).toBeNull();
      expect(refetchedFlipped?.rawRow).toBeNull();
      expect(refetchedFlipped?.factsPrefill).toBeNull();
      expect(refetchedFlipped?.contentDigest).toBeNull();

      const refetchedUpdated = refetchedByRemoteId.get("batch_conflict_2");
      expect(refetchedUpdated?.origin).toBe("import");
      expect(refetchedUpdated?.sku).toBe("SKU-BATCH-2-NEW");
      expect(refetchedUpdated?.contentDigest).toBe("2".repeat(64));

      const refetchedUnchanged = refetchedByRemoteId.get("batch_conflict_3");
      expect(refetchedUnchanged?.origin).toBe("import");
      expect(refetchedUnchanged?.sku).toBe("SKU-BATCH-3-OLD");
      expect(refetchedUnchanged?.contentDigest).toBe("1".repeat(64));
    });
  });
});
