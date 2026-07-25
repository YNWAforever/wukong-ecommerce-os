import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, forWorkspace } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";

/**
 * A run that failed used to be a dead end: the process route refused to
 * re-drive it, so the only recovery was an engineer replaying the dead-letter
 * queue by hand. `reopenFailed` is what makes an operator retry possible.
 */
describe("reopening a failed pipeline run", () => {
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
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it("returns a failed run to started and drops its orphaned leases", async () => {
    const workspaceId = "ws_pipeline_reopen";
    const result = await forWorkspace(database, workspaceId, async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const input = {
        idempotencyKey: `listing:${workspaceId}:${listing.id}:0`,
        listingId: listing.id,
        activeVersionSequence: 0,
      };
      const started = await repos.pipelineRuns.claimStep({
        ...input,
        step: "started",
      });
      await repos.pipelineRuns.recordStep({
        ...input,
        step: "started",
        leaseToken: started.leaseToken!,
      });
      // Claim `extracted` but never record it: this is the orphaned lease an
      // evicted worker leaves behind.
      const extracted = await repos.pipelineRuns.claimStep({
        ...input,
        step: "extracted",
      });
      await repos.pipelineRuns.fail({
        ...input,
        step: "extracted",
        errorCode: "provider_failure",
        leaseToken: extracted.leaseToken!,
      });

      const failed = await repos.pipelineRuns.getState(input.idempotencyKey);
      const reopened = await repos.pipelineRuns.reopenFailed(
        input.idempotencyKey,
      );
      const after = await repos.pipelineRuns.getState(input.idempotencyKey);
      // The retry must be able to take the orphaned step immediately instead of
      // waiting out its five minute lease.
      const reclaim = await repos.pipelineRuns.claimStep({
        ...input,
        step: "extracted",
      });
      return { failed, reopened, after, reclaim };
    });

    expect(result.failed?.status).toBe("failed");
    expect(result.reopened).toBe(true);
    expect(result.after?.status).toBe("started");
    expect(result.after?.errorCode).toBeNull();
    // Completed work survives, so the retry does not pay for extraction twice.
    expect(result.after?.steps.get("started")?.state).toBe("completed");
    expect(result.after?.steps.has("extracted")).toBe(false);
    expect(result.reclaim.claimed).toBe(true);
  });

  it("refuses to reopen a run that is still in flight", async () => {
    const workspaceId = "ws_pipeline_reopen_guard";
    const result = await forWorkspace(database, workspaceId, async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const input = {
        idempotencyKey: `listing:${workspaceId}:${listing.id}:0`,
        listingId: listing.id,
        activeVersionSequence: 0,
      };
      await repos.pipelineRuns.claimStep({ ...input, step: "started" });
      return repos.pipelineRuns.reopenFailed(input.idempotencyKey);
    });

    expect(result).toBe(false);
  });
});
