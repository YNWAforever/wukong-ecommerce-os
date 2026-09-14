import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, forWorkspace } from "./index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const workspaceId = "ws_sweeper";

describe("findStuckListingJobs", () => {
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
    await admin.unsafe(`DELETE FROM workspaces WHERE id = '${workspaceId}'`);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  async function seedDraftWithAsset(): Promise<string> {
    return forWorkspace(database, workspaceId, async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const upload = await repos.sourceAssets.create({
        storageKey: `ws/${workspaceId}/sources/${listing.id}/label.jpg`,
        kind: "image/jpeg",
        metadata: {},
      });
      await repos.sourceAssets.attachToListing(listing.id, [upload.id]);
      return listing.id;
    });
  }

  function backdateDraft(listingId: string, seconds: number) {
    return admin`update listing_drafts set created_at = now() - make_interval(secs => ${seconds}) where workspace_id = ${workspaceId} and id = ${listingId}`;
  }

  it("finds a received draft with assets, past the grace window, and no run row (shape A)", async () => {
    const listingId = await seedDraftWithAsset();
    await backdateDraft(listingId, 600);

    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
    });

    expect(jobs).toContainEqual({
      workspaceId,
      draftId: listingId,
      activeVersionSequence: 0,
    });
  });

  it("skips a draft still inside the grace window", async () => {
    const listingId = await seedDraftWithAsset();
    // created_at = now(); no backdate.
    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
    });
    expect(jobs.map((job) => job.draftId)).not.toContain(listingId);
  });

  it("skips a received draft with no attached assets", async () => {
    const listingId = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.create({ target: "shopline" }).then((l) => l.id),
    );
    await backdateDraft(listingId, 600);
    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
    });
    expect(jobs.map((job) => job.draftId)).not.toContain(listingId);
  });

  it("skips a draft whose run row already exists at the current sequence", async () => {
    const listingId = await seedDraftWithAsset();
    await backdateDraft(listingId, 600);
    await admin`insert into listing_pipeline_runs (workspace_id, listing_id, active_version_sequence, idempotency_key, status) values (${workspaceId}, ${listingId}, 0, ${"listing:" + workspaceId + ":" + listingId + ":0"}, 'succeeded')`;
    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
    });
    expect(jobs.map((job) => job.draftId)).not.toContain(listingId);
  });

  it("finds a stale started run with no live step lease (shape B)", async () => {
    const listingId = await seedDraftWithAsset();
    await backdateDraft(listingId, 600);
    await admin`insert into listing_pipeline_runs (workspace_id, listing_id, active_version_sequence, idempotency_key, status, updated_at) values (${workspaceId}, ${listingId}, 0, ${"listing:" + workspaceId + ":" + listingId + ":0"}, 'started', now() - interval '600 seconds')`;

    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
    });

    expect(jobs).toContainEqual({
      workspaceId,
      draftId: listingId,
      activeVersionSequence: 0,
    });
  });

  it("skips a started run whose step lease is still live", async () => {
    const listingId = await seedDraftWithAsset();
    await backdateDraft(listingId, 600);
    const [run] =
      await admin`insert into listing_pipeline_runs (workspace_id, listing_id, active_version_sequence, idempotency_key, status, updated_at) values (${workspaceId}, ${listingId}, 0, ${"listing:" + workspaceId + ":" + listingId + ":0"}, 'started', now() - interval '600 seconds') returning id`;
    await admin`insert into listing_pipeline_steps (workspace_id, pipeline_run_id, step, state, updated_at) values (${workspaceId}, ${run!.id}, 'started', 'running', now())`;

    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
    });

    expect(jobs.map((job) => job.draftId)).not.toContain(listingId);
  });

  it("caps results at maxRows", async () => {
    const first = await seedDraftWithAsset();
    const second = await seedDraftWithAsset();
    await backdateDraft(first, 600);
    await backdateDraft(second, 600);

    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 1,
    });

    expect(jobs.length).toBeLessThanOrEqual(1);
  });
});

/**
 * The outbox heals only when somebody advances a batch.
 *
 * `dispatchOutbox.pending()` is read in exactly one place -- inside
 * `advanceBatch` -- and `advanceBatch` has exactly one caller: the operator
 * pressing Advance. So a workspace whose batches have all reached `completed`
 * or `budget_exhausted`, or which nobody touches again, never re-reads its own
 * outbox. Work recorded and never sent stays owed for ever.
 *
 * The existing sweeper cannot see it: `sweeper_find_stuck_listing_jobs` looks
 * for drafts with a source asset and no run row, and a draft enriched from an
 * import has no asset at all. These cases pin the cross-workspace read that
 * gives the Worker's cron something it can act on.
 */
describe("findUndispatchedListingJobs", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });
  const outboxWorkspace = "ws_outbox_sweeper";

  beforeAll(async () => {
    await database.migrate();
    // Outbox rows are ON DELETE RESTRICT against both workspaces and drafts --
    // deliberately, since the row is the evidence work was owed. So they must
    // go first or this cleanup fails on the second run.
    await admin.unsafe(
      `DELETE FROM listing_dispatch_outbox WHERE workspace_id = '${outboxWorkspace}'`,
    );
    await admin.unsafe(
      `DELETE FROM workspaces WHERE id = '${outboxWorkspace}'`,
    );
  });

  afterAll(async () => {
    await admin.unsafe(
      `DELETE FROM listing_dispatch_outbox WHERE workspace_id = '${outboxWorkspace}'`,
    );
    await database.close();
    await admin.end();
  });

  /** Records one owed job and returns its outbox id. */
  async function owe(dedupeKey: string): Promise<{
    outboxId: string;
    draftId: string;
  }> {
    return forWorkspace(database, outboxWorkspace, async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const [entry] = await repos.dispatchOutbox.record([
        {
          listingId: listing.id,
          dedupeKey,
          payload: {
            workspaceId: outboxWorkspace,
            draftId: listing.id,
            activeVersionSequence: 0,
          },
        },
      ]);
      if (!entry) throw new Error("outbox row was not recorded");
      return { outboxId: entry.id, draftId: listing.id };
    });
  }

  function backdate(outboxId: string, seconds: number) {
    return admin`update listing_dispatch_outbox set created_at = now() - make_interval(secs => ${seconds}) where id = ${outboxId}`;
  }

  it("finds work recorded and never confirmed as sent, across workspaces", async () => {
    const { outboxId, draftId } = await owe("listing:outbox:stranded:0");
    await backdate(outboxId, 600);

    const jobs = await database.findUndispatchedListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
      maxAttempts: 5,
    });

    expect(jobs).toContainEqual({
      workspaceId: outboxWorkspace,
      outboxId,
      payload: {
        workspaceId: outboxWorkspace,
        draftId,
        activeVersionSequence: 0,
      },
    });
  });

  it("ignores a row the queue already accepted", async () => {
    const { outboxId } = await owe("listing:outbox:delivered:0");
    await backdate(outboxId, 600);
    await forWorkspace(database, outboxWorkspace, (repos) =>
      repos.dispatchOutbox.markDispatched([outboxId]),
    );

    const jobs = await database.findUndispatchedListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
      maxAttempts: 5,
    });

    expect(jobs.map((job) => job.outboxId)).not.toContain(outboxId);
  });

  it("leaves a wave that is dispatching right now alone", async () => {
    // Not backdated. The web app's own grace window is 60s, so the sweeper's
    // must be longer or the cron would re-send messages an advance is still in
    // the middle of sending.
    const { outboxId } = await owe("listing:outbox:inflight:0");

    const jobs = await database.findUndispatchedListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
      maxAttempts: 5,
    });

    expect(jobs.map((job) => job.outboxId)).not.toContain(outboxId);
  });

  it("stops retrying a row that has failed too many times", async () => {
    // Otherwise a permanently unsendable payload is retried every five minutes
    // for the life of the system. The count is what separates "the queue was
    // down" from "this will never go".
    const { outboxId } = await owe("listing:outbox:poison:0");
    await backdate(outboxId, 600);
    await admin`update listing_dispatch_outbox set attempts = 5 where id = ${outboxId}`;

    const jobs = await database.findUndispatchedListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
      maxAttempts: 5,
    });

    expect(jobs.map((job) => job.outboxId)).not.toContain(outboxId);
  });
});
