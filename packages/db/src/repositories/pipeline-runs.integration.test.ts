import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, forWorkspace } from "../index.js";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl = process.env.TEST_DATABASE_URL ?? "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";

describe("listing pipeline run repository", () => {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined, prepare: false });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });

  beforeAll(async () => {
    await admin.unsafe(`DO $role$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END $role$;`);
    await database.migrate();
    await admin.unsafe("TRUNCATE TABLE workspaces CASCADE");
  });

  afterAll(async () => { await database.close(); await admin.end(); });

  it("keeps one recovery record per listing revision and returns its completed result", async () => {
    const result = await forWorkspace(database, "ws_pipeline", async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const input = {
        idempotencyKey: `listing:ws_pipeline:${listing.id}:0`,
        listingId: listing.id,
        activeVersionSequence: 0,
      };
      const claim = await repos.pipelineRuns.claimStep({ ...input, step: "started" });
      await repos.pipelineRuns.recordStep({ ...input, step: "started", leaseToken: claim.leaseToken! });
      await repos.pipelineRuns.recordStep({ ...input, step: "started", leaseToken: claim.leaseToken! });
      await repos.pipelineRuns.complete({
        ...input,
        step: "started",
        leaseToken: claim.leaseToken!,
        status: "needs_info",
        versionId: null,
      });
      return repos.pipelineRuns.getCompleted(input.idempotencyKey);
    });

    expect(result).toEqual({ status: "needs_info", versionId: null });
  });

  it("hides a pipeline recovery record from another workspace", async () => {
    const owner = await forWorkspace(database, "ws_pipeline_owner", async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const idempotencyKey = `listing:ws_pipeline_owner:${listing.id}:0`;
      const claim = await repos.pipelineRuns.claimStep({
        idempotencyKey,
        listingId: listing.id,
        activeVersionSequence: 0,
        step: "started",
      });
      await repos.pipelineRuns.recordStep({
        idempotencyKey,
        listingId: listing.id,
        activeVersionSequence: 0,
        step: "started",
        leaseToken: claim.leaseToken!,
      });
      await repos.pipelineRuns.complete({
        idempotencyKey,
        listingId: listing.id,
        activeVersionSequence: 0,
        step: "started",
        leaseToken: claim.leaseToken!,
        status: "needs_info",
        versionId: null,
      });
      return idempotencyKey;
    });

    await expect(forWorkspace(database, "ws_pipeline_other", (repos) => repos.pipelineRuns.getCompleted(owner))).resolves.toBeNull();
  });

  it("claims each step once, stores recovery output, and records terminal failure codes", async () => {
    const snapshot = await forWorkspace(database, "ws_pipeline_claim", async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const input = { idempotencyKey: `listing:ws_pipeline_claim:${listing.id}:0`, listingId: listing.id, activeVersionSequence: 0 };
      const first = await repos.pipelineRuns.claimStep({ ...input, step: "extracted" });
      await repos.pipelineRuns.recordStep({ ...input, step: "extracted", leaseToken: first.leaseToken!, output: { missingFields: [] } });
      const second = await repos.pipelineRuns.claimStep({ ...input, step: "extracted" });
      await repos.pipelineRuns.fail({ ...input, errorCode: "provider_timeout" });
      return { first, second, state: await repos.pipelineRuns.getState(input.idempotencyKey) };
    });
    expect(snapshot.first).toMatchObject({ claimed: true, completed: false });
    expect(snapshot.second).toMatchObject({ claimed: false, completed: true, output: { missingFields: [] } });
    expect(snapshot.second.leaseToken).toBeNull();
    expect(snapshot.state).toMatchObject({ status: "failed", errorCode: "provider_timeout" });
    });

  it("completes a run from a cached completed step without a lease token", async () => {
    const result = await forWorkspace(database, "ws_pipeline_cached", async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const input = {
        idempotencyKey: "listing:ws_pipeline_cached:" + listing.id + ":0",
        listingId: listing.id,
        activeVersionSequence: 0,
        step: "generated" as const,
      };
      const claim = await repos.pipelineRuns.claimStep(input);
      await repos.pipelineRuns.recordStep({
        ...input,
        leaseToken: claim.leaseToken!,
        output: { versionId: null },
      });
      await repos.pipelineRuns.complete({
        ...input,
        leaseToken: undefined,
        status: "needs_info",
        versionId: null,
      });
      return repos.pipelineRuns.getCompleted(input.idempotencyKey);
    });
    expect(result).toEqual({ status: "needs_info", versionId: null });
  });

  it("does not let a stale worker release a reclaimed step owned by a newer worker", async () => {
    const initial = await forWorkspace(database, "ws_pipeline_lease", async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const input = {
        idempotencyKey: "listing:ws_pipeline_lease:" + listing.id + ":0",
        listingId: listing.id,
        activeVersionSequence: 0,
        step: "extracted" as const,
      };
      const workerA = await repos.pipelineRuns.claimStep(input);
      return { input, workerA };
    });
    expect(initial.workerA.leaseToken).toEqual(expect.any(String));

    await admin.unsafe(
      "UPDATE listing_pipeline_steps SET updated_at = now() - interval '6 minutes' WHERE workspace_id = $1",
      ["ws_pipeline_lease"],
    );

    const workerB = await forWorkspace(database, "ws_pipeline_lease", (repos) => repos.pipelineRuns.claimStep(initial.input));
    expect(workerB).toMatchObject({ claimed: true, completed: false });
    expect(workerB.leaseToken).toEqual(expect.any(String));
    expect(workerB.leaseToken).not.toBe(initial.workerA.leaseToken);

    await expect(
      forWorkspace(database, "ws_pipeline_lease", (repos) =>
        repos.pipelineRuns.recordStep({
          idempotencyKey: initial.input.idempotencyKey,
          listingId: initial.input.listingId,
          activeVersionSequence: initial.input.activeVersionSequence,
          step: initial.input.step,
          leaseToken: initial.workerA.leaseToken!,
          output: { stale: true },
        }),
      ),
    ).rejects.toThrow("pipeline step lease lost");

    await expect(
      forWorkspace(database, "ws_pipeline_lease", (repos) =>
        repos.pipelineRuns.complete({
          idempotencyKey: initial.input.idempotencyKey,
          listingId: initial.input.listingId,
          activeVersionSequence: initial.input.activeVersionSequence,
          step: initial.input.step,
          leaseToken: initial.workerA.leaseToken!,
          status: "needs_info",
          versionId: null,
        }),
      ),
    ).rejects.toThrow("pipeline step lease lost");

    const afterStaleRelease = await forWorkspace(database, "ws_pipeline_lease", async (repos) => {
      await repos.pipelineRuns.releaseStep({
        idempotencyKey: initial.input.idempotencyKey,
        step: initial.input.step,
        leaseToken: initial.workerA.leaseToken!,
      });
      return repos.pipelineRuns.getState(initial.input.idempotencyKey);
    });
    expect(afterStaleRelease?.steps.get("extracted")).toMatchObject({ state: "running" });

    const afterOwnerRelease = await forWorkspace(database, "ws_pipeline_lease", async (repos) => {
      await repos.pipelineRuns.releaseStep({
        idempotencyKey: initial.input.idempotencyKey,
        step: initial.input.step,
        leaseToken: workerB.leaseToken!,
      });
      return repos.pipelineRuns.getState(initial.input.idempotencyKey);
    });
    expect(afterOwnerRelease?.steps.has("extracted")).toBe(false);
  });
});