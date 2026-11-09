import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FakeStudioModel,
  fakeStudioUsage,
  type StudioCopyProposalField,
  type StudioModel,
} from "@wukong/ai";
import type { StudioSettings } from "@wukong/db";

import { isStudioAiEnabled, isStudioEnabled } from "../studio-flags";
import type { SendMessageBody } from "./contracts.js";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  fakeStudioRun,
  fakeStudioThread,
  fakeMessage,
  reviewableContent,
  reviewSnapshot,
  type CatalogPage,
  type FakeStudio,
  type FakeStudioOptions,
} from "./test-fakes.js";
import { createStudioService, type StudioServiceDeps } from "./turn-service.js";

/**
 * Turn-service contract tests (plan Task 6 + Task 8 integration).
 *
 * Everything is in-memory: fake session, fake workspace repositories and a
 * scripted model. No database, no provider, no clock.
 */

const NOW = new Date("2026-11-08T10:00:00.000Z");
const WORKSPACE = "ws_test";
const LISTING_ID = "listing-1";
const MISSING_THREAD_ID = "00000000-0000-4000-8000-000000000000";

afterEach(() => {
  vi.restoreAllMocks();
});

const STUDIO_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

const AI_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  CONVERSATION_STUDIO_AI_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

const AI_SETTINGS: Partial<StudioSettings> = {
  monthlyBudgetUsd: "10.000000",
  runCeilingUsd: "0.638976",
  ai: {
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    pricingVersion: "go-2026-11",
    maxInputTokens: 1048576,
    inputUsdPerMillion: "0.3",
    outputUsdPerMillion: "1.2",
    maxOutputTokens: 4096,
  },
};

function catalogOptions(): NonNullable<FakeStudioOptions["catalog"]> {
  const createdAt = NOW.toISOString();
  const items = [
    {
      sourceType: "platform" as const,
      id: "product-1",
      remoteProductId: "remote-1",
      origin: "import" as const,
      sku: null,
      listingId: LISTING_ID,
      specVersion: null,
      title: "Margaux 2019",
      listingStatus: "in_review" as const,
      openBlockingFlagCount: 0,
      needsReview: false,
      needsAttention: false,
      createdAt,
      updatedAt: createdAt,
      contentDigest: null,
    },
  ];
  return {
    items: items as unknown as CatalogPage["items"],
    totalMatching: 1,
    summary: { unlinked: 0, website: 0, workbook: 0, total: 1, linked: 1 },
  };
}

function populatedOptions(): FakeStudioOptions {
  return {
    catalog: catalogOptions(),
    snapshots: {
      [LISTING_ID]: reviewSnapshot({
        listingId: LISTING_ID,
        content: reviewableContent(),
        flags: [],
      }),
    },
    pipelineRuns: [
      {
        id: "job-1",
        listingId: LISTING_ID,
        versionId: null,
        status: "succeeded",
        errorCode: null,
        createdAt: NOW,
      },
    ],
  };
}

type Role = "viewer" | "operator" | "reviewer" | "admin" | "owner";

type Harness = {
  service: ReturnType<typeof createStudioService>;
  fake: FakeStudio;
  deps: StudioServiceDeps;
};

function harness(
  input: {
    role?: Role;
    options?: FakeStudioOptions;
    settings?: Partial<StudioSettings>;
    env?: NodeJS.ProcessEnv;
    createModel?: (settings: StudioSettings) => StudioModel | null;
    monotonicNow?: () => number;
  } = {},
): Harness {
  const options = input.options ?? {};
  const fake = createFakeStudio({
    ...options,
    settings: {
      workspaceId: WORKSPACE,
      enabled: true,
      ...(input.settings ?? {}),
      ...(options.settings ?? {}),
    },
  });
  const session = fakeSessionContext(input.role ?? "operator", {
    workspaceId: WORKSPACE,
  });
  const deps: StudioServiceDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    isStudioEnabled,
    isStudioAiEnabled,
    env: input.env ?? STUDIO_ENV,
    now: () => NOW,
    ...(input.monotonicNow ? { monotonicNow: input.monotonicNow } : {}),
    ...(input.createModel ? { createModel: input.createModel } : {}),
  };
  return { service: createStudioService(deps), fake, deps };
}

function body(overrides: Partial<SendMessageBody> = {}): SendMessageBody {
  return {
    clientMessageId: "client-1",
    text: "margaux",
    locale: "en",
    ...overrides,
  };
}

async function openThread(service: Harness["service"]): Promise<string> {
  const created = await service.createThread({ title: "Test conversation" });
  return created.threadId;
}

function auditActions(fake: FakeStudio): string[] {
  return fake.state.audits.map((event) => event.action);
}

function answeredModel(
  compose: () => Promise<{
    analysis: {
      sections: Array<{ heading: string; body: string }>;
      claims: Array<{ text: string; evidenceRefs: string[] }>;
      limitations: string[];
      followUps: string[];
      clarification: null;
    };
    usage: ReturnType<typeof fakeStudioUsage>;
  }>,
): StudioModel {
  return {
    async plan() {
      throw new Error("planner is not used by the v1 deterministic turn");
    },
    compose,
    async propose() {
      throw new Error("proposer is not used by this fixture");
    },
  };
}

describe("studio turn service gate order", () => {
  it("refuses a viewer before touching any thread data", async () => {
    const { service, fake } = harness({ role: "viewer" });
    await expect(
      service.sendMessage(MISSING_THREAD_ID, body()),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
    expect(fake.state.writes).not.toContain("messages.append");
    expect(fake.state.writes).not.toContain("runs.create");
    expect(fake.state.audits).toEqual([]);
  });

  it("returns 404 when the deployment flag is off, before any repository write", async () => {
    const { service, fake } = harness({
      env: {} as NodeJS.ProcessEnv,
      options: populatedOptions(),
    });
    await expect(service.createThread({ title: "x" })).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(service.listThreads()).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(
      service.sendMessage(MISSING_THREAD_ID, body()),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(fake.state.writes).toEqual([
      "settings.get",
      "settings.get",
      "settings.get",
    ]);
    expect(fake.state.audits).toEqual([]);
  });

  it("returns 404 for a private thread of another operator", async () => {
    const privateThread = fakeStudioThread({
      workspaceId: WORKSPACE,
      createdBy: "actor_other",
      title: "Private notes",
      visibility: "private",
    });
    const { service, fake } = harness({
      options: { threads: [privateThread], ...populatedOptions() },
    });
    await expect(
      service.sendMessage(privateThread.id, body()),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(service.getThread(privateThread.id)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(fake.state.writes).not.toContain("messages.append");
  });

  it("lets an admin read another operator's private thread", async () => {
    const privateThread = fakeStudioThread({
      workspaceId: WORKSPACE,
      createdBy: "actor_other",
      title: "Private notes",
      visibility: "private",
    });
    const { service } = harness({
      role: "admin",
      options: { threads: [privateThread] },
    });
    const result = await service.getThread(privateThread.id);
    expect(result.thread.threadId).toBe(privateThread.id);
  });

  it("returns 404 for a thread that belongs to another workspace", async () => {
    const foreignThread = fakeStudioThread({
      workspaceId: "ws_other",
      createdBy: "actor_ops",
      title: "Foreign",
    });
    const { service, fake } = harness({
      options: { threads: [foreignThread] },
    });
    await expect(
      service.sendMessage(foreignThread.id, body()),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(service.getThread(foreignThread.id)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(fake.state.writes).not.toContain("messages.append");
  });
});

describe("studio thread and message reads", () => {
  it("creates an operator thread with a neutral default title and an audit event", async () => {
    const { service, fake } = harness();
    const created = await service.createThread({});
    const thread = fake.state.threads.find(
      (entry) => entry.id === created.threadId,
    );
    expect(thread?.title).toBe("Studio conversation");
    expect(thread?.createdBy).toBe("actor_ops");
    expect(auditActions(fake)).toEqual(["studio.thread.created"]);
  });

  it("rejects an unknown skill and a viewer on thread creation", async () => {
    const asOperator = harness();
    await expect(
      asOperator.service.createThread({ skillKey: "nope.unknown" }),
    ).rejects.toMatchObject({ status: 400, code: "unknown_skill" });
    expect(asOperator.fake.state.writes).not.toContain("threads.create");

    const asViewer = harness({ role: "viewer" });
    await expect(
      asViewer.service.createThread({ title: "x" }),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
    expect(asViewer.fake.state.writes).not.toContain("threads.create");
  });

  it("lists workspace threads but hides other operators' private ones", async () => {
    const shared = fakeStudioThread({
      workspaceId: WORKSPACE,
      createdBy: "actor_other",
      title: "Shared",
    });
    const privateOther = fakeStudioThread({
      workspaceId: WORKSPACE,
      createdBy: "actor_other",
      title: "Their private",
      visibility: "private",
    });
    const privateOwn = fakeStudioThread({
      workspaceId: WORKSPACE,
      createdBy: "actor_ops",
      title: "My private",
      visibility: "private",
    });
    const { service } = harness({
      role: "viewer",
      options: { threads: [shared, privateOther, privateOwn] },
    });
    const listed = await service.listThreads();
    expect(listed.items.map((item) => item.title).sort()).toEqual([
      "My private",
      "Shared",
    ]);
    expect(listed.truncated).toBe(false);
  });

  it("returns persisted messages with decoded JSON content", async () => {
    const thread = fakeStudioThread({
      workspaceId: WORKSPACE,
      createdBy: "actor_ops",
      title: "Thread",
    });
    const operatorMessage = fakeMessage({
      threadId: thread.id,
      role: "operator",
      content: { text: "find margaux", locale: "en" },
      sequence: 1,
      clientMessageId: "client-1",
    });
    const assistantMessage = fakeMessage({
      threadId: thread.id,
      role: "assistant",
      content: { status: "answered", marker: true },
      sequence: 2,
    });
    const { service } = harness({
      role: "viewer",
      options: {
        threads: [thread],
        messages: [operatorMessage, assistantMessage],
      },
    });
    const result = await service.getThread(thread.id);
    expect(result.thread.threadId).toBe(thread.id);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.content).toEqual({
      text: "find margaux",
      locale: "en",
    });
    expect(result.messages[1]?.content).toEqual({
      status: "answered",
      marker: true,
    });
  });

  it("returns run status and ordered persisted events for polling", async () => {
    const thread = fakeStudioThread({
      workspaceId: WORKSPACE,
      createdBy: "actor_ops",
      title: "Thread",
    });
    const run = fakeStudioRun({
      threadId: thread.id,
      triggerMessageId: "message-1",
      status: "succeeded",
    });
    const { service } = harness({
      role: "viewer",
      options: {
        threads: [thread],
        runs: [run],
        runEvents: [
          {
            id: "event-1",
            workspaceId: WORKSPACE,
            runId: run.id,
            sequence: 1,
            kind: "tool",
            toolId: "catalog.search",
            state: "done",
            payload: { key: "studio.trace.tool.done", values: {} },
            durationMs: 2,
            createdAt: NOW,
          },
        ],
      },
    });
    const result = await service.getRun(thread.id, run.id);
    expect(result.runId).toBe(run.id);
    expect(result.status).toBe("succeeded");
    expect(result.events.map((event) => event.sequence)).toEqual([1]);
    expect(result.events[0]?.payload.key).toBe("studio.trace.tool.done");

    await expect(
      service.getRun(thread.id, MISSING_THREAD_ID),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("studio deterministic turns", () => {
  it("persists a needs_input turn honestly and completes its run", async () => {
    const { service, fake } = harness({ options: populatedOptions() });
    const threadId = await openThread(service);
    const result = await service.sendMessage(threadId, body({ text: "   " }));

    expect(result.reply.status).toBe("needs_input");
    expect(result.reply.analysis).toBeNull();
    expect(result.trace.map((step) => step.kind)).toEqual(["notice"]);
    expect(
      fake.state.messages
        .filter((message) => message.threadId === threadId)
        .map((message) => message.role),
    ).toEqual(["operator", "assistant"]);
    const run = fake.state.runs[0]!;
    expect(run.status).toBe("succeeded");
    expect(
      fake.state.runEvents
        .filter((event) => event.runId === run.id)
        .map((event) => event.sequence),
    ).toEqual([1]);
    expect(auditActions(fake)).toContain("studio.message.received");
    expect(auditActions(fake)).toContain("studio.run.completed");
  });

  it("prepares a draft dispatch from source assets without a model or a write", async () => {
    const modelFactory = vi.fn(() => {
      throw new Error("the draft turn must not build a model");
    });
    const assetA = "11111111-1111-4111-8111-111111111111";
    const assetB = "22222222-2222-4222-8222-222222222222";
    const { service, fake } = harness({
      options: {
        ...populatedOptions(),
        sourceAssets: [
          { id: assetA, kind: "image/png", listingId: null },
          { id: assetB, kind: "image/jpeg", listingId: null },
        ],
      },
      createModel: modelFactory as never,
    });
    const threadId = await openThread(service);

    const result = await service.sendMessage(
      threadId,
      body({
        text: "Create the draft",
        skillKey: "listing.draft_from_sources",
        attachmentAssetIds: [assetA, assetB],
      }),
    );

    expect(result.reply.skillKey).toBe("listing.draft_from_sources");
    expect(result.reply.skillVersion).toBe("1.1.0");
    expect(result.reply.status).toBe("answered");
    expect(result.reply.dispatch).toMatchObject({
      kind: "listing_draft",
      assetIds: [assetA, assetB],
      ready: true,
    });
    expect(result.reply.outputs).toEqual([]);
    expect(modelFactory).not.toHaveBeenCalled();
    // A read-only turn: no canonical listing write and no dispatch audit.
    expect(fake.state.writes).not.toContain("listings.create");
    expect(auditActions(fake)).not.toContain("studio.dispatch.listing_draft");
    expect(fake.state.runs[0]?.status).toBe("succeeded");
  });

  it("asks for source assets instead of preparing a dispatch when none are given", async () => {
    const { service } = harness({ options: populatedOptions() });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({ text: "Create a draft", skillKey: "listing.draft_from_sources" }),
    );
    expect(result.reply.status).toBe("needs_input");
    expect(result.reply.dispatch).toBeNull();
    expect(result.reply.followUps[0]?.key).toBe(
      "studio.needs_input.draft_assets",
    );
  });

  it("persists a deterministic merchant audit artifact and returns its output ref", async () => {
    const modelFactory = vi.fn(() => {
      throw new Error("the audit turn must not build a model");
    });
    const { service, fake } = harness({
      options: {
        ...populatedOptions(),
        counts: { approved: 2, in_review: 1 },
        exportAttempts: [
          {
            id: "attempt-1",
            artifactStatus: "ready",
            rowCount: 2,
            createdAt: NOW,
          },
        ],
      },
      createModel: modelFactory as never,
    });
    const threadId = await openThread(service);

    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "client-audit",
        text: "Audit this workspace",
        skillKey: "merchant.audit",
      }),
    );

    expect(result.reply.skillKey).toBe("merchant.audit");
    expect(result.reply.skillVersion).toBe("1.1.0");
    expect(result.reply.status).toBe("answered");
    expect(result.reply.outputs).toHaveLength(1);
    expect(result.reply.dispatch).toBeNull();
    expect(modelFactory).not.toHaveBeenCalled();

    const output = fake.state.outputs[0];
    expect(output).toMatchObject({
      kind: "merchant_audit",
      status: "draft",
      currentVersion: 1,
      threadId,
    });
    expect(fake.state.outputVersions[0]?.contentDigest).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(fake.state.outputVersions[0]?.payload).toMatchObject({
      schemaVersion: "wukong-merchant-audit/v2",
      period: null,
      attemptsInPeriod: null,
      listings: expect.arrayContaining([
        { status: "approved", count: 2 },
        { status: "in_review", count: 1 },
      ]),
    });
    expect(fake.state.audits.map((event) => event.action)).toContain(
      "studio.output.proposed",
    );
    expect(fake.state.runs[0]?.status).toBe("succeeded");
  });

  it("persists the parsed period and only in-period export attempts", async () => {
    const modelFactory = vi.fn(() => {
      throw new Error("the audit turn must not build a model");
    });
    const { service, fake } = harness({
      options: {
        ...populatedOptions(),
        counts: { approved: 2 },
        exportAttempts: [
          {
            id: "attempt-inside",
            artifactStatus: "ready",
            rowCount: 2,
            createdAt: new Date("2026-11-05T09:00:00.000Z"),
          },
          {
            id: "attempt-outside",
            artifactStatus: "ready",
            rowCount: 1,
            createdAt: new Date("2026-09-01T09:00:00.000Z"),
          },
        ],
      },
      createModel: modelFactory as never,
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "client-audit-period",
        text: "Audit last 30 days",
        skillKey: "merchant.audit",
      }),
    );

    expect(result.reply.status).toBe("answered");
    expect(modelFactory).not.toHaveBeenCalled();
    expect(fake.state.outputVersions[0]?.payload).toMatchObject({
      schemaVersion: "wukong-merchant-audit/v2",
      period: { from: "2026-10-10", to: "2026-11-08", label: "last 30 days" },
      attemptsInPeriod: 1,
      exports: [expect.objectContaining({ attemptId: "attempt-inside" })],
    });
    const limitationKeys = (
      fake.state.outputVersions[0]?.payload.limitations as Array<{
        key: string;
      }>
    ).map((line) => line.key);
    expect(limitationKeys).toContain("studio.limit.audit_period_applied");
    expect(limitationKeys).toContain("studio.limit.audit_counts_current");
    const sections = result.reply.records.sections.map((line) => line.key);
    expect(sections).toContain("studio.answer.audit_period");
    expect(sections).not.toContain("studio.answer.audit_current");
  });

  it("answers from records, persists the turn and records ordered tool events", async () => {
    const { service, fake } = harness({ options: populatedOptions() });
    const threadId = await openThread(service);
    const result = await service.sendMessage(threadId, body());

    expect(result.reply.status).toBe("answered");
    expect(result.reply.skillKey).toBe("catalog.find");
    expect(result.reply.analysis).toBeNull();
    const events = fake.state.runEvents.filter(
      (event) => event.runId === result.runId,
    );
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.toolId)).toEqual([
      "catalog.search",
      "catalog.get",
      "quality.get_gaps",
      "jobs.list",
    ]);
    expect(events.every((event) => event.kind === "tool")).toBe(true);

    const persisted = fake.state.messages.find(
      (message) => message.id === result.messageId,
    );
    expect(persisted?.role).toBe("assistant");
    expect(persisted?.runId).toBe(result.runId);
    expect(persisted?.content).toEqual(result.reply);
    expect(fake.state.runs[0]?.status).toBe("succeeded");
    expect(auditActions(fake)).toEqual([
      "studio.thread.created",
      "studio.message.received",
      "studio.run.completed",
    ]);
    expect(fake.state.budgets).toEqual([]);
  });

  it("replays a duplicate clientMessageId without a second run", async () => {
    const { service, fake } = harness({ options: populatedOptions() });
    const threadId = await openThread(service);
    const first = await service.sendMessage(threadId, body());
    const second = await service.sendMessage(threadId, body());

    expect(second.replayed).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(second.runId).toBe(first.runId);
    expect(second.reply).toEqual(first.reply);
    expect(fake.state.runs).toHaveLength(1);
    expect(
      fake.state.messages.filter((message) => message.threadId === threadId),
    ).toHaveLength(2);
  });

  it("returns 409 while a duplicate clientMessageId is still running", async () => {
    const thread = fakeStudioThread({
      workspaceId: WORKSPACE,
      createdBy: "actor_ops",
      title: "Thread",
    });
    const message = fakeMessage({
      threadId: thread.id,
      role: "operator",
      sequence: 1,
      clientMessageId: "client-1",
    });
    const run = fakeStudioRun({
      threadId: thread.id,
      triggerMessageId: message.id,
      status: "running",
      idempotencyKey: `studio:${thread.id}:client-1`,
    });
    const { service } = harness({
      options: { threads: [thread], messages: [message], runs: [run] },
    });
    await expect(service.sendMessage(thread.id, body())).rejects.toMatchObject({
      status: 409,
      code: "run_in_progress",
    });
  });

  it("marks the run failed and rethrows when persistence fails mid-turn", async () => {
    const { service, fake } = harness({
      options: { ...populatedOptions(), failOnAssistantAppend: true },
    });
    const threadId = await openThread(service);
    await expect(service.sendMessage(threadId, body())).rejects.toThrow(
      "assistant append failed",
    );
    const run = fake.state.runs[0]!;
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("studio_turn_failed");
    expect(auditActions(fake)).toContain("studio.run.failed");
    expect(auditActions(fake)).not.toContain("studio.run.completed");
  });
});

describe("studio optional model analysis", () => {
  it("reserves, grounds claims, settles the budget and records the model step", async () => {
    const model = answeredModel(async () => ({
      analysis: {
        sections: [{ heading: "Summary", body: "One listing found." }],
        claims: [
          {
            text: "Margaux 2019 is in review.",
            evidenceRefs: [`catalog:${LISTING_ID}`],
          },
          {
            text: "An unsupported claim.",
            evidenceRefs: ["catalog:not-in-pack"],
          },
        ],
        limitations: ["Records only."],
        followUps: ["Open the listing."],
        clarification: null,
      },
      usage: fakeStudioUsage(),
    }));
    const { service, fake } = harness({
      options: populatedOptions(),
      settings: AI_SETTINGS,
      env: AI_ENV,
      createModel: () => model,
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(threadId, body());

    expect(result.reply.status).toBe("answered");
    expect(result.reply.analysis).not.toBeNull();
    expect(result.reply.analysis?.configured).toBe(true);
    expect(result.reply.analysis?.droppedClaims).toBe(1);
    expect(result.reply.analysis?.claims).toEqual([
      {
        text: "Margaux 2019 is in review.",
        evidenceRefs: [`catalog:${LISTING_ID}`],
      },
    ]);

    const budget = fake.state.budgets[0]!;
    expect(budget.reservedUsd).toBe("0.638976");
    expect(budget.state).toBe("settled");
    expect(budget.settledUsd).toBe("0.010000");

    const run = fake.state.runs[0]!;
    expect(run.status).toBe("succeeded");
    expect(run.inputTokens).toBe(100);
    expect(run.outputTokens).toBe(50);
    expect(run.estimatedCostUsd).toBe("0.010000");
    expect(run.settledUsd).toBe("0.010000");

    const modelEvent = fake.state.runEvents.find(
      (event) => event.runId === run.id && event.kind === "model",
    );
    expect(modelEvent?.state).toBe("done");
    expect(modelEvent?.payload.key).toBe("studio.trace.model.done");

    const completed = fake.state.audits.find(
      (event) => event.action === "studio.run.completed",
    );
    expect(completed?.metadata).toMatchObject({
      modelUsed: true,
      droppedClaims: 1,
    });
  });

  it("falls back to the deterministic reply when the model fails", async () => {
    const model: StudioModel = {
      async plan() {
        throw new Error("planner is not used");
      },
      async compose() {
        const error = new Error("provider request failed");
        error.name = "ProviderApiError";
        throw error;
      },
      async propose() {
        throw new Error("proposer is not used");
      },
    };
    const { service, fake } = harness({
      options: populatedOptions(),
      settings: AI_SETTINGS,
      env: AI_ENV,
      createModel: () => model,
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(threadId, body());

    expect(result.reply.status).toBe("answered");
    expect(result.reply.analysis).toMatchObject({
      configured: false,
      claims: [],
      sections: [],
    });
    const run = fake.state.runs[0]!;
    expect(run.status).toBe("succeeded");
    expect(run.inputTokens).toBeNull();
    expect(fake.state.budgets[0]?.state).toBe("uncertain");
    const modelEvent = fake.state.runEvents.find(
      (event) => event.kind === "model",
    );
    expect(modelEvent?.state).toBe("failed");
    expect(modelEvent?.payload).toMatchObject({
      key: "studio.trace.model.failed",
      values: { category: "provider_unavailable" },
    });
  });

  it("does not reserve or call a model when the AI flag is off", async () => {
    let modelCalls = 0;
    const { service, fake } = harness({
      options: populatedOptions(),
      settings: AI_SETTINGS,
      env: STUDIO_ENV,
      createModel: () => {
        modelCalls += 1;
        return null;
      },
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(threadId, body());
    expect(result.reply.analysis).toBeNull();
    expect(modelCalls).toBe(0);
    expect(fake.state.budgets).toEqual([]);
    expect(fake.state.writes).not.toContain("budget.reserve");
  });
});

describe("studio overview", () => {
  it("returns deterministic counts and links without reserving budget", async () => {
    let modelCalls = 0;
    const { service, fake } = harness({
      role: "viewer",
      options: {
        counts: { in_review: 2, approved: 1, published: 4 },
        pipelineRuns: [
          {
            id: "job-1",
            listingId: LISTING_ID,
            versionId: null,
            status: "failed",
            errorCode: "provider_error",
            createdAt: NOW,
          },
        ],
      },
      settings: AI_SETTINGS,
      env: AI_ENV,
      createModel: () => {
        modelCalls += 1;
        return null;
      },
    });
    const overview = await service.overview();
    expect(overview.listingCounts.total).toBe(7);
    expect(overview.listingCounts.byStatus.in_review).toBe(2);
    expect(overview.listingCounts.deepLink).toBe("/dashboard");
    expect(overview.quality.totalListings).toBe(3);
    expect(overview.quality.deepLink).toBe("/quality");
    expect(overview.recentJobs.items).toEqual([
      {
        jobId: "job-1",
        state: "failed",
        createdAt: NOW.toISOString(),
        deepLink: "/jobs",
      },
    ]);
    expect(overview.recentJobs.deepLink).toBe("/jobs");
    expect(modelCalls).toBe(0);
    expect(fake.state.writes).not.toContain("budget.reserve");
  });
});

describe("studio copy-proposal turns", () => {
  const COPY_LISTING_ID = "11111111-1111-4111-8111-111111111111";

  function copyOptions(): FakeStudioOptions {
    return {
      catalog: catalogOptions(),
      snapshots: {
        [COPY_LISTING_ID]: reviewSnapshot({
          listingId: COPY_LISTING_ID,
          content: reviewableContent(),
          flags: [],
        }),
      },
      pipelineRuns: [],
    };
  }

  function proposeModel(
    fieldsFor: (input: {
      listingId: string;
      activeVersionId: string;
      activeVersionSequence: number;
      refs: string[];
    }) => Array<{
      field: StudioCopyProposalField;
      current: string | null;
      proposed: string;
      evidenceRefs: string[];
    }>,
  ): StudioModel {
    return {
      async plan() {
        throw new Error("planner is not used");
      },
      async compose() {
        throw new Error("composer is not used");
      },
      async propose(input) {
        return {
          proposal: {
            listingId: input.listing.listingId,
            activeVersionId: input.listing.activeVersionId,
            activeVersionSequence: input.listing.activeVersionSequence,
            fields: fieldsFor({
              listingId: input.listing.listingId,
              activeVersionId: input.listing.activeVersionId,
              activeVersionSequence: input.listing.activeVersionSequence,
              refs: [...input.evidenceRefs],
            }),
            limitations: [] as string[],
          },
          usage: fakeStudioUsage({ estimatedCostUsd: 0.02 }),
        };
      },
    };
  }

  it("creates a versioned, grounded proposal artifact and settles the budget", async () => {
    const { service, fake } = harness({
      options: copyOptions(),
      settings: AI_SETTINGS,
      env: AI_ENV,
      createModel: () =>
        proposeModel((input) => [
          {
            field: "description.en",
            current: "Old description.",
            proposed: "Bright red fruit with a long finish.",
            evidenceRefs: [input.refs[0]!],
          },
        ]),
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "copy-1",
        text: `Propose better copy for listing ${COPY_LISTING_ID}`,
        skillKey: "listing.copy_proposal",
      }),
    );
    expect(result.reply.status).toBe("answered");
    expect(result.reply.outputs).toHaveLength(1);
    expect(result.reply.outputs[0]?.revision).toBe(1);
    expect(fake.state.outputs).toHaveLength(1);
    expect(fake.state.outputs[0]).toMatchObject({
      kind: "copy_proposal",
      status: "draft",
      currentVersion: 1,
      runId: result.runId,
    });
    expect(fake.state.outputVersions).toHaveLength(1);
    expect(fake.state.outputVersions[0]?.payload).toMatchObject({
      listingId: COPY_LISTING_ID,
      fields: [
        expect.objectContaining({
          field: "description.en",
          proposed: "Bright red fruit with a long finish.",
        }),
      ],
    });
    expect(fake.state.runs[0]?.status).toBe("succeeded");
    expect(fake.state.runs[0]?.settledUsd).not.toBeNull();
    expect(fake.state.budgets[0]?.state).toBe("settled");
    expect(auditActions(fake)).toEqual(
      expect.arrayContaining([
        "studio.message.received",
        "studio.output.proposed",
        "studio.run.completed",
      ]),
    );
    expect(
      result.trace.some(
        (step) =>
          step.detail.key === "studio.trace.model.done" &&
          step.state === "done",
      ),
    ).toBe(true);
  });

  it("drops ungrounded fields and records the dropped count", async () => {
    const { service, fake } = harness({
      options: copyOptions(),
      settings: AI_SETTINGS,
      env: AI_ENV,
      createModel: () =>
        proposeModel((input) => [
          {
            field: "title.en",
            current: "Margaux 2019",
            proposed: "Margaux 2019 Grand Vin",
            evidenceRefs: [input.refs[0]!],
          },
          {
            field: "description.en",
            current: "Old description.",
            proposed: "Unsupported new claim.",
            evidenceRefs: ["invented-source-ref"],
          },
        ]),
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "copy-2",
        text: `Improve ${COPY_LISTING_ID}`,
        skillKey: "listing.copy_proposal",
      }),
    );
    expect(fake.state.outputVersions[0]?.payload).toMatchObject({
      fields: [expect.objectContaining({ field: "title.en" })],
    });
    const summary = result.reply.records.sections.find(
      (section) => section.key === "studio.answer.copy_proposal",
    );
    expect(summary?.values.dropped).toBe(1);
    expect(result.reply.limitations.map((line) => line.key)).toContain(
      "studio.limit.copy_fields_dropped",
    );
  });

  it("degrades honestly when no live model is available", async () => {
    const { service, fake } = harness({
      options: copyOptions(),
      settings: AI_SETTINGS,
      env: STUDIO_ENV,
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "copy-3",
        text: `Improve ${COPY_LISTING_ID}`,
        skillKey: "listing.copy_proposal",
      }),
    );
    expect(result.reply.status).toBe("partial");
    expect(result.reply.outputs).toEqual([]);
    expect(fake.state.outputs).toHaveLength(0);
    expect(result.reply.limitations.map((line) => line.key)).toContain(
      "studio.limit.copy_model_required",
    );
    expect(fake.state.runs[0]?.status).toBe("succeeded");
  });

  it("asks for a listing id instead of running without one", async () => {
    const { service } = harness({
      options: copyOptions(),
      settings: AI_SETTINGS,
      env: AI_ENV,
      createModel: () => proposeModel(() => []),
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "copy-4",
        text: "propose better copy",
        skillKey: "listing.copy_proposal",
      }),
    );
    expect(result.reply.status).toBe("needs_input");
    expect(result.reply.followUps[0]?.key).toBe(
      "studio.needs_input.copy_listing",
    );
  });
});

describe("studio turn budgets", () => {
  it("fails the run with a timeout code when the turn deadline is exceeded", async () => {
    let ticks = 0;
    const { service, fake } = harness({
      options: populatedOptions(),
      monotonicNow: () => {
        ticks += 1;
        return ticks * 60_000;
      },
    });
    const threadId = await openThread(service);
    await expect(
      service.sendMessage(
        threadId,
        body({ clientMessageId: "deadline-1", text: "margaux" }),
      ),
    ).rejects.toMatchObject({ status: 503, code: "studio_turn_timeout" });
    expect(fake.state.runs[0]?.status).toBe("failed");
    expect(fake.state.runs[0]?.errorCode).toBe("studio_turn_timeout");
    expect(fake.state.audits.map((event) => event.action)).toContain(
      "studio.run.failed",
    );
  });
});

describe("studio turn metrics and budget alerts", () => {
  function parseEvents(
    calls: ReadonlyArray<readonly unknown[]>,
  ): Array<Record<string, unknown>> {
    return calls
      .map((call) => {
        try {
          return JSON.parse(String(call[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((event): event is Record<string, unknown> => event !== null);
  }

  it("emits one content-free metrics line for a successful deterministic turn", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { service } = harness({ options: populatedOptions() });
    const threadId = await openThread(service);
    await service.sendMessage(
      threadId,
      body({ clientMessageId: "metrics-1", text: "margaux" }),
    );
    const metrics = parseEvents(info.mock.calls).filter(
      (event) => event.event === "studio.turn.metrics",
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      status: "answered",
      settledUsd: null,
    });
    expect(Number(metrics[0]?.durationMs)).toBeGreaterThanOrEqual(0);
    expect(Number(metrics[0]?.traceSteps)).toBeGreaterThan(0);
    expect(JSON.stringify(metrics[0])).not.toContain("margaux");
  });

  it("emits failed metrics with the deadline error code", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let ticks = 0;
    const { service } = harness({
      options: populatedOptions(),
      monotonicNow: () => {
        ticks += 1;
        return ticks * 60_000;
      },
    });
    const threadId = await openThread(service);
    await expect(
      service.sendMessage(
        threadId,
        body({ clientMessageId: "metrics-2", text: "margaux" }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    const metrics = parseEvents(info.mock.calls).filter(
      (event) => event.event === "studio.turn.metrics",
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      status: "failed",
      errorCode: "studio_turn_timeout",
      settledUsd: null,
    });
  });

  it("alerts when committed spend crosses the workspace budget warning threshold", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { service } = harness({
      options: {
        ...populatedOptions(),
        budgets: [
          {
            runId: "00000000-0000-4000-8000-000000000001",
            pricingVersion: "go-2026-11",
            reservedUsd: "0.000000",
            settledUsd: "8.200000",
            state: "settled",
          },
        ],
      },
      settings: AI_SETTINGS,
      env: STUDIO_ENV,
    });
    const threadId = await openThread(service);
    await service.sendMessage(
      threadId,
      body({ clientMessageId: "metrics-3", text: "margaux" }),
    );
    const alerts = parseEvents(info.mock.calls).filter(
      (event) => event.event === "studio.budget.alert",
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      level: "warning",
      scope: "workspace",
      utilizationPercent: 82,
    });
    expect(JSON.stringify(alerts[0])).not.toContain("ws_test");
  });
});

describe("category.map_proposal turns (C1)", () => {
  const CATEGORY_LISTING_ID = "11111111-1111-4111-8111-111111111111";

  function categoryOptions(): FakeStudioOptions {
    return {
      catalog: catalogOptions(),
      snapshots: {
        [CATEGORY_LISTING_ID]: reviewSnapshot({
          listingId: CATEGORY_LISTING_ID,
          content: reviewableContent(),
          flags: [],
        }),
      },
    };
  }

  it("asks for a listing id without touching a model", async () => {
    const modelFactory = vi.fn(() => {
      throw new Error("needs_input must not build a model");
    });
    const { service, fake } = harness({
      options: categoryOptions(),
      createModel: modelFactory as never,
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "client-category-input",
        text: "map this listing to a category",
        skillKey: "category.map_proposal",
      }),
    );
    expect(result.reply.status).toBe("needs_input");
    expect(result.reply.followUps[0]?.key).toBe(
      "studio.needs_input.category_listing",
    );
    expect(modelFactory).not.toHaveBeenCalled();
    expect(fake.state.outputs).toEqual([]);
  });

  it("persists a deterministic finding artifact even without a model", async () => {
    const modelFactory = vi.fn(() => {
      throw new Error("no AI settings means no model");
    });
    const { service, fake } = harness({
      options: categoryOptions(),
      createModel: modelFactory as never,
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "client-category-deterministic",
        text: `map listing ${CATEGORY_LISTING_ID} to a category`,
        skillKey: "category.map_proposal",
      }),
    );
    expect(result.reply.skillKey).toBe("category.map_proposal");
    expect(result.reply.skillVersion).toBe("1.1.0");
    expect(result.reply.status).toBe("partial");
    expect(result.reply.outputs).toHaveLength(1);
    expect(modelFactory).not.toHaveBeenCalled();
    expect(fake.state.outputs[0]).toMatchObject({
      kind: "finding",
      status: "draft",
      currentVersion: 1,
      threadId,
      runId: result.runId,
    });
    const payload = fake.state.outputVersions[0]?.payload as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      schemaVersion: "wukong-category-map/v1",
      listingId: CATEGORY_LISTING_ID,
      currentCategory: null,
      suggestions: [],
    });
    const limitationKeys = (payload.limitations as Array<{ key: string }>).map(
      (line) => line.key,
    );
    expect(limitationKeys).toContain("studio.limit.category_not_applied");
    expect(limitationKeys).toContain("studio.limit.category_current_unknown");
    expect(limitationKeys).toContain("studio.limit.category_model_unavailable");
    expect(fake.state.audits.map((event) => event.action)).toContain(
      "studio.output.proposed",
    );
    expect(fake.state.runs[0]?.status).toBe("succeeded");
  });

  it("adds grounded model suggestions when a reviewed model is configured", async () => {
    const model = new FakeStudioModel({
      categoryProposals: [
        {
          listingId: CATEGORY_LISTING_ID,
          suggestions: [
            {
              path: "Beverages > Wine > Red",
              confidence: 0.75,
              rationale: "Similar catalog rows are red wines.",
              evidenceRefs: ["catalog:listing-1"],
            },
          ],
          limitations: [],
        },
      ],
    });
    const { service, fake } = harness({
      options: categoryOptions(),
      settings: AI_SETTINGS,
      env: AI_ENV,
      createModel: () => model,
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "client-category-model",
        text: `map listing ${CATEGORY_LISTING_ID} to a category`,
        skillKey: "category.map_proposal",
      }),
    );
    expect(result.reply.status).toBe("answered");
    expect(result.reply.outputs).toHaveLength(1);
    const payload = fake.state.outputVersions[0]?.payload as Record<
      string,
      unknown
    >;
    expect(payload.suggestions).toEqual([
      {
        path: "Beverages > Wine > Red",
        confidence: 0.75,
        rationale: "Similar catalog rows are red wines.",
        evidenceRefs: ["catalog:listing-1"],
      },
    ]);
    expect(fake.state.outputs[0]).toMatchObject({ kind: "finding" });
    expect(fake.state.runs[0]?.status).toBe("succeeded");
  });

  it("drops ungrounded model suggestions and counts them in the artifact", async () => {
    const ungroundedModel: StudioModel = {
      async plan() {
        throw new Error("planner is not used");
      },
      async compose() {
        throw new Error("composer is not used");
      },
      async propose() {
        throw new Error("copy proposer is not used");
      },
      async proposeCategory() {
        return {
          proposal: {
            listingId: CATEGORY_LISTING_ID,
            suggestions: [
              {
                path: "Beverages > Wine > Red",
                confidence: 0.8,
                rationale: null,
                evidenceRefs: ["catalog:listing-1"],
              },
              {
                path: "Invented > Path",
                confidence: 0.9,
                rationale: null,
                evidenceRefs: ["catalog:missing"],
              },
            ],
            limitations: [],
          },
          usage: fakeStudioUsage(),
        };
      },
    };
    const { service, fake } = harness({
      options: categoryOptions(),
      settings: AI_SETTINGS,
      env: AI_ENV,
      createModel: () => ungroundedModel,
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "client-category-drop",
        text: `map listing ${CATEGORY_LISTING_ID} to a category`,
        skillKey: "category.map_proposal",
      }),
    );
    expect(result.reply.status).toBe("answered");
    const payload = fake.state.outputVersions[0]?.payload as Record<
      string,
      unknown
    >;
    expect(payload.suggestions).toEqual([
      expect.objectContaining({ path: "Beverages > Wine > Red" }),
    ]);
    const limitationKeys = (payload.limitations as Array<{ key: string }>).map(
      (line) => line.key,
    );
    expect(limitationKeys).toContain(
      "studio.limit.category_suggestions_dropped",
    );
    expect(result.reply.limitations.map((line) => line.key)).toContain(
      "studio.limit.category_suggestions_dropped",
    );
  });
});
