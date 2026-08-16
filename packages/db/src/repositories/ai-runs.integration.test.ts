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

const workspaceId = "ws_airuns";

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

  it("counts only runs at or after the given instant", async () => {
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

    // `created_at` defaults to the database's now(), and Postgres freezes
    // now() at transaction start — every statement in one transaction sees
    // the same instant. So the "older" and "this batch" runs are written in
    // separate forWorkspace transactions, the same way two real batches
    // would be separated in time, rather than both inside one transaction
    // where they'd otherwise get an identical created_at.
    const draftId = await database.forWorkspace(
      workspaceId,
      async (repositories) => {
        const draft = await repositories.listings.create({
          target: "shopline",
          note: null,
        });
        await repositories.aiRuns.append(run(draft.id, "older-batch", 4));
        return draft.id;
      },
    );

    // Read the cutoff from the database, not from Date.now(), so this
    // assertion doesn't depend on the app clock and the database clock
    // agreeing.
    const [marker] = await admin<{ now: Date }[]>`select now() as now`;
    const cutoff = marker!.now;
    await new Promise((resolve) => setTimeout(resolve, 10));

    await database.forWorkspace(workspaceId, async (repositories) => {
      await repositories.aiRuns.append(run(draftId, "this-batch", 1.5));

      // Without a bound, the earlier batch's spend is charged to this one.
      expect(
        await repositories.aiRuns.sumCostForListings([draftId]),
      ).toBeCloseTo(5.5, 6);
      expect(
        await repositories.aiRuns.sumCostForListings([draftId], cutoff),
      ).toBeCloseTo(1.5, 6);
    });
  });
});
