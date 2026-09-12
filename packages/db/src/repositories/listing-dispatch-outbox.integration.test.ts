/**
 * The durable record of work we intended to send.
 *
 * These need a real Postgres, because the properties that matter are the ones
 * the database enforces: the unique index that stops a retried wave becoming
 * two messages, and the row-level security that keeps one workspace's pending
 * work invisible to another. A fake repository agrees with whatever the code
 * assumes, which is exactly the failure mode that let a `check_violation` ship
 * green earlier on this branch.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuditContext, CanonicalListing } from "@wukong/core";
import { createDatabase, forWorkspace } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";

const workspaceId = "ws_outbox";
const otherWorkspaceId = "ws_outbox_other";

const localized = { en: "Demo Estate Riesling", "zh-Hant": "示範酒莊麗絲玲" };
const listingContent: CanonicalListing = {
  sku: "OPAK-OUTBOX",
  producer: "Demo Estate",
  productType: "wine",
  country: "Germany",
  region: "Mosel",
  vintage: 2024,
  grapeVarieties: ["Riesling"],
  volumeMl: 750,
  abvPercent: 12.5,
  packQuantity: 1,
  priceHkd: 288,
  stockQuantity: 4,
  criticScores: [],
  awards: [],
  title: localized,
  description: localized,
  seo: { title: localized, description: localized },
  tags: ["Riesling"],
  imageAssetIds: [],
};

describe("listing dispatch outbox", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });

  beforeAll(async () => {
    await admin.unsafe(
      "DO $role$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END $role$;",
    );
    await database.migrate();
    for (const id of [workspaceId, otherWorkspaceId]) {
      await admin`delete from listing_dispatch_outbox where workspace_id = ${id}`;
      await admin`delete from workspaces where id = ${id}`;
    }
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  /** A draft to hang outbox rows off, since the foreign key is real. */
  async function seedDraft(scope = workspaceId): Promise<string> {
    return forWorkspace(database, scope, async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const context: AuditContext = {
        workspaceId: scope,
        actorId: "test:outbox",
        entityId: listing.id,
      };
      await repos.listings.appendVersion(
        listing.id,
        listingContent,
        context,
        repos.audit,
      );
      return listing.id;
    });
  }

  it("records intent and reports it as unsent until confirmed", async () => {
    const draftId = await seedDraft();
    const key = `listing:${workspaceId}:${draftId}:0`;

    const recorded = await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.record([
        {
          listingId: draftId,
          dedupeKey: key,
          payload: { workspaceId, draftId, activeVersionSequence: 0 },
        },
      ]),
    );
    expect(recorded).toHaveLength(1);

    const pending = await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.pending({ olderThanSeconds: 0, maxRows: 10 }),
    );
    expect(pending.map((row) => row.dedupeKey)).toContain(key);

    await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.markDispatched([recorded[0]!.id]),
    );

    const after = await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.pending({ olderThanSeconds: 0, maxRows: 10 }),
    );
    expect(after.map((row) => row.dedupeKey)).not.toContain(key);
  });

  it("refuses to record the same run key twice", async () => {
    // What the unique index exists for: a retried wave must not become two
    // messages. The second write is a no-op, not an error and not a copy.
    const draftId = await seedDraft();
    const entry = {
      listingId: draftId,
      dedupeKey: `listing:${workspaceId}:${draftId}:7`,
      payload: { workspaceId, draftId, activeVersionSequence: 7 },
    };

    const first = await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.record([entry]),
    );
    const second = await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.record([entry]),
    );

    expect(first).toHaveLength(1);
    // Returns only what THIS call created, so a caller sends exactly what it is
    // responsible for and never re-sends a row another request owns.
    expect(second).toEqual([]);
    const rows =
      await admin`select count(*)::int as n from listing_dispatch_outbox where workspace_id = ${workspaceId} and dedupe_key = ${entry.dedupeKey}`;
    expect(rows[0]?.n).toBe(1);
  });

  it("never re-dates a row that was already confirmed", async () => {
    // The first confirmation is the true one. A re-send must not rewrite it, or
    // the record of when the work actually left becomes fiction.
    const draftId = await seedDraft();
    const [recorded] = await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.record([
        {
          listingId: draftId,
          dedupeKey: `listing:${workspaceId}:${draftId}:9`,
          payload: { workspaceId, draftId, activeVersionSequence: 9 },
        },
      ]),
    );
    await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.markDispatched([recorded!.id]),
    );
    const [first] =
      await admin`select dispatched_at from listing_dispatch_outbox where id = ${recorded!.id}`;

    await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.markDispatched([recorded!.id]),
    );

    const [again] =
      await admin`select dispatched_at from listing_dispatch_outbox where id = ${recorded!.id}`;
    expect(again?.dispatched_at).toEqual(first?.dispatched_at);
  });

  it("counts attempts only while the row is still unsent", async () => {
    const draftId = await seedDraft();
    const [recorded] = await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.record([
        {
          listingId: draftId,
          dedupeKey: `listing:${workspaceId}:${draftId}:11`,
          payload: { workspaceId, draftId, activeVersionSequence: 11 },
        },
      ]),
    );

    await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.markAttempted([recorded!.id]),
    );
    await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.markDispatched([recorded!.id]),
    );
    await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.markAttempted([recorded!.id]),
    );

    const [row] =
      await admin`select attempts from listing_dispatch_outbox where id = ${recorded!.id}`;
    expect(row?.attempts).toBe(1);
  });

  it("keeps one workspace's pending work invisible to another", async () => {
    // Row-level security, not a WHERE clause the code could forget. This table
    // holds queue payloads, so a leak here is a cross-tenant leak.
    const draftId = await seedDraft();
    await forWorkspace(database, workspaceId, (repos) =>
      repos.dispatchOutbox.record([
        {
          listingId: draftId,
          dedupeKey: `listing:${workspaceId}:${draftId}:13`,
          payload: { workspaceId, draftId, activeVersionSequence: 13 },
        },
      ]),
    );

    const seenByOther = await forWorkspace(
      database,
      otherWorkspaceId,
      (repos) =>
        repos.dispatchOutbox.pending({ olderThanSeconds: 0, maxRows: 10 }),
    );

    expect(seenByOther).toEqual([]);
  });

  it("refuses a page larger than a recovery pass should ever read", async () => {
    await expect(
      forWorkspace(database, workspaceId, (repos) =>
        repos.dispatchOutbox.pending({ olderThanSeconds: 0, maxRows: 1000 }),
      ),
    ).rejects.toThrow(/maxRows/);
  });
});
