import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      return { first, second, duplicate, committed };
    });
    expect(outcome.first.accepted).toBe(true);
    expect(outcome.second.accepted).toBe(false);
    expect(outcome.duplicate.accepted).toBe(true);
    expect(outcome.committed).toBe("0.500000");
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
});
