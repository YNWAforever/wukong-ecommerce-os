import { randomUUID } from "node:crypto";
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

const workspaceId = `ws_airuns_${randomUUID()}`;

describe("ai run repository", () => {
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
        ('${workspaceId}', '${workspaceId}', '{}'::jsonb);
    `);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  async function createPhysicalRun() {
    return database.forWorkspace(workspaceId, async (repositories) => {
      const listing = await repositories.listings.create({
        target: "shopline",
        note: null,
      });
      const snapshot = await repositories.listingInputs.initialize(
        { listingId: listing.id, actorId: "integration" },
        { workspaceId, actorId: "integration", entityId: listing.id },
        repositories.audit,
      );
      const run = await repositories.pipelineRuns.acceptOperation({
        listingId: listing.id,
        inputRevision: snapshot.revision,
        baseVersionId: null,
        activeVersionSequence: 0,
        requestKey: randomUUID(),
        requestDigest:
          randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
        execution: { input: snapshot },
      });
      return { listing, run };
    });
  }

  it("claims a physical invocation once and finalizes its pending row once", async () => {
    const { listing, run } = await createPhysicalRun();
    const begin = () =>
      database.forWorkspace(workspaceId, (r) =>
        r.aiRuns.beginInvocation({
          listingId: listing.id,
          pipelineRunId: run.id,
          task: "extract",
          stage: "extract",
          callOrdinal: 1,
          provider: "openai",
          model: "test-model",
          promptVersion: "test",
        }),
      );
    expect(await begin()).toEqual({ claimed: true });
    expect(await begin()).toEqual({ claimed: false });
    const [pending] =
      await admin`select status,estimated_cost_usd,input from ai_runs where pipeline_run_id=${run.id}`;
    expect(pending).toMatchObject({
      status: "started",
      estimated_cost_usd: null,
      input: { promptVersion: "test" },
    });

    const finalize = () =>
      database.forWorkspace(workspaceId, (r) =>
        r.aiRuns.finalizeInvocation({
          pipelineRunId: run.id,
          stage: "extract",
          callOrdinal: 1,
          status: "succeeded",
          inputTokens: 10,
          outputTokens: 5,
          latencyMs: 1,
          estimatedCostUsd: "0.010000",
          usageCertainty: "estimated",
        }),
      );
    expect(await finalize()).toBe(true);
    expect(await finalize()).toBe(false);
  });

  it("admits only one concurrent exact-cap hold and retains unknown spend", async () => {
    const first = await createPhysicalRun();
    const second = await createPhysicalRun();
    const reserve = (pipelineRunId: string) =>
      database.forWorkspace(workspaceId, (r) =>
        r.aiBudgetReservations.reserve({
          pipelineRunId,
          reservedUsd: "0.050000",
          workspaceCapUsd: "0.050000",
          pricingVersion: "test",
        }),
      );
    const results = await Promise.all([
      reserve(first.run.id),
      reserve(second.run.id),
    ]);
    expect(results.filter((x) => x.accepted)).toHaveLength(1);
    expect(results.filter((x) => !x.accepted)).toHaveLength(1);
    const accepted = results[0]!.accepted ? first : second;
    await database.forWorkspace(workspaceId, (r) =>
      r.aiRuns.beginInvocation({
        listingId: accepted.listing.id,
        pipelineRunId: accepted.run.id,
        task: "extract",
        stage: "extract",
        callOrdinal: 1,
        provider: "openai",
        model: "test-model",
        promptVersion: "test",
      }),
    );
    expect(
      await database.forWorkspace(workspaceId, (r) =>
        r.aiBudgetReservations.settleFromInvocations(accepted.run.id),
      ),
    ).toBe("unknown");
    expect(
      await database.forWorkspace(workspaceId, (r) =>
        r.aiBudgetReservations.settleFromInvocations(accepted.run.id),
      ),
    ).toBe("unknown");
    const third = await createPhysicalRun();
    expect(await reserve(third.run.id)).toEqual({
      accepted: false,
      state: "budget_blocked",
    });
  });

  it("preserves a pending invocation's unknown cost when migrations replay", async () => {
    const { listing, run } = await createPhysicalRun();
    await database.forWorkspace(workspaceId, (r) =>
      r.aiRuns.beginInvocation({
        listingId: listing.id,
        pipelineRunId: run.id,
        task: "generate",
        stage: "generate",
        callOrdinal: 1,
        provider: "openai",
        model: "test-model",
        promptVersion: "test",
      }),
    );
    await database.migrate();
    const [pending] =
      await admin`select status,estimated_cost_usd,input from ai_runs where pipeline_run_id=${run.id}`;
    expect(pending).toMatchObject({
      status: "started",
      estimated_cost_usd: null,
      input: { promptVersion: "test" },
    });
  });
  it("sums observed cost across the given drafts only", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const first = await repositories.listings.create({
        target: "shopline",
        note: null,
      });
      const second = await repositories.listings.create({
        target: "shopline",
        note: null,
      });

      const run = (
        listingId: string,
        idempotencyKey: string,
        estimatedCostUsd: number,
      ) => ({
        listingId,
        task: "extract" as const,
        idempotencyKey,
        provider: "fake",
        model: "fake-1",
        promptVersion: "1.0.0",
        inputTokens: 10,
        outputTokens: 20,
        latencyMs: 5,
        estimatedCostUsd,
      });

      await repositories.aiRuns.append(run(first.id, "first-a", 0.0125));
      await repositories.aiRuns.append(run(first.id, "first-b", 0.0075));
      await repositories.aiRuns.append(run(second.id, "second-a", 1.5));

      // Two runs on one draft: a sum over the raw text column would
      // concatenate to "0.0125000.007500" instead of adding to 0.02.
      expect(
        await repositories.aiRuns.sumCostForListings([first.id]),
      ).toBeCloseTo(0.02, 6);
      expect(
        await repositories.aiRuns.sumCostForListings([first.id, second.id]),
      ).toBeCloseTo(1.52, 6);
      // The second draft's spend must not leak into the first draft's total.
      expect(
        await repositories.aiRuns.sumCostForListings([second.id]),
      ).toBeCloseTo(1.5, 6);
    });
  });

  it("returns zero for an empty set of drafts without querying", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      expect(await repositories.aiRuns.sumCostForListings([])).toBe(0);
    });
  });
});
