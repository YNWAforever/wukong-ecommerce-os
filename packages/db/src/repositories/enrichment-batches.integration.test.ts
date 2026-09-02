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

  it("lists every batch for the workspace, newest first, and none from another", async () => {
    // Separate transactions — matching one API request per batch in
    // production — so each batch gets its own `now()` for `created_at`.
    // Postgres's `now()` is the transaction start time, not wall-clock time,
    // so creating both inside one shared transaction would give them an
    // identical timestamp and make "newest first" pass only by accident.
    const first = await database.forWorkspace(workspaceId, (repositories) =>
      repositories.enrichmentBatches.create({
        label: "first",
        budgetUsd: 1,
        waveSize: 1,
        createdBy: "operator@example.com",
        listingIds: [],
      }),
    );
    const second = await database.forWorkspace(workspaceId, (repositories) =>
      repositories.enrichmentBatches.create({
        label: "second",
        budgetUsd: 1,
        waveSize: 1,
        createdBy: "operator@example.com",
        listingIds: [],
      }),
    );

    await database.forWorkspace(workspaceId, async (repositories) => {
      const listed = await repositories.enrichmentBatches.listForWorkspace();
      const ids = listed.map((batch) => batch.id);
      expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
      expect(
        listed.find((batch) => batch.id === first.id)?.createdAt,
      ).toBeInstanceOf(Date);
    });

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      expect(await repositories.enrichmentBatches.listForWorkspace()).toEqual(
        [],
      );
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
    // A workspace dedicated to just this test, not the shared `workspaceId`
    // every other test in this file also writes into -- reusing that shared
    // workspace here would make `toEqual` below flaky against whatever rows
    // earlier tests happened to leave behind.
    const listWorkspaceId = "ws_batches_list";
    const otherListWorkspaceId = "ws_batches_list_other";
    await admin.unsafe(`
      INSERT INTO workspaces (id, name, profile) VALUES
        ('${listWorkspaceId}', '${listWorkspaceId}', '{}'::jsonb),
        ('${otherListWorkspaceId}', '${otherListWorkspaceId}', '{}'::jsonb);
    `);

    const ids: string[] = [];
    await database.forWorkspace(listWorkspaceId, async (repositories) => {
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
      otherListWorkspaceId,
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

    await database.forWorkspace(listWorkspaceId, async (repositories) => {
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

  it("breaks a created_at tie deterministically by id when several batches share one transaction's now()", async () => {
    // database.forWorkspace wraps every call in one Postgres transaction, and
    // Postgres's now() is fixed for the whole transaction (transaction-start
    // time, not per-statement) -- so all three batches created below get the
    // exact same created_at with no backdating involved. This is the real
    // production shape (e.g. one admin action creating several batches),
    // not a test artifact: without an id tiebreaker, ORDER BY created_at DESC
    // alone would leave these three in an arbitrary order.
    const created = await database.forWorkspace(
      workspaceId,
      async (repositories) => {
        const batches = [];
        for (let index = 0; index < 3; index += 1) {
          batches.push(
            await repositories.enrichmentBatches.create({
              label: `tie order ${index}`,
              budgetUsd: 1,
              waveSize: 1,
              createdBy: "operator@example.com",
              listingIds: [],
            }),
          );
        }
        return batches;
      },
    );
    expect(
      new Set(created.map((batch) => batch.createdAt.getTime())).size,
    ).toBe(1);
    const ids = created.map((batch) => batch.id);

    const listed = await database.forWorkspace(workspaceId, (repositories) =>
      repositories.enrichmentBatches.listForWorkspace(),
    );
    const tied = listed.filter((batch) => ids.includes(batch.id));
    expect(tied.map((batch) => batch.id)).toEqual([...ids].sort().reverse());
  });

  it("lists the batches a given listing belongs to, newest first, workspace-isolated", async () => {
    const listWorkspaceId = "ws_batches_for_listing";
    const otherListWorkspaceId = "ws_batches_for_listing_other";
    await admin.unsafe(`
      INSERT INTO workspaces (id, name, profile) VALUES
        ('${listWorkspaceId}', '${listWorkspaceId}', '{}'::jsonb),
        ('${otherListWorkspaceId}', '${otherListWorkspaceId}', '{}'::jsonb);
    `);

    const draftId = await database.forWorkspace(
      listWorkspaceId,
      async (repositories) => {
        const draft = await repositories.listings.create({
          target: "shopline",
          note: "test draft",
        });
        return draft.id;
      },
    );

    // Separate `forWorkspace` calls, one batch per transaction: Postgres's
    // `now()` is fixed for the life of one transaction, so two batches
    // created inside a single `forWorkspace` call would tie on `created_at`
    // and make the newest-first assertion below non-deterministic.
    const batchA = await database.forWorkspace(
      listWorkspaceId,
      (repositories) =>
        repositories.enrichmentBatches.create({
          label: "Batch A",
          budgetUsd: 5,
          waveSize: 10,
          createdBy: "user_1",
          listingIds: [draftId],
        }),
    );
    const batchB = await database.forWorkspace(
      listWorkspaceId,
      (repositories) =>
        repositories.enrichmentBatches.create({
          label: "Batch B",
          budgetUsd: 5,
          waveSize: 10,
          createdBy: "user_1",
          listingIds: [draftId],
        }),
    );

    await database.forWorkspace(listWorkspaceId, async (repositories) => {
      const related =
        await repositories.enrichmentBatches.listBatchesForListing(draftId);
      expect(related.map((batch) => batch.batchId)).toEqual([
        batchB.id,
        batchA.id,
      ]);
      expect(related.every((batch) => batch.createdAt instanceof Date)).toBe(
        true,
      );
      expect(related.map((batch) => batch.label)).toEqual([
        "Batch B",
        "Batch A",
      ]);
    });

    // Genuine cross-workspace isolation. `listing_drafts.id` is a global
    // primary key (not `(workspace_id, id)`), so a second workspace cannot
    // literally reuse `draftId` -- instead it gets its own real draft and its
    // own real batch referencing it, exercising the same join/filter path
    // this repository uses for `draftId`. The test then checks both
    // directions: workspace A's query must not surface workspace B's batch,
    // and workspace B's query (for its own draft) must not surface workspace
    // A's batches, and must not surface anything at all when asked about
    // workspace A's `draftId`, which it has no item rows for.
    const otherDraftId = await database.forWorkspace(
      otherListWorkspaceId,
      async (repositories) => {
        const draft = await repositories.listings.create({
          target: "shopline",
          note: "other workspace draft",
        });
        return draft.id;
      },
    );
    const otherBatchId = await database.forWorkspace(
      otherListWorkspaceId,
      async (repositories) => {
        const batch = await repositories.enrichmentBatches.create({
          label: "Other workspace batch",
          budgetUsd: 5,
          waveSize: 10,
          createdBy: "user_2",
          listingIds: [otherDraftId],
        });
        return batch.id;
      },
    );

    await database.forWorkspace(listWorkspaceId, async (repositories) => {
      const related =
        await repositories.enrichmentBatches.listBatchesForListing(draftId);
      expect(related.map((batch) => batch.batchId)).not.toContain(otherBatchId);
      expect(related).toHaveLength(2);
      // workspaceId scoping, not just id matching: workspace A has no item
      // row for workspace B's own draft either.
      expect(
        await repositories.enrichmentBatches.listBatchesForListing(
          otherDraftId,
        ),
      ).toEqual([]);
    });

    await database.forWorkspace(otherListWorkspaceId, async (repositories) => {
      const related =
        await repositories.enrichmentBatches.listBatchesForListing(
          otherDraftId,
        );
      expect(related.map((batch) => batch.batchId)).toEqual([otherBatchId]);
      // And workspace B sees nothing for workspace A's draft, even though
      // that draft really does belong to two batches -- just not this one's.
      expect(
        await repositories.enrichmentBatches.listBatchesForListing(draftId),
      ).toEqual([]);
    });
  });

  it("rejects a listBatchesForListing limit outside 1..100", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      await expect(
        repositories.enrichmentBatches.listBatchesForListing("any-id", 0),
      ).rejects.toThrow(/limit must be between 1 and 100/i);
      await expect(
        repositories.enrichmentBatches.listBatchesForListing("any-id", 101),
      ).rejects.toThrow(/limit must be between 1 and 100/i);
    });
  });
});
