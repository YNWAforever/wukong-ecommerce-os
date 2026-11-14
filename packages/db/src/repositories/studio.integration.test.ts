import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

import { createDatabase, type Database } from "../client.js";
import { loadSqlMigrations } from "../migrations.js";

/**
 * Repository contract for the Conversation Studio tables.
 *
 * Runs through the non-superuser `wukong_app` role so RLS and grants are part
 * of the behaviour under test, against an explicitly named disposable database.
 */
const url = process.env.STUDIO_TEST_DATABASE_ADMIN_URL;
const enabled = !!url && process.env.STUDIO_TEST_DISPOSABLE === "yes";

if (enabled) {
  const target = new URL(url!);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.pathname !== "/wukong_studio_test" ||
    url === process.env.TEST_DATABASE_ADMIN_URL
  )
    throw new Error("Refusing non-isolated studio repository target");
}

const appUrl = enabled
  ? (() => {
      const target = new URL(url!);
      target.username = "wukong_app";
      target.password = "wukong-app-local";
      return target.toString();
    })()
  : null;

const admin = enabled
  ? postgres(url!, { max: 1, onnotice: () => undefined, prepare: false })
  : null;
const db: Database | null = enabled ? createDatabase(appUrl!) : null;

const migrations = await loadSqlMigrations(
  new URL("../../drizzle/", import.meta.url),
);

const WORKSPACE_A = "studio-repo-a";
const WORKSPACE_B = "studio-repo-b";

async function reset(): Promise<void> {
  const [target] = await admin!`select current_database() as name`;
  expect(target!.name).toBe("wukong_studio_test");
  await admin!.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  for (const migration of migrations)
    await admin!.begin(async (tx) => {
      await tx.unsafe(migration.sql);
    });
  await admin!`
    insert into workspaces(id, name, profile)
    values (${WORKSPACE_A}, 'Studio Repo A', '{}'), (${WORKSPACE_B}, 'Studio Repo B', '{}')
  `;
}

function studioRepositories<T>(
  workspaceId: string,
  work: (
    repos: Parameters<Parameters<Database["forWorkspace"]>[1]>[0],
  ) => Promise<T>,
): Promise<T> {
  return db!.forWorkspace(workspaceId, work);
}

afterAll(async () => {
  await db?.close();
  await admin?.end();
});

describe.skipIf(!enabled)("studio repositories", () => {
  beforeAll(reset);

  it("isolates workspaces and hides foreign rows", async () => {
    const created = await db!.forWorkspace(WORKSPACE_A, (repos) =>
      repos.studio.threads.create({
        createdBy: "actor-a",
        title: "A thread",
      }),
    );
    const foreign = await db!.forWorkspace(WORKSPACE_B, async (repos) => {
      const thread = await repos.studio.threads.getWithMessages(created.id);
      const list = await repos.studio.threads.list();
      const output = await repos.studio.outputs.get(created.id);
      return { thread, list, output };
    });
    expect(foreign.thread).toBeNull();
    expect(foreign.list.items).toEqual([]);
    expect(foreign.output).toBeNull();
  });

  it("searches threads server-side with LIKE escaping and workspace isolation", async () => {
    const ids = await studioRepositories(WORKSPACE_A, async (repos) => {
      const make = (title: string, skillKey: string) =>
        repos.studio.threads.create({
          createdBy: "actor-a",
          title,
          skillKey,
        });
      const margaux = await make("Margaux tasting", "catalog.find");
      const audit = await make("Workspace audit", "merchant.audit");
      const percent = await make("100% coverage", "catalog.find");
      const score = await make("100x coverage", "catalog.find");
      await repos.studio.threads.create({
        createdBy: "actor-a",
        title: "Percent only",
        skillKey: null,
      });
      return { margaux, audit, percent, score };
    });

    const search = (q: string) =>
      studioRepositories(WORKSPACE_A, (repos) =>
        repos.studio.threads.list({ q }),
      );

    // Case-insensitive title match.
    expect((await search("MARGAUX")).items.map((thread) => thread.id)).toEqual([
      ids.margaux.id,
    ]);
    // Skill-key match is included.
    expect(
      (await search("merchant.audit")).items.map((thread) => thread.id),
    ).toEqual([ids.audit.id]);
    // `%` is a literal, so "100%" matches only the title that really has it.
    const percentHits = (await search("100%")).items.map((thread) => thread.id);
    expect(percentHits).toEqual([ids.percent.id]);
    expect(percentHits).not.toContain(ids.score.id);
    // The same query from the other workspace sees nothing.
    expect(
      await studioRepositories(WORKSPACE_B, (repos) =>
        repos.studio.threads.list({ q: "margaux" }),
      ),
    ).toMatchObject({ items: [] });
  });

  it("filters outputs server-side by title search, kind and status with isolation", async () => {
    const made = await studioRepositories(WORKSPACE_A, async (repos) => {
      const create = async (
        kind: "copy_proposal" | "finding",
        title: string,
      ) => {
        const output = await repos.studio.outputs.create({
          kind,
          title,
          createdBy: "actor-a",
        });
        // A real artifact has a persisted version before it can be saved;
        // `setStatus` refuses outputs whose current_version is still 0.
        await repos.studio.outputs.addVersion({
          outputId: output.id,
          payload: { schemaVersion: "test/v1", title },
          contentDigest: "a".repeat(64),
          asOf: new Date("2026-11-08T00:00:00.000Z"),
          createdBy: "actor-a",
        });
        return output;
      };
      const proposal = await create("copy_proposal", "Proposal Margaux");
      const finding = await create("finding", "Finding Margaux");
      const draft = await create("copy_proposal", "Proposal Rioja");
      await repos.studio.outputs.setStatus(proposal.id, "saved");
      await repos.studio.outputs.setStatus(finding.id, "signed_off");
      return { proposal, finding, draft };
    });

    const list = (input: {
      q?: string;
      kind?: "copy_proposal" | "finding";
      status?: "draft" | "saved" | "signed_off";
      offset?: number;
      limit?: number;
    }) =>
      studioRepositories(WORKSPACE_A, (repos) =>
        repos.studio.outputs.list(input),
      ).then((listed) => listed.items);

    const byTitle = await list({ q: "margaux" });
    expect(byTitle.map((row) => row.id).sort()).toEqual(
      [made.proposal.id, made.finding.id].sort(),
    );
    const byKind = await list({ kind: "finding" });
    expect(byKind.map((row) => row.id)).toEqual([made.finding.id]);
    const byStatus = await list({ status: "saved" });
    expect(byStatus.map((row) => row.id)).toEqual([made.proposal.id]);
    const combined = await list({
      q: "proposal",
      kind: "copy_proposal",
      status: "draft",
    });
    expect(combined.map((row) => row.id)).toEqual([made.draft.id]);
    // `%`/`_` are literals rather than wildcards.
    expect(await list({ q: "%" })).toEqual([]);
    expect(await list({ q: "_" })).toEqual([]);
    // Workspace isolation holds for filtered reads too.
    expect(
      await studioRepositories(WORKSPACE_B, (repos) =>
        repos.studio.outputs.list({ q: "margaux" }),
      ).then((listed) => listed.items),
    ).toEqual([]);
  });

  it("paginates threads and outputs by offset with has-more truncation", async () => {
    const createdThreads = await studioRepositories(
      WORKSPACE_A,
      async (repos) => {
        const rows = [];
        for (let index = 0; index < 5; index += 1)
          rows.push(
            await repos.studio.threads.create({
              createdBy: "actor-a",
              title: `Page thread ${index}`,
            }),
          );
        return rows;
      },
    );
    const threadPage = (offset: number, extra: { q?: string } = {}) =>
      studioRepositories(WORKSPACE_A, (repos) =>
        repos.studio.threads.list({
          limit: 2,
          offset,
          q: "page thread",
          ...extra,
        }),
      );

    const firstThreads = await threadPage(0);
    expect(firstThreads.items).toHaveLength(2);
    expect(firstThreads.truncated).toBe(true);
    const secondThreads = await threadPage(2);
    expect(secondThreads.items).toHaveLength(2);
    expect(secondThreads.truncated).toBe(true);
    const thirdThreads = await threadPage(4);
    expect(thirdThreads.items).toHaveLength(1);
    expect(thirdThreads.truncated).toBe(false);
    const beyondThreads = await threadPage(10);
    expect(beyondThreads.items).toEqual([]);
    expect(beyondThreads.truncated).toBe(false);
    const pagedIds = [
      ...firstThreads.items,
      ...secondThreads.items,
      ...thirdThreads.items,
    ].map((thread) => thread.id);
    expect(new Set(pagedIds).size).toBe(5);
    expect(new Set(pagedIds)).toEqual(
      new Set(createdThreads.map((thread) => thread.id)),
    );
    // A search composes with the offset instead of resetting it.
    const searchedThreads = await threadPage(1, { q: "page thread" });
    expect(searchedThreads.items).toHaveLength(2);
    expect(searchedThreads.truncated).toBe(true);

    const createdOutputs = await studioRepositories(
      WORKSPACE_A,
      async (repos) => {
        const rows = [];
        for (let index = 0; index < 5; index += 1)
          rows.push(
            await repos.studio.outputs.create({
              kind: index % 2 === 0 ? "copy_proposal" : "finding",
              title: `Output page ${index}`,
              createdBy: "actor-a",
            }),
          );
        return rows;
      },
    );
    expect(createdOutputs).toHaveLength(5);
    const outputPage = (input: {
      offset: number;
      q?: string;
      kind?: "copy_proposal" | "finding";
    }) =>
      studioRepositories(WORKSPACE_A, (repos) =>
        repos.studio.outputs.list({ limit: 2, q: "output page", ...input }),
      );

    const firstOutputs = await outputPage({ offset: 0 });
    expect(firstOutputs.items).toHaveLength(2);
    expect(firstOutputs.truncated).toBe(true);
    const secondOutputs = await outputPage({ offset: 2 });
    expect(secondOutputs.items).toHaveLength(2);
    expect(secondOutputs.truncated).toBe(true);
    const thirdOutputs = await outputPage({ offset: 4 });
    expect(thirdOutputs.items).toHaveLength(1);
    expect(thirdOutputs.truncated).toBe(false);
    expect((await outputPage({ offset: 10 })).items).toEqual([]);
    // Filters compose with the offset rather than being dropped.
    const filteredOutputs = await outputPage({ offset: 1, kind: "finding" });
    expect(filteredOutputs.items).toHaveLength(1);
    expect(filteredOutputs.items[0]?.kind).toBe("finding");
    const searchedOutputs = await outputPage({ offset: 1, q: "output page" });
    expect(searchedOutputs.items).toHaveLength(2);
    expect(searchedOutputs.truncated).toBe(true);
  });

  it("applies thread visibility in SQL before pagination", async () => {
    const made = await studioRepositories(WORKSPACE_A, async (repos) => {
      const create = (
        title: string,
        visibility: "workspace" | "private",
        createdBy: string,
      ) => repos.studio.threads.create({ title, visibility, createdBy });
      const aShared = await create(
        "Visibility A shared",
        "workspace",
        "actor-a",
      );
      const aPrivate = await create(
        "Visibility A private",
        "private",
        "actor-a",
      );
      const bShared = await create(
        "Visibility B shared",
        "workspace",
        "actor-b",
      );
      const bPrivateOne = await create(
        "Visibility B private one",
        "private",
        "actor-b",
      );
      const bPrivateTwo = await create(
        "Visibility B private two",
        "private",
        "actor-b",
      );
      const percent = await create(
        "Visibility 100% literal",
        "workspace",
        "actor-b",
      );
      return { aShared, aPrivate, bShared, bPrivateOne, bPrivateTwo, percent };
    });

    const page = (
      input: {
        viewerId?: string;
        includePrivate?: boolean;
        offset?: number;
        limit?: number;
        q?: string;
      } = {},
    ) =>
      studioRepositories(WORKSPACE_A, (repos) =>
        repos.studio.threads.list({
          q: "visibility",
          limit: 2,
          offset: 0,
          ...input,
        }),
      );

    // A plain member sees workspace threads plus only their own private ones.
    const aFirst = await page({ viewerId: "actor-a" });
    expect(aFirst.items).toHaveLength(2);
    expect(aFirst.truncated).toBe(true);
    const aSecond = await page({ viewerId: "actor-a", offset: 2 });
    expect(aSecond.items).toHaveLength(2);
    expect(aSecond.truncated).toBe(false);
    const aIds = [...aFirst.items, ...aSecond.items].map((thread) => thread.id);
    expect(new Set(aIds)).toEqual(
      new Set([
        made.aShared.id,
        made.aPrivate.id,
        made.bShared.id,
        made.percent.id,
      ]),
    );
    expect(aIds).not.toContain(made.bPrivateOne.id);
    expect(aIds).not.toContain(made.bPrivateTwo.id);

    // The other member sees the same workspace threads plus their own private
    // ones, and still never the first member's private thread.
    const bFirst = await page({ viewerId: "actor-b" });
    expect(bFirst.items).toHaveLength(2);
    expect(bFirst.truncated).toBe(true);
    const bLast = await page({ viewerId: "actor-b", offset: 4 });
    expect(bLast.items).toHaveLength(1);
    expect(bLast.truncated).toBe(false);
    const bIds = [
      ...bFirst.items,
      ...(await page({ viewerId: "actor-b", offset: 2 })).items,
      ...bLast.items,
    ].map((thread) => thread.id);
    expect(new Set(bIds)).toEqual(
      new Set([
        made.aShared.id,
        made.bShared.id,
        made.bPrivateOne.id,
        made.bPrivateTwo.id,
        made.percent.id,
      ]),
    );
    expect(bIds).not.toContain(made.aPrivate.id);

    // Admin/owner includePrivate lifts the restriction and pages evenly.
    const adminFirst = await page({
      viewerId: "actor-admin",
      includePrivate: true,
    });
    const adminSecond = await page({
      viewerId: "actor-admin",
      includePrivate: true,
      offset: 2,
    });
    const adminThird = await page({
      viewerId: "actor-admin",
      includePrivate: true,
      offset: 4,
    });
    expect(adminFirst.items).toHaveLength(2);
    expect(adminFirst.truncated).toBe(true);
    expect(adminSecond.items).toHaveLength(2);
    expect(adminThird.items).toHaveLength(2);
    expect(adminThird.truncated).toBe(false);
    expect(
      new Set(
        [...adminFirst.items, ...adminSecond.items, ...adminThird.items].map(
          (thread) => thread.id,
        ),
      ).size,
    ).toBe(6);

    // Omitting viewerId preserves the unfiltered internal read.
    const unfiltered = await page();
    expect(unfiltered.items).toHaveLength(2);
    expect(unfiltered.truncated).toBe(true);

    // Visibility composes with LIKE-escaped search: `%` is a literal.
    const percentLiteral = await page({
      viewerId: "actor-a",
      q: "100% literal",
    });
    expect(percentLiteral.items.map((thread) => thread.id)).toEqual([
      made.percent.id,
    ]);
    const wildcardLiteral = await page({
      viewerId: "actor-a",
      q: "% literal",
    });
    expect(wildcardLiteral.items.map((thread) => thread.id)).toEqual([
      made.percent.id,
    ]);
  });

  it("aggregates windowed studio usage for one workspace", async () => {
    // Start the window just before this test's fixtures so rows left by earlier
    // tests in the shared workspace are not counted here.
    const since = new Date(Date.now() - 50);
    const made = await studioRepositories(WORKSPACE_A, async (repos) => {
      const thread = await repos.studio.threads.create({
        createdBy: "actor-a",
        title: "Usage metrics thread",
      });
      const trigger = await repos.studio.messages.append({
        threadId: thread.id,
        role: "operator",
        content: { text: "usage" },
        createdBy: "actor-a",
      });
      await repos.studio.messages.append({
        threadId: thread.id,
        role: "assistant",
        content: { text: "ok" },
        createdBy: "studio",
      });
      const createRun = async (idempotencyKey: string) => {
        const { run } = await repos.studio.runs.create({
          threadId: thread.id,
          triggerMessageId: trigger.message.id,
          skillKey: "catalog.find",
          skillVersion: "1.0.0",
          idempotencyKey,
        });
        return run;
      };
      const succeeded = await createRun("usage-r1");
      await repos.studio.runs.markRunning(succeeded.id);
      await repos.studio.runs.complete(succeeded.id, {
        inputTokens: 100,
        outputTokens: 50,
        settledUsd: "0.020000",
      });
      const failed = await createRun("usage-r2");
      await repos.studio.runs.markRunning(failed.id);
      await repos.studio.runs.fail(failed.id, {
        errorCode: "reply_persistence_failed",
        inputTokens: 10,
        outputTokens: 5,
        settledUsd: "0.005000",
      });
      const unknown = await createRun("usage-r3");
      await repos.studio.runs.fail(unknown.id, {
        errorCode: "outcome",
        outcomeUnknown: true,
      });
      const queued = await createRun("usage-r4");
      const running = await createRun("usage-r5");
      await repos.studio.runs.markRunning(running.id);
      await repos.studio.budget.reserve({
        runId: succeeded.id,
        pricingVersion: "p1",
        reservedUsd: "0.020000",
        workspaceCapUsd: "10.000000",
      });
      await repos.studio.budget.settle(succeeded.id, "0.020000");
      await repos.studio.budget.reserve({
        runId: failed.id,
        pricingVersion: "p1",
        reservedUsd: "0.010000",
        workspaceCapUsd: "10.000000",
      });
      // A failed reply can still have a settled provider cost.
      await repos.studio.budget.settle(failed.id, "0.005000");
      await repos.studio.budget.reserve({
        runId: queued.id,
        pricingVersion: "p1",
        reservedUsd: "0.030000",
        workspaceCapUsd: "10.000000",
      });
      const statuses = [
        "ok",
        "denied",
        "error",
        "unavailable",
        "schema_drift",
      ] as const;
      const mcpIds: string[] = [];
      for (const [index, status] of statuses.entries()) {
        const call = await repos.studio.mcpCalls.append({
          toolName: `usage.tool.${index}`,
          requestDigest: "a".repeat(64),
          status,
          caller: "agent",
        });
        mcpIds.push(call.id);
      }
      return { thread, unknown, queued, mcpIds, succeeded };
    });

    // A second workspace's rows must never contribute to A's summary.
    const foreign = await studioRepositories(WORKSPACE_B, async (repos) => {
      const thread = await repos.studio.threads.create({
        createdBy: "actor-b",
        title: "Foreign usage thread",
      });
      const trigger = await repos.studio.messages.append({
        threadId: thread.id,
        role: "operator",
        content: { text: "foreign" },
        createdBy: "actor-b",
      });
      const { run } = await repos.studio.runs.create({
        threadId: thread.id,
        triggerMessageId: trigger.message.id,
        skillKey: "catalog.find",
        skillVersion: "1.0.0",
        idempotencyKey: "usage-foreign-r1",
      });
      await repos.studio.runs.fail(run.id, { errorCode: "foreign" });
      await repos.studio.mcpCalls.append({
        toolName: "usage.foreign.tool",
        requestDigest: "b".repeat(64),
        status: "ok",
        caller: "agent",
      });
      return run;
    });
    expect(foreign.id).toBeDefined();

    const summary = await studioRepositories(WORKSPACE_A, (repos) =>
      repos.studio.metrics.summary({ since }),
    );
    expect(summary.runs).toEqual({
      total: 5,
      succeeded: 1,
      failed: 1,
      cancelled: 0,
      outcomeUnknown: 1,
      queuedOrRunning: 2,
    });
    expect(Number(summary.tokens.input)).toBe(110);
    expect(Number(summary.tokens.output)).toBe(55);
    expect(Number(summary.spend.settledUsd)).toBeCloseTo(0.025, 6);
    expect(Number(summary.spend.reservedUsd)).toBeCloseTo(0.06, 6);
    expect(summary.mcpCalls).toEqual({
      total: 5,
      ok: 1,
      denied: 1,
      error: 1,
      unavailable: 1,
      schemaDrift: 1,
    });
    expect(summary.threadsCreated).toBe(1);
    expect(summary.messages).toBe(2);

    // Boundary: a row exactly at `since` is included; 1 ms later it is not.
    const atBoundary = await studioRepositories(WORKSPACE_A, (repos) =>
      repos.studio.metrics.summary({ since: made.unknown.createdAt }),
    );
    expect(atBoundary.runs.outcomeUnknown).toBe(1);
    const afterBoundary = await studioRepositories(WORKSPACE_A, (repos) =>
      repos.studio.metrics.summary({
        since: new Date(made.unknown.createdAt.getTime() + 1),
      }),
    );
    expect(afterBoundary.runs.outcomeUnknown).toBe(0);

    // A future window excludes everything (no silent inclusion).
    const empty = await studioRepositories(WORKSPACE_A, (repos) =>
      repos.studio.metrics.summary({
        since: new Date(Date.now() + 60_000),
      }),
    );
    expect(empty.runs.total).toBe(0);
    expect(empty.mcpCalls.total).toBe(0);
    expect(empty.threadsCreated).toBe(0);
    expect(empty.messages).toBe(0);

    const foreignSummary = await studioRepositories(WORKSPACE_B, (repos) =>
      repos.studio.metrics.summary({ since }),
    );
    expect(foreignSummary.runs.total).toBe(1);
    expect(foreignSummary.mcpCalls.total).toBe(1);
    expect(foreignSummary.threadsCreated).toBe(1);
  });

  it("defaults settings and round-trips an explicit configuration", async () => {
    const defaults = await db!.forWorkspace(WORKSPACE_A, (repos) =>
      repos.studio.settings.get(),
    );
    expect(defaults).toMatchObject({
      workspaceId: WORKSPACE_A,
      enabled: false,
      allowedSkills: [],
      monthlyBudgetUsd: null,
      ai: null,
    });

    const saved = await db!.forWorkspace(WORKSPACE_A, (repos) =>
      repos.studio.settings.upsert(
        {
          enabled: true,
          allowedSkills: ["catalog.find", "catalog.gap_review"],
          monthlyBudgetUsd: "5.000000",
          runCeilingUsd: "0.500000",
          retentionDays: 30,
          defaultHome: false,
          ai: {
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            pricingVersion: "studio-v1",
            maxInputTokens: 1048576,
            inputUsdPerMillion: "0.3",
            outputUsdPerMillion: "1.2",
            maxOutputTokens: 4096,
          },
        },
        "admin-a",
      ),
    );
    expect(saved.enabled).toBe(true);
    expect(saved.allowedSkills).toEqual(["catalog.find", "catalog.gap_review"]);
    expect(saved.ai?.provider).toBe("opencode-go");
    expect(saved.updatedBy).toBe("admin-a");
  });

  it("appends messages with a stable sequence and idempotent client ids", async () => {
    const { thread, first, replay, second, loaded } = await db!.forWorkspace(
      WORKSPACE_B,
      async (repos) => {
        const thread = await repos.studio.threads.create({
          createdBy: "actor-b",
          title: "Idempotent thread",
        });
        const first = await repos.studio.messages.append({
          threadId: thread.id,
          role: "operator",
          content: { text: "hello" },
          clientMessageId: "client-1",
          createdBy: "actor-b",
        });
        const replay = await repos.studio.messages.append({
          threadId: thread.id,
          role: "operator",
          content: { text: "hello again" },
          clientMessageId: "client-1",
          createdBy: "actor-b",
        });
        const second = await repos.studio.messages.append({
          threadId: thread.id,
          role: "assistant",
          content: { text: "answer" },
          createdBy: "assistant",
        });
        const loaded = await repos.studio.threads.getWithMessages(thread.id);
        return { thread, first, replay, second, loaded };
      },
    );
    expect(first.replayed).toBe(false);
    expect(first.message.sequence).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(replay.message.id).toBe(first.message.id);
    expect(second.message.sequence).toBe(2);
    expect(loaded?.messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(loaded?.thread.lastMessageAt).not.toBeNull();
  });

  it("serialises concurrent run events into one ordered trace", async () => {
    const { run, traced } = await db!.forWorkspace(
      WORKSPACE_A,
      async (repos) => {
        const thread = await repos.studio.threads.create({
          createdBy: "actor-a",
          title: "Trace thread",
        });
        const message = await repos.studio.messages.append({
          threadId: thread.id,
          role: "operator",
          content: { text: "start" },
          clientMessageId: "trace-1",
          createdBy: "actor-a",
        });
        const run = await repos.studio.runs.create({
          threadId: thread.id,
          triggerMessageId: message.message.id,
          skillKey: "catalog.find",
          skillVersion: "1.0.0",
          idempotencyKey: "run-trace-1",
          promptVersions: { planner: "1.0.0" },
        });
        return { run: run.run, traced: true };
      },
    );

    const appendEvent = (state: string) =>
      db!.forWorkspace(WORKSPACE_A, (repos) =>
        repos.studio.runEvents.appendMany(run.id, [
          { kind: "tool", state: state as "done", toolId: "catalog.search" },
        ]),
      );
    await Promise.all([appendEvent("done"), appendEvent("done")]);
    const events = await db!.forWorkspace(WORKSPACE_A, (repos) =>
      repos.studio.runEvents.list(run.id),
    );
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("keeps run lifecycle and output versions durable", async () => {
    const { run, completed, replayedRun } = await db!.forWorkspace(
      WORKSPACE_A,
      async (repos) => {
        const thread = await repos.studio.threads.create({
          createdBy: "actor-a",
          title: "Runs thread",
        });
        const message = await repos.studio.messages.append({
          threadId: thread.id,
          role: "operator",
          content: { text: "make a report" },
          clientMessageId: "run-msg-1",
          createdBy: "actor-a",
        });
        const created = await repos.studio.runs.create({
          threadId: thread.id,
          triggerMessageId: message.message.id,
          skillKey: "merchant.audit",
          skillVersion: "1.0.0",
          idempotencyKey: "run-1",
        });
        const again = await repos.studio.runs.create({
          threadId: thread.id,
          triggerMessageId: message.message.id,
          skillKey: "merchant.audit",
          skillVersion: "1.0.0",
          idempotencyKey: "run-1",
        });
        await repos.studio.runs.markRunning(created.run.id);
        const completed = await repos.studio.runs.complete(created.run.id, {
          provider: "opencode-go",
          model: "deepseek-v4.1-flash",
          inputTokens: 100,
          outputTokens: 20,
          estimatedCostUsd: "0.010000",
          settledUsd: "0.010000",
        });
        return {
          run: created.run,
          completed,
          replayedRun: again,
        };
      },
    );
    expect(replayedRun.replayed).toBe(true);
    expect(replayedRun.run.id).toBe(run.id);
    expect(completed?.status).toBe("succeeded");
    expect(completed?.settledUsd).toBe("0.010000");
    const persisted = await db!.forWorkspace(WORKSPACE_A, (repos) =>
      repos.studio.runs.get(run.id),
    );
    expect(persisted).toMatchObject({
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
    });
    expect(
      await db!.forWorkspace(WORKSPACE_B, (repos) =>
        repos.studio.runs.get(run.id),
      ),
    ).toBeNull();

    const output = await db!.forWorkspace(WORKSPACE_A, async (repos) => {
      const created = await repos.studio.outputs.create({
        threadId: null,
        runId: run.id,
        kind: "merchant_audit",
        title: "Merchant audit",
        createdBy: "actor-a",
      });
      const first = await repos.studio.outputs.addVersion({
        outputId: created.id,
        payload: { checks: [] },
        contentDigest: "a".repeat(64),
        asOf: new Date("2026-11-08T00:00:00Z"),
        createdBy: "actor-a",
      });
      const second = await repos.studio.outputs.addVersion({
        outputId: created.id,
        payload: { checks: [{ id: "seo" }] },
        contentDigest: "b".repeat(64),
        asOf: new Date("2026-11-08T00:00:00Z"),
        createdBy: "actor-a",
      });
      const versions = await repos.studio.outputs.versions(created.id);
      const saved = await repos.studio.outputs.setStatus(created.id, "saved");
      return { first, second, versions, saved, outputId: created.id };
    });
    expect(output.first.version.revision).toBe(1);
    expect(output.second.version.revision).toBe(2);
    expect(output.second.output.currentVersion).toBe(2);
    expect(output.versions.map((version) => version.revision)).toEqual([2, 1]);
    expect(output.saved).toBe(true);
    expect(output.outputId).toBeTruthy();
  });

  it("confirms only the current status/revision/digest and clears approval on a new version", async () => {
    const outputId = await studioRepositories(WORKSPACE_A, async (repos) => {
      const output = await repos.studio.outputs.create({
        kind: "merchant_audit",
        title: "Pinned review",
        createdBy: "actor-a",
      });
      await repos.studio.outputs.addVersion({
        outputId: output.id,
        payload: { checks: [] },
        contentDigest: "a".repeat(64),
        asOf: new Date(),
        createdBy: "actor-a",
      });
      await repos.studio.outputs.setStatus(output.id, "signed_off");
      expect(
        await repos.studio.outputs.statusConfirmation(output.id),
      ).toBeNull();
      await repos.audit.write({
        workspaceId: WORKSPACE_A,
        actorId: "reviewer-a",
        entityId: output.id,
        action: "studio.output.signed_off",
        metadata: { revision: 1, contentDigest: "b".repeat(64) },
      });
      expect(
        await repos.studio.outputs.statusConfirmation(output.id),
      ).toBeNull();
      await repos.audit.write({
        workspaceId: WORKSPACE_A,
        actorId: "reviewer-a",
        entityId: output.id,
        action: "studio.output.signed_off",
        metadata: { revision: 1, contentDigest: "a".repeat(64) },
      });
      expect(await repos.studio.outputs.statusConfirmation(output.id)).toEqual({
        status: "signed_off",
        revision: 1,
        contentDigest: "a".repeat(64),
      });
      const next = await repos.studio.outputs.addVersion({
        outputId: output.id,
        payload: { checks: ["changed"] },
        contentDigest: "b".repeat(64),
        asOf: new Date(),
        createdBy: "actor-a",
      });
      expect(next.output).toMatchObject({ currentVersion: 2, status: "draft" });
      expect(
        await repos.studio.outputs.statusConfirmation(output.id),
      ).toBeNull();
      expect(
        (await repos.studio.outputs.getVersion(output.id, 1))?.contentDigest,
      ).toBe("a".repeat(64));
      return output.id;
    });
    await studioRepositories(WORKSPACE_B, async (repos) => {
      expect(
        await repos.studio.outputs.get(outputId, { forUpdate: true }),
      ).toBeNull();
      expect(await repos.studio.outputs.getVersion(outputId, 1)).toBeNull();
      expect(
        await repos.studio.outputs.statusConfirmation(outputId),
      ).toBeNull();
    });
  });

  it("serializes pinned review against version append and never inherits its approval", async () => {
    const outputId = await studioRepositories(WORKSPACE_A, async (repos) => {
      const output = await repos.studio.outputs.create({
        kind: "merchant_audit",
        title: "Concurrent pinned review",
        createdBy: "actor-a",
      });
      await repos.studio.outputs.addVersion({
        outputId: output.id,
        payload: { checks: [] },
        contentDigest: "a".repeat(64),
        asOf: new Date(),
        createdBy: "actor-a",
      });
      return output.id;
    });
    const contenderUrl = new URL(appUrl!);
    contenderUrl.searchParams.set(
      "application_name",
      "studio-output-version-waiter",
    );
    const contender = createDatabase(contenderUrl.toString());
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const review = studioRepositories(WORKSPACE_A, async (repos) => {
      const output = await repos.studio.outputs.get(outputId, {
        forUpdate: true,
      });
      expect(output?.currentVersion).toBe(1);
      expect(
        (await repos.studio.outputs.getVersion(outputId, 1))?.contentDigest,
      ).toBe("a".repeat(64));
      locked();
      await released;
      await repos.studio.outputs.setStatus(outputId, "signed_off");
      await repos.audit.write({
        workspaceId: WORKSPACE_A,
        actorId: "reviewer-a",
        entityId: outputId,
        action: "studio.output.signed_off",
        metadata: { revision: 1, contentDigest: "a".repeat(64) },
      });
    });
    await lockHeld;
    let appended = false;
    const append = contender.forWorkspace(WORKSPACE_A, async (repos) => {
      const result = await repos.studio.outputs.addVersion({
        outputId,
        payload: { checks: ["new version"] },
        contentDigest: "b".repeat(64),
        asOf: new Date(),
        createdBy: "actor-a",
      });
      appended = true;
      return result;
    });
    try {
      await vi.waitFor(
        async () => {
          const rows =
            await admin!`select count(*)::int as blocked from pg_stat_activity where datname='wukong_studio_test' and application_name='studio-output-version-waiter' and wait_event_type='Lock'`;
          expect(rows[0]?.blocked).toBe(1);
        },
        { timeout: 3000, interval: 20 },
      );
      expect(appended).toBe(false);
    } finally {
      release();
      await Promise.allSettled([review, append]);
      await contender.close();
    }
    await review;
    const next = await append;
    expect(next.output).toMatchObject({ currentVersion: 2, status: "draft" });
    await studioRepositories(WORKSPACE_A, async (repos) => {
      expect(
        await repos.studio.outputs.statusConfirmation(outputId),
      ).toBeNull();
      expect((await repos.studio.outputs.get(outputId))?.status).toBe("draft");
    });
  });

  it("preserves known model identity and settled usage on a failed run", async () => {
    const failed = await db!.forWorkspace(WORKSPACE_A, async (repos) => {
      const thread = await repos.studio.threads.create({
        createdBy: "actor-a",
        title: "Failed accounting",
      });
      const message = await repos.studio.messages.append({
        threadId: thread.id,
        role: "operator",
        content: { text: "accounting" },
        createdBy: "actor-a",
      });
      const { run } = await repos.studio.runs.create({
        threadId: thread.id,
        triggerMessageId: message.message.id,
        skillKey: "catalog.find",
        skillVersion: "1.0.0",
        idempotencyKey: "failed-usage-identity",
      });
      await repos.studio.runs.markRunning(run.id);
      await repos.studio.runs.fail(run.id, {
        errorCode: "reply_persistence_failed",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        inputTokens: 927,
        outputTokens: 1385,
        estimatedCostUsd: "0.001941",
        settledUsd: "0.001941",
      });
      return repos.studio.runs.get(run.id);
    });
    expect(failed).toMatchObject({
      status: "failed",
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      inputTokens: 927,
      outputTokens: 1385,
      estimatedCostUsd: "0.001941",
      settledUsd: "0.001941",
    });
  });

  it("reserves studio budget atomically and settles it once", async () => {
    const outcome = await db!.forWorkspace(WORKSPACE_B, async (repos) => {
      const thread = await repos.studio.threads.create({
        createdBy: "actor-b",
        title: "Budget thread",
      });
      const message = await repos.studio.messages.append({
        threadId: thread.id,
        role: "operator",
        content: { text: "paid run" },
        clientMessageId: "budget-msg-1",
        createdBy: "actor-b",
      });
      const makeRun = (key: string) =>
        repos.studio.runs.create({
          threadId: thread.id,
          triggerMessageId: message.message.id,
          skillKey: "listing.copy_proposal",
          skillVersion: "1.0.0",
          idempotencyKey: key,
        });
      const run1 = await makeRun("budget-1");
      const run2 = await makeRun("budget-2");
      const first = await repos.studio.budget.reserve({
        runId: run1.run.id,
        pricingVersion: "studio-v1",
        reservedUsd: "0.600000",
        workspaceCapUsd: "1.000000",
      });
      const second = await repos.studio.budget.reserve({
        runId: run2.run.id,
        pricingVersion: "studio-v1",
        reservedUsd: "0.600000",
        workspaceCapUsd: "1.000000",
      });
      const duplicate = await repos.studio.budget.reserve({
        runId: run1.run.id,
        pricingVersion: "studio-v1",
        reservedUsd: "0.600000",
        workspaceCapUsd: "1.000000",
      });
      await repos.studio.budget.settle(run1.run.id, "0.500000");
      const committed = await repos.studio.budget.committedUsd();
      const reservation = await repos.studio.budget.getForRun(run1.run.id);
      const unreserved = await repos.studio.budget.getForRun(run2.run.id);
      return {
        first,
        second,
        duplicate,
        committed,
        reservation,
        unreserved,
        runId: run1.run.id,
      };
    });
    expect(outcome.first.accepted).toBe(true);
    expect(outcome.second.accepted).toBe(false);
    expect(outcome.duplicate.accepted).toBe(true);
    expect(outcome.committed).toBe("0.500000");
    expect(outcome.reservation).toMatchObject({
      runId: outcome.runId,
      state: "settled",
      reservedUsd: "0.600000",
      settledUsd: "0.500000",
      pricingVersion: "studio-v1",
    });
    expect(outcome.unreserved).toBeNull();
    expect(
      await db!.forWorkspace(WORKSPACE_A, (repos) =>
        repos.studio.budget.getForRun(outcome.runId),
      ),
    ).toBeNull();
  });

  it("stores MCP connections, call receipts and hashed API tokens", async () => {
    const connection = await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.mcpConnections.create({
        label: "Research provider",
        endpointUrl: "https://mcp.example.test/mcp",
        toolAllowlist: ["search"],
        schemaHashes: { search: "c".repeat(64) },
        createdBy: "admin-b",
      }),
    );
    const approved = await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.mcpConnections.updateStatus(
        connection.id,
        "approved",
        "admin-b",
      ),
    );
    expect(approved?.status).toBe("approved");
    expect(approved?.approvedBy).toBe("admin-b");

    // Credential binding and hash pinning bump the generation and return an
    // approved connection to draft so approval is repeated.
    const rotated = await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.mcpConnections.updateCredential(
        connection.id,
        "v1.iv.ciphertext",
      ),
    );
    expect(rotated?.generation).toBe(2);
    expect(rotated?.status).toBe("draft");
    expect(rotated?.credentialEnvelope).toBe("v1.iv.ciphertext");
    const pinned = await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.mcpConnections.updateSchemaHashes(connection.id, {
        search: "e".repeat(64),
      }),
    );
    expect(pinned?.generation).toBe(3);
    expect(pinned?.schemaHashes).toEqual({ search: "e".repeat(64) });
    const cleared = await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.mcpConnections.updateCredential(connection.id, null),
    );
    expect(cleared?.credentialEnvelope).toBeNull();
    expect(cleared?.generation).toBe(4);

    const call = await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.mcpCalls.append({
        connectionId: connection.id,
        toolName: "search",
        requestDigest: "d".repeat(64),
        responseDigest: "e".repeat(64),
        status: "ok",
        latencyMs: 42,
        caller: "agent",
      }),
    );
    expect(call.responseDigest).toBe("e".repeat(64));
    const calls = await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.mcpCalls.list({ connectionId: connection.id }),
    );
    expect(calls).toHaveLength(1);

    const token = await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.apiTokens.create({
        label: "Claude Desktop",
        tokenHash: "f".repeat(64),
        prefix: "wuk_example",
        scopes: ["read", "propose"],
        createdBy: "admin-b",
        rateLimitPerMinute: 60,
        monthlyCallQuota: 1000,
      }),
    );
    const found = await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.apiTokens.findByHash("f".repeat(64)),
    );
    expect(found?.id).toBe(token.id);
    expect(found?.scopes).toEqual(["read", "propose"]);
    expect(found).toMatchObject({
      rateLimitPerMinute: 60,
      monthlyCallQuota: 1000,
    });
    expect(
      await db!.forWorkspace(WORKSPACE_B, (repos) =>
        repos.studio.apiTokens.get(token.id),
      ),
    ).toMatchObject({ id: token.id, monthlyCallQuota: 1000 });

    await db!.forWorkspace(WORKSPACE_B, async (repos) => {
      await repos.studio.apiTokens.touch(token.id);
      const updated = await repos.studio.apiTokens.updateLimits(token.id, {
        rateLimitPerMinute: null,
        monthlyCallQuota: 500,
      });
      expect(updated).toBe(true);
    });
    expect(
      await db!.forWorkspace(WORKSPACE_B, (repos) =>
        repos.studio.apiTokens.get(token.id),
      ),
    ).toMatchObject({ rateLimitPerMinute: null, monthlyCallQuota: 500 });
    expect(
      await db!.forWorkspace(WORKSPACE_B, (repos) =>
        repos.studio.apiTokens.updateLimits(
          "00000000-0000-4000-8000-000000000000",
          { rateLimitPerMinute: 1, monthlyCallQuota: 1 },
        ),
      ),
    ).toBe(false);

    await db!.forWorkspace(WORKSPACE_B, async (repos) => {
      await repos.studio.apiTokens.revoke(token.id);
    });
    const revoked = await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.apiTokens.findByHash("f".repeat(64)),
    );
    expect(revoked?.revokedAt).not.toBeNull();
    expect(revoked?.lastUsedAt).not.toBeNull();
    expect(
      await db!.forWorkspace(WORKSPACE_B, (repos) =>
        repos.studio.apiTokens.updateLimits(token.id, {
          rateLimitPerMinute: 5,
          monthlyCallQuota: 5,
        }),
      ),
    ).toBe(false);
  });

  it("counts MCP ledger rows only for the attributed token and supports updateLimits", async () => {
    const [first, second] = await db!.forWorkspace(
      WORKSPACE_B,
      async (repos) => {
        const makeToken = (label: string, hash: string) =>
          repos.studio.apiTokens.create({
            label,
            tokenHash: hash,
            prefix: `wuk_${label}`,
            scopes: ["read"],
            createdBy: "admin-b",
            rateLimitPerMinute: 10,
            monthlyCallQuota: 100,
          });
        const first = await makeToken("count-a", "1".repeat(64));
        const second = await makeToken("count-b", "2".repeat(64));
        return [first, second] as const;
      },
    );
    await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.mcpCalls.append({
        tokenId: first.id,
        toolName: "catalog.search",
        requestDigest: "3".repeat(64),
        responseDigest: null,
        status: "ok",
        latencyMs: 1,
        caller: "external_mcp",
      }),
    );
    const before = new Date(Date.now() - 60_000);
    const after = new Date(Date.now() + 60_000);
    expect(
      await db!.forWorkspace(WORKSPACE_B, (repos) =>
        repos.studio.mcpCalls.countForTokenSince(first.id, before),
      ),
    ).toBe(1);
    expect(
      await db!.forWorkspace(WORKSPACE_B, (repos) =>
        repos.studio.mcpCalls.countForTokenSince(second.id, before),
      ),
    ).toBe(0);
    expect(
      await db!.forWorkspace(WORKSPACE_B, (repos) =>
        repos.studio.mcpCalls.countForTokenSince(first.id, after),
      ),
    ).toBe(0);
  });

  it("counts only active API tokens for the calling workspace", async () => {
    const beforeA = await db!.forWorkspace(WORKSPACE_A, (repos) =>
      repos.studio.apiTokens.countActive(),
    );
    const beforeB = await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.apiTokens.countActive(),
    );
    const token = await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.apiTokens.create({
        label: "quota-count",
        tokenHash: "9".repeat(64),
        prefix: "wuk_quota",
        scopes: ["read"],
        createdBy: "admin-b",
      }),
    );
    expect(
      await db!.forWorkspace(WORKSPACE_A, (repos) =>
        repos.studio.apiTokens.countActive(),
      ),
    ).toBe(beforeA);
    expect(
      await db!.forWorkspace(WORKSPACE_B, (repos) =>
        repos.studio.apiTokens.countActive(),
      ),
    ).toBe(beforeB + 1);
    await db!.forWorkspace(WORKSPACE_B, (repos) =>
      repos.studio.apiTokens.revoke(token.id),
    );
    expect(
      await db!.forWorkspace(WORKSPACE_B, (repos) =>
        repos.studio.apiTokens.countActive(),
      ),
    ).toBe(beforeB);
  });
});
