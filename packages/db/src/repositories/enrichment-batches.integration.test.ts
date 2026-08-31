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

const workspaceId = "ws_batches";
const otherWorkspaceId = "ws_batches_other";

describe("enrichment batch repository", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: ignoreNotice,
    prepare: false,
  });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });

  const createDrafts = async (
    scope: string,
    count: number,
  ): Promise<string[]> =>
    database.forWorkspace(scope, async (repositories) => {
      const drafts: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const draft = await repositories.listings.create({
          target: "shopline",
          note: null,
        });
        drafts.push(draft.id);
      }
      return drafts;
    });

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

  it("hands each queued draft to exactly one wave", async () => {
    const listingIds = await createDrafts(workspaceId, 5);

    await database.forWorkspace(workspaceId, async (repositories) => {
      const batch = await repositories.enrichmentBatches.create({
        label: "wave test",
        budgetUsd: 10,
        waveSize: 2,
        createdBy: "operator@example.com",
        listingIds,
      });
      expect(
        await repositories.enrichmentBatches.countByStatus(batch.id),
      ).toMatchObject({ pending: 5, queued: 0, succeeded: 0 });

      const first = await repositories.enrichmentBatches.claimWave(
        batch.id,
        batch.waveSize,
      );
      const second = await repositories.enrichmentBatches.claimWave(
        batch.id,
        batch.waveSize,
      );

      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      // The point of claiming and reading in one statement: a draft that one
      // wave already took must never reappear in the next one.
      expect(new Set([...first, ...second]).size).toBe(4);
      expect(
        await repositories.enrichmentBatches.countByStatus(batch.id),
      ).toEqual({
        pending: 1,
        queued: 4,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      });
    });
  });

  it("gives two concurrent advances disjoint waves", async () => {
    const listingIds = await createDrafts(workspaceId, 6);
    const batchId = await database.forWorkspace(
      workspaceId,
      async (repositories) => {
        const batch = await repositories.enrichmentBatches.create({
          label: "concurrent waves",
          budgetUsd: 20,
          waveSize: 2,
          createdBy: "operator@example.com",
          listingIds,
        });
        return batch.id;
      },
    );

    // Separate transactions, in flight at the same time: the claim is the only
    // thing standing between them and paying twice to enrich one draft.
    const [first, second] = await Promise.all([
      database.forWorkspace(workspaceId, async (repositories) =>
        repositories.enrichmentBatches.claimWave(batchId, 2),
      ),
      database.forWorkspace(workspaceId, async (repositories) =>
        repositories.enrichmentBatches.claimWave(batchId, 2),
      ),
    ]);

    expect(new Set([...first, ...second]).size).toBe(
      first.length + second.length,
    );
  });

  it("records item outcomes and the batch's own status", async () => {
    const listingIds = await createDrafts(workspaceId, 3);

    await database.forWorkspace(workspaceId, async (repositories) => {
      const batch = await repositories.enrichmentBatches.create({
        label: "outcome test",
        budgetUsd: 5,
        waveSize: 3,
        createdBy: "operator@example.com",
        listingIds,
      });
      const claimed = await repositories.enrichmentBatches.claimWave(
        batch.id,
        3,
      );
      await repositories.enrichmentBatches.markItems(
        batch.id,
        claimed,
        "succeeded",
      );
      await repositories.enrichmentBatches.setStatus(batch.id, "completed");

      expect(
        await repositories.enrichmentBatches.countByStatus(batch.id),
      ).toMatchObject({ succeeded: 3, queued: 0, pending: 0 });
      expect(
        (await repositories.enrichmentBatches.getById(batch.id))?.status,
      ).toBe("completed");
    });
  });

  it("reads the draft statuses a wave needs to reconcile", async () => {
    const listingIds = await createDrafts(workspaceId, 2);

    await database.forWorkspace(workspaceId, async (repositories) => {
      const statuses = await repositories.listings.statusesByIds(listingIds);
      expect(Object.keys(statuses).sort()).toEqual([...listingIds].sort());
      expect(new Set(Object.values(statuses))).toEqual(new Set(["received"]));
      expect(await repositories.listings.statusesByIds([])).toEqual({});
    });

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      expect(await repositories.listings.statusesByIds(listingIds)).toEqual({});
    });
  });

  it("lists the items sitting in one status", async () => {
    const listingIds = await createDrafts(workspaceId, 4);

    await database.forWorkspace(workspaceId, async (repositories) => {
      const batch = await repositories.enrichmentBatches.create({
        label: "status listing",
        budgetUsd: 1,
        waveSize: 2,
        createdBy: "operator@example.com",
        listingIds,
      });
      const claimed = await repositories.enrichmentBatches.claimWave(
        batch.id,
        2,
      );

      const queued = await repositories.enrichmentBatches.listItemsByStatus(
        batch.id,
        "queued",
      );
      expect([...queued].sort()).toEqual([...claimed].sort());

      const pending = await repositories.enrichmentBatches.listItemsByStatus(
        batch.id,
        "pending",
      );
      expect([...pending].sort()).toEqual(
        listingIds.filter((id) => !claimed.includes(id)).sort(),
      );
    });
  });

  it("never exposes a batch to another workspace", async () => {
    const listingIds = await createDrafts(workspaceId, 1);

    const batchId = await database.forWorkspace(
      workspaceId,
      async (repositories) => {
        const batch = await repositories.enrichmentBatches.create({
          label: "isolation",
          budgetUsd: 1,
          waveSize: 1,
          createdBy: "operator@example.com",
          listingIds,
        });
        return batch.id;
      },
    );

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      expect(await repositories.enrichmentBatches.listItemIds(batchId)).toEqual(
        [],
      );
      expect(await repositories.enrichmentBatches.getById(batchId)).toBeNull();
    });
  });

  it("round-trips the budget as a number, not the numeric column's string", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const created = await repositories.enrichmentBatches.create({
        label: "budget typing",
        budgetUsd: 2.5,
        waveSize: 1,
        createdBy: "operator@example.com",
        listingIds: [],
      });
      expect(typeof created.budgetUsd).toBe("number");
      expect(created.budgetUsd).toBe(2.5);

      const reread = await repositories.enrichmentBatches.getById(created.id);
      expect(typeof reread?.budgetUsd).toBe("number");
      expect(reread?.budgetUsd).toBe(2.5);
      // An empty item list must not attempt an insert at all.
      expect(
        await repositories.enrichmentBatches.listItemIds(created.id),
      ).toEqual([]);
    });
  });

  it("lists workspace batches newest first, isolated per workspace, with limit bounds enforced", async () => {
    const ids: string[] = [];
    await database.forWorkspace(workspaceId, async (repositories) => {
      for (let index = 0; index < 3; index += 1) {
        const batch = await repositories.enrichmentBatches.create({
          label: `list order ${index}`,
          budgetUsd: 1,
          waveSize: 1,
          createdBy: "operator@example.com",
          listingIds: [],
        });
        ids.push(batch.id);
      }
    });
    // All three rows were inserted inside one transaction, so they would
    // otherwise share the exact same `now()` -- backdate them to distinct,
    // known instants so newest-first ordering is unambiguous.
    for (const [index, id] of ids.entries()) {
      const backdated = new Date(Date.now() - (ids.length - index) * 60_000);
      await admin.unsafe(
        "UPDATE enrichment_batches SET created_at = $1 WHERE id = $2",
        [backdated, id],
      );
    }

    const otherId = await database.forWorkspace(
      otherWorkspaceId,
      async (repositories) => {
        const batch = await repositories.enrichmentBatches.create({
          label: "other workspace",
          budgetUsd: 1,
          waveSize: 1,
          createdBy: "operator@example.com",
          listingIds: [],
        });
        return batch.id;
      },
    );

    await database.forWorkspace(workspaceId, async (repositories) => {
      const listed = await repositories.enrichmentBatches.listForWorkspace();
      expect(listed.map((batch) => batch.id)).toEqual([...ids].reverse());
      expect(listed.map((batch) => batch.id)).not.toContain(otherId);
      expect(listed.every((batch) => batch.createdAt instanceof Date)).toBe(
        true,
      );

      await expect(
        repositories.enrichmentBatches.listForWorkspace(0),
      ).rejects.toThrow(/limit must be between 1 and 100/i);
      await expect(
        repositories.enrichmentBatches.listForWorkspace(101),
      ).rejects.toThrow(/limit must be between 1 and 100/i);
    });
  });
});
