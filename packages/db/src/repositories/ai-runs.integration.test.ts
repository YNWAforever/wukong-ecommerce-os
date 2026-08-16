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
});
