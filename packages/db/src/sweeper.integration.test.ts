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
