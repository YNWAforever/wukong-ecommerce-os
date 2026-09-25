import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type AppendAiRunInput } from "../index.js";

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
    // The runner replays every migration; applying twice must remain safe.
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
  it("counts failed physical invocations with unknown usage without blocking migration replay", async () => {
    const { listing, run } = await createPhysicalRun();
    await database.forWorkspace(workspaceId, async (r) => {
      await r.aiRuns.beginInvocation({
        listingId: listing.id,
        pipelineRunId: run.id,
        task: "generate",
        stage: "generate",
        callOrdinal: 1,
        provider: "openai",
        model: "test-model",
        promptVersion: "test",
      });
      expect(
        await r.aiRuns.finalizeInvocation({
          pipelineRunId: run.id,
          stage: "generate",
          callOrdinal: 1,
          status: "failed",
          inputTokens: null,
          outputTokens: null,
          latencyMs: 1,
          estimatedCostUsd: null,
          usageCertainty: "unknown",
        }),
      ).toBe(true);
    });
    await database.migrate();
    expect(
      await database.forWorkspace(workspaceId, (r) =>
        r.aiRuns.summarizeCostForListings([listing.id]),
      ),
    ).toEqual({ knownCostUsd: 0, unknownCostRunCount: 1 });
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
  async function fixture(ws = workspaceId) {
    const listing = await database.forWorkspace(ws, (r) =>
      r.listings.create({ target: "shopline" }),
    );
    const [version] = await admin`
      INSERT INTO listing_versions (workspace_id, listing_id, sequence, content, created_by)
      VALUES (${ws}, ${listing.id}, 1, '{}'::jsonb, 'test') RETURNING id
    `;
    return { listingId: listing.id, listingVersionId: version!.id as string };
  }

  function verification(
    ids: { listingId: string; listingVersionId: string },
    key: string,
    cost: number | null = null,
  ): AppendAiRunInput {
    return {
      ...ids,
      task: "verify",
      idempotencyKey: key,
      provider: "fake",
      model: "fake-1",
      promptVersion: "1",
      inputTokens: null,
      outputTokens: null,
      latencyMs: 5,
      estimatedCostUsd: cost,
      output: {
        listingVersionId: ids.listingVersionId,
        estimatedCostUsd: cost,
      },
    };
  }

  it("summarizes mixed known and unknown costs and appends idempotently", async () => {
    const ids = await fixture();
    await database.forWorkspace(workspaceId, async (r) => {
      await r.aiRuns.append(verification(ids, "unknown"));
      await r.aiRuns.append(verification(ids, "unknown"));
      await r.aiRuns.append(verification(ids, "known", 0.123456789));
      await r.aiRuns.append({
        ...verification(ids, "extract", 0.01),
        task: "extract",
        inputTokens: 1,
        outputTokens: 2,
        estimatedCostUsd: 0.01,
      });
      expect(await r.aiRuns.summarizeCostForListings([ids.listingId])).toEqual({
        knownCostUsd: 0.133457,
        unknownCostRunCount: 1,
      });
      expect(await r.aiRuns.sumCostForListings([ids.listingId])).toBe(0.133457);
      expect(await r.aiRuns.summarizeCostForListings([])).toEqual({
        knownCostUsd: 0,
        unknownCostRunCount: 0,
      });
    });
    const rows =
      await admin`SELECT output, estimated_cost_usd FROM ai_runs WHERE listing_id = ${ids.listingId} AND idempotency_key = 'known'`;
    expect(rows[0]!.output.estimatedCostUsd).toBe(0.123456789);
  });

  it("rejects output version mismatch and same-workspace wrong-listing versions", async () => {
    const first = await fixture();
    const second = await fixture();
    await expect(
      database.forWorkspace(workspaceId, (r) =>
        r.aiRuns.append({
          ...verification(first, "mismatch", 0),
          output: { listingVersionId: second.listingVersionId },
        }),
      ),
    ).rejects.toThrow("verification output version does not match");
    await expect(
      database.forWorkspace(workspaceId, (r) =>
        r.aiRuns.append(
          verification(
            { ...first, listingVersionId: second.listingVersionId },
            "wrong",
            0,
          ),
        ),
      ),
    ).rejects.toThrow("verification version does not belong to listing");
  });

  it("isolates foreign workspace versions and cost aggregation", async () => {
    const foreign = await fixture("ws_airuns_foreign");
    await database.forWorkspace("ws_airuns_foreign", (r) =>
      r.aiRuns.append(verification(foreign, "foreign")),
    );
    await expect(
      database.forWorkspace(workspaceId, (r) =>
        r.aiRuns.append(verification(foreign, "cross", 0)),
      ),
    ).rejects.toThrow("verification version does not belong to listing");
    await database.forWorkspace(workspaceId, async (r) => {
      expect(
        await r.aiRuns.summarizeCostForListings([foreign.listingId]),
      ).toEqual({ knownCostUsd: 0, unknownCostRunCount: 0 });
      expect(await r.aiRuns.sumCostForListings([foreign.listingId])).toBe(0);
    });
  });

  it("retains verification of historical versions after a new active version", async () => {
    const ids = await fixture();
    await database.forWorkspace(workspaceId, (r) =>
      r.aiRuns.append(verification(ids, "historical")),
    );
    const [next] =
      await admin`INSERT INTO listing_versions (workspace_id, listing_id, sequence, content, created_by) VALUES (${workspaceId}, ${ids.listingId}, 2, '{}'::jsonb, 'test') RETURNING id`;
    await admin`UPDATE listing_drafts SET active_version_id = ${next!.id} WHERE id = ${ids.listingId}`;
    await database.forWorkspace(workspaceId, (r) =>
      r.aiRuns.append(verification(ids, "historical-again", 0)),
    );
    const rows =
      await admin`SELECT output FROM ai_runs WHERE listing_id = ${ids.listingId}`;
    expect(rows).toHaveLength(2);
    expect(
      rows.every((row) => row.output.listingVersionId === ids.listingVersionId),
    ).toBe(true);
  });

  it.each([
    { inputTokens: -1 },
    { outputTokens: -1 },
    { inputTokens: 1.5 },
    { estimatedCostUsd: -0.1 },
    { estimatedCostUsd: Number.NaN },
    { estimatedCostUsd: Infinity },
  ])("rejects invalid verification usage %j", async (override) => {
    const ids = await fixture();
    await expect(
      database.forWorkspace(workspaceId, (r) =>
        r.aiRuns.append({ ...verification(ids, "invalid", 0), ...override }),
      ),
    ).rejects.toThrow("verification usage must be nonnegative");
  });

  it.each([
    {
      task: "extract",
      cost: null,
      constraint: "ai_runs_nonverification_cost_required",
    },
    {
      task: "generate",
      cost: null,
      constraint: "ai_runs_nonverification_cost_required",
    },
    {
      task: "product_shot",
      cost: null,
      constraint: "ai_runs_nonverification_cost_required",
    },
    {
      task: "verify",
      cost: -0.1,
      constraint: "ai_runs_nonnegative_known_cost",
    },
  ])(
    "enforces the migration constraint for $task / $cost",
    async ({ task, cost, constraint }) => {
      const ids = await fixture();
      await expect(admin`
      INSERT INTO ai_runs (workspace_id, listing_id, task, idempotency_key, provider, model, status, input, latency_ms, estimated_cost_usd)
      VALUES (${workspaceId}, ${ids.listingId}, ${task}, 'constraint', 'fake', 'fake-1', 'succeeded', '{}'::jsonb, 0, ${cost})
    `).rejects.toMatchObject({ code: "23514", constraint_name: constraint });
    },
  );
});
