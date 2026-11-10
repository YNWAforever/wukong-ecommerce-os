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

  it("lets admins list every private thread via the query-level includePrivate", async () => {
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
      role: "admin",
      options: { threads: [shared, privateOther, privateOwn] },
    });
    const listed = await service.listThreads();
    expect(listed.items.map((item) => item.title).sort()).toEqual([
      "My private",
      "Shared",
      "Their private",
    ]);
    expect(listed.truncated).toBe(false);
  });

  it("returns a full page of visible threads without post-read shortening", async () => {
    const threads = [
      ...["a", "b", "c", "d"].map((suffix) =>
        fakeStudioThread({
          workspaceId: WORKSPACE,
          createdBy: "actor_other",
          title: `Workspace ${suffix}`,
        }),
      ),
      ...[1, 2, 3].map((index) =>
        fakeStudioThread({
          workspaceId: WORKSPACE,
          createdBy: "actor_other",
          title: `Hidden private ${index}`,
          visibility: "private",
        }),
      ),
      fakeStudioThread({
        workspaceId: WORKSPACE,
        createdBy: "actor_ops",
        title: "Own private",
        visibility: "private",
      }),
    ];
    const { service } = harness({
      role: "viewer",
      options: { threads },
    });
    const page = await service.listThreads();
    expect(page.items.map((item) => item.title).sort()).toEqual([
      "Own private",
      "Workspace a",
      "Workspace b",
      "Workspace c",
      "Workspace d",
    ]);
    expect(page.truncated).toBe(false);
  });

  it("validates list search/filter parameters before reading", async () => {
    const { service } = harness({ role: "viewer" });
    await expect(
      service.listThreads({ q: "x".repeat(121) }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
    await expect(
      service.listOutputs({ q: "x".repeat(121) }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
    await expect(
      service.listOutputs({ kind: "nope" as never }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
    await expect(
      service.listOutputs({ status: "nope" as never }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
    await expect(
      service.listThreads({ offset: 100_001 }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
    await expect(service.listThreads({ offset: -1 })).rejects.toMatchObject({
      status: 400,
      code: "invalid_query",
    });
    await expect(
      service.listOutputs({ offset: 100_001 }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
    await expect(service.listOutputs({ offset: 1.5 })).rejects.toMatchObject({
      status: 400,
      code: "invalid_query",
    });
  });

  it("passes offset through both list services and returns it", async () => {
    const threads = [1, 2, 3].map((index) =>
      fakeStudioThread({
        workspaceId: WORKSPACE,
        createdBy: "actor_ops",
        title: `Thread ${index}`,
      }),
    );
    const outputs = [1, 2, 3].map((index) => ({
      id: `output-${index}`,
      workspaceId: WORKSPACE,
      threadId: null,
      runId: null,
      kind: "copy_proposal" as const,
      title: `Output ${index}`,
      status: "draft" as const,
      currentVersion: 0,
      createdBy: "actor_ops",
      createdAt: new Date(NOW.getTime() + index * 1_000),
      updatedAt: new Date(NOW.getTime() + index * 1_000),
    }));
    const { service } = harness({
      role: "viewer",
      options: { threads, outputs },
    });

    const threadPage = await service.listThreads({ offset: 1 });
    expect(threadPage.offset).toBe(1);
    expect(threadPage.items.map((item) => item.title)).toEqual([
      "Thread 2",
      "Thread 3",
    ]);
    expect(threadPage.truncated).toBe(false);

    const outputPage = await service.listOutputs({ offset: 2 });
    expect(outputPage.offset).toBe(2);
    // The fake sorts newest-first; offset 2 is the oldest row.
    expect(outputPage.items.map((item) => item.title)).toEqual(["Output 1"]);
    expect(outputPage.truncated).toBe(false);

    await expect(service.listThreads()).resolves.toMatchObject({ offset: 0 });
    await expect(service.listOutputs()).resolves.toMatchObject({ offset: 0 });
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

describe("studio inbox", () => {
  function outputRow(
    id: string,
    status: "draft" | "saved" | "signed_off" | "discarded",
  ) {
    return {
      id,
      workspaceId: WORKSPACE,
      threadId: null,
      runId: null,
      kind: "copy_proposal",
      title: `Artifact ${id}`,
      status,
      currentVersion: status === "draft" ? 0 : 1,
      createdBy: "actor_ops",
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  it("aggregates one read into attention, jobs, outputs and recent conversations", async () => {
    const { service, fake } = harness({
      role: "viewer",
      options: {
        counts: { in_review: 2, needs_info: 1, approved: 4 },
        quality: {
          hasGapsCount: 3,
          noActiveVersion: 1,
          unassessableActiveVersion: 2,
        },
        pipelineRuns: [
          {
            id: "job-ok",
            listingId: LISTING_ID,
            versionId: null,
            status: "succeeded",
            errorCode: null,
            createdAt: NOW,
          },
          {
            id: "job-failed",
            listingId: LISTING_ID,
            versionId: null,
            status: "failed",
            errorCode: "provider_error",
            createdAt: NOW,
          },
        ],
        outputs: [
          outputRow("out-draft", "draft"),
          outputRow("out-saved", "saved"),
          outputRow("out-signed", "signed_off"),
        ],
        threads: [
          fakeStudioThread({
            workspaceId: WORKSPACE,
            createdBy: "actor_ops",
            title: "Recent conversation",
          }),
        ],
      } as FakeStudioOptions,
    });

    const inbox = await service.inbox();

    expect(inbox.asOf).toBe(NOW.toISOString());
    expect(inbox.needsAttention.items).toEqual([
      { key: "listings_with_gaps", count: 3, deepLink: "/quality" },
      {
        key: "listings_without_active_version",
        count: 1,
        deepLink: "/quality",
      },
      {
        key: "unassessable_active_version",
        count: 2,
        deepLink: "/quality",
      },
      { key: "listings_awaiting_review", count: 3, deepLink: "/dashboard" },
    ]);
    expect(inbox.jobs.items).toEqual([
      {
        jobId: "job-failed",
        state: "failed",
        errorCode: "provider_error",
        createdAt: NOW.toISOString(),
        deepLink: "/jobs",
      },
    ]);
    expect(inbox.outputs.items.map((item) => item.outputId)).toEqual([
      "out-draft",
      "out-saved",
    ]);
    expect(inbox.conversations.items).toHaveLength(1);
    expect(inbox.conversations.items[0]).toMatchObject({
      title: "Recent conversation",
      deepLink: expect.stringMatching(/^\/studio\/t\//),
    });
    // Read-only: no write, no budget reservation and no output audit event.
    expect(fake.state.writes).not.toContain("budget.reserve");
    expect(
      fake.state.writes.filter((action) =>
        /(create|update|append|setStatus|complete|fail|archive|touch)/.test(
          action,
        ),
      ),
    ).toEqual([]);
    expect(fake.state.budgets).toEqual([]);
    expect(fake.state.audits.map((event) => event.action)).not.toContain(
      "studio.output.proposed",
    );
  });

  it("marks only the unreadable source unavailable instead of failing the inbox", async () => {
    const { service } = harness({
      role: "viewer",
      options: {
        counts: { in_review: 2 },
        pipelineRuns: [],
        outputs: [],
        threads: [],
        failSources: ["quality"],
      } as FakeStudioOptions,
    });
    const inbox = await service.inbox();
    expect(inbox.needsAttention.items[0]).toMatchObject({
      key: "listings_with_gaps",
      count: null,
    });
    expect(inbox.needsAttention.items[3]).toMatchObject({
      key: "listings_awaiting_review",
      count: 2,
    });
    expect(inbox.needsAttention.unavailable).toBe(false);
    expect(inbox.jobs.unavailable).toBe(false);
    expect(inbox.outputs.unavailable).toBe(false);
    expect(inbox.conversations.unavailable).toBe(false);
  });

  it("marks each section unavailable when its own read fails", async () => {
    const { service } = harness({
      role: "viewer",
      options: {
        counts: { received: 1 },
        quality: {
          hasGapsCount: 0,
          noActiveVersion: 0,
          unassessableActiveVersion: 0,
        },
        pipelineRuns: [],
        outputs: [],
        threads: [],
        failSources: ["pipelineRuns", "outputs", "threads"],
      } as FakeStudioOptions,
    });
    const inbox = await service.inbox();
    expect(inbox.jobs.unavailable).toBe(true);
    expect(inbox.outputs.unavailable).toBe(true);
    expect(inbox.conversations.unavailable).toBe(true);
    expect(inbox.needsAttention.unavailable).toBe(false);
  });

  it("keeps other users' private conversations out of the inbox", async () => {
    const shared = fakeStudioThread({
      workspaceId: WORKSPACE,
      createdBy: "actor_other",
      title: "Shared conversation",
    });
    const hiddenPrivate = fakeStudioThread({
      workspaceId: WORKSPACE,
      createdBy: "actor_other",
      title: "Their private conversation",
      visibility: "private",
    });
    const ownPrivate = fakeStudioThread({
      workspaceId: WORKSPACE,
      createdBy: "actor_ops",
      title: "My private conversation",
      visibility: "private",
    });
    const viewer = harness({
      role: "viewer",
      options: { threads: [shared, hiddenPrivate, ownPrivate] },
    });
    const viewerInbox = await viewer.service.inbox();
    expect(
      viewerInbox.conversations.items.map((item) => item.title).sort(),
    ).toEqual(["My private conversation", "Shared conversation"]);

    const admin = harness({
      role: "admin",
      options: { threads: [shared, hiddenPrivate, ownPrivate] },
    });
    const adminInbox = await admin.service.inbox();
    expect(
      adminInbox.conversations.items.map((item) => item.title).sort(),
    ).toEqual([
      "My private conversation",
      "Shared conversation",
      "Their private conversation",
    ]);
  });

  it("is readable by a viewer like the overview", async () => {
    const { service } = harness({ role: "viewer" });
    await expect(service.inbox()).resolves.toMatchObject({
      needsAttention: expect.objectContaining({ unavailable: false }),
    });
  });
});

describe("studio usage metrics", () => {
  const SUMMARY = {
    runs: {
      total: 4,
      succeeded: 2,
      failed: 1,
      cancelled: 0,
      outcomeUnknown: 1,
      queuedOrRunning: 0,
    },
    tokens: { input: "110", output: "55" },
    spend: { settledUsd: "0.025000", reservedUsd: "0.030000" },
    mcpCalls: {
      total: 5,
      ok: 3,
      denied: 1,
      error: 1,
      unavailable: 0,
      schemaDrift: 0,
    },
    threadsCreated: 2,
    messages: 6,
  } as const;

  it("returns the admin usage summary with a deterministic 30-day window", async () => {
    const { service, fake } = harness({
      role: "admin",
      options: { metrics: SUMMARY },
    });
    const metrics = await service.metrics();
    const since = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(metrics).toEqual({
      windowDays: 30,
      since: since.toISOString(),
      asOf: NOW.toISOString(),
      runs: SUMMARY.runs,
      tokens: SUMMARY.tokens,
      spendUsd: { settled: "0.025000", reserved: "0.030000" },
      mcpCalls: SUMMARY.mcpCalls,
      threadsCreated: 2,
      messages: 6,
    });
    expect(fake.state.metricsSince?.toISOString()).toBe(since.toISOString());
    expect(fake.state.writes).toContain("metrics.summary");
  });

  it.each(["viewer", "operator", "reviewer"] as const)(
    "refuses the %s role",
    async (role) => {
      const { service, fake } = harness({
        role,
        options: { metrics: SUMMARY },
      });
      await expect(service.metrics()).rejects.toMatchObject({
        status: 403,
        code: "insufficient_role",
      });
      expect(fake.state.writes).not.toContain("metrics.summary");
    },
  );
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

describe("product_shot.prepare turns (C1 v1.1)", () => {
  const PRODUCT_LISTING_ID = "22222222-2222-4222-8222-222222222222";
  const SOURCE_PNG = "33333333-3333-4333-8333-333333333333";

  function productShotOptions(
    overrides: Partial<FakeStudioOptions> = {},
  ): FakeStudioOptions {
    return {
      catalog: catalogOptions(),
      snapshots: {
        [PRODUCT_LISTING_ID]: reviewSnapshot({
          listingId: PRODUCT_LISTING_ID,
          content: reviewableContent(),
          flags: [],
        }),
      },
      sourceAssets: [
        { id: SOURCE_PNG, kind: "image/png", listingId: PRODUCT_LISTING_ID },
        {
          id: "asset-jpeg",
          kind: "image/jpeg",
          listingId: PRODUCT_LISTING_ID,
        },
        {
          id: "asset-cutout",
          kind: "image/png",
          listingId: PRODUCT_LISTING_ID,
          metadata: { role: "product_shot_cutout" },
        },
        {
          id: "asset-pdf",
          kind: "application/pdf",
          listingId: PRODUCT_LISTING_ID,
        },
      ],
      productShotAttempts: {
        [PRODUCT_LISTING_ID]: {
          state: "candidate_ready",
          sourceAssetId: SOURCE_PNG,
          candidateReady: true,
        },
      },
      ...overrides,
    };
  }

  it("asks for a listing id without touching a model", async () => {
    const modelFactory = vi.fn(() => {
      throw new Error("needs_input must not build a model");
    });
    const { service, fake } = harness({
      options: productShotOptions(),
      createModel: modelFactory as never,
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "client-product-shot-input",
        text: "prepare the product shot",
        skillKey: "product_shot.prepare",
      }),
    );
    expect(result.reply.status).toBe("needs_input");
    expect(result.reply.followUps[0]?.key).toBe(
      "studio.needs_input.product_shot_listing",
    );
    expect(modelFactory).not.toHaveBeenCalled();
    expect(fake.state.writes).not.toContain("sourceAssets.listForListing");
  });

  it("prepares a deterministic handoff without a model or provider call", async () => {
    const modelFactory = vi.fn(() => {
      throw new Error("no AI settings means no model");
    });
    const { service, fake } = harness({
      options: productShotOptions(),
      createModel: modelFactory as never,
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "client-product-shot-handoff",
        text: `prepare the product shot for listing ${PRODUCT_LISTING_ID}`,
        skillKey: "product_shot.prepare",
      }),
    );
    expect(result.reply.skillKey).toBe("product_shot.prepare");
    expect(result.reply.skillVersion).toBe("1.1.0");
    expect(result.reply.status).toBe("answered");
    expect(result.reply.outputs).toEqual([]);
    expect(result.reply.dispatch).toEqual({
      kind: "product_shot_handoff",
      listingId: PRODUCT_LISTING_ID,
      assetIds: [SOURCE_PNG, "asset-jpeg"],
      state: "candidate_ready",
      ready: true,
    });
    expect(result.reply.limitations.map((line) => line.key)).toEqual([
      "studio.limit.product_shot_handoff",
    ]);
    expect(modelFactory).not.toHaveBeenCalled();
    expect(fake.state.writes).toContain("sourceAssets.listForListing");
    expect(fake.state.writes).toContain("productShots.currentForListing");
    expect(fake.state.outputs).toEqual([]);
    expect(fake.state.runs[0]?.status).toBe("succeeded");
    // The persisted assistant message carries the same handoff, not prose.
    const persisted = fake.state.messages.find(
      (message) => message.role === "assistant",
    );
    expect(persisted?.content).toMatchObject({
      dispatch: { kind: "product_shot_handoff", ready: true },
    });
    expect(JSON.stringify(fake.state.messages)).not.toContain("signed");
  });

  it("stays partial when the listing has no usable source image", async () => {
    const { service } = harness({
      options: productShotOptions({
        sourceAssets: [
          {
            id: "asset-pdf-only",
            kind: "application/pdf",
            listingId: PRODUCT_LISTING_ID,
          },
        ],
        productShotAttempts: {},
      }),
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "client-product-shot-empty",
        text: `prepare the product shot for listing ${PRODUCT_LISTING_ID}`,
        skillKey: "product_shot.prepare",
      }),
    );
    expect(result.reply.status).toBe("partial");
    expect(result.reply.dispatch).toMatchObject({
      kind: "product_shot_handoff",
      ready: false,
      assetIds: [],
      state: null,
    });
    const keys = result.reply.limitations.map((line) => line.key);
    expect(keys).toContain("studio.limit.product_shot_no_source");
    expect(keys).toContain("studio.limit.product_shot_state_unknown");
  });

  it("stays partial for an unknown listing instead of inventing assets", async () => {
    const { service } = harness({ options: productShotOptions() });
    const threadId = await openThread(service);
    const unknown = "44444444-4444-4444-8444-444444444444";
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "client-product-shot-missing",
        text: `prepare the product shot for listing ${unknown}`,
        skillKey: "product_shot.prepare",
      }),
    );
    expect(result.reply.status).toBe("partial");
    expect(result.reply.dispatch).toMatchObject({
      kind: "product_shot_handoff",
      listingId: unknown,
      ready: false,
    });
    expect(result.reply.limitations.map((line) => line.key)).toContain(
      "studio.limit.product_shot_listing_unavailable",
    );
  });
});

describe("supplier.intel_proposal turns (C1 v1.1)", () => {
  const SUPPLIER_LISTING_ID = "55555555-5555-4555-8555-555555555555";
  const IMPORT_ID = "66666666-6666-4666-8666-666666666666";

  function supplierOptions(
    overrides: Partial<FakeStudioOptions> = {},
  ): FakeStudioOptions {
    return {
      catalog: catalogOptions(),
      snapshots: {
        [SUPPLIER_LISTING_ID]: reviewSnapshot({
          listingId: SUPPLIER_LISTING_ID,
          content: reviewableContent(),
          flags: [],
        }),
      },
      sourceImports: [
        { id: IMPORT_ID, createdAt: new Date("2026-11-08T10:00:00.000Z") },
      ],
      platformProductByListing: {
        [SUPPLIER_LISTING_ID]: {
          id: "product-supplier-1",
          listingId: SUPPLIER_LISTING_ID,
          rawRow: {
            supplier: "Demo Supplier Ltd",
            brand: "Chateau Demo",
            sku: "OPAK-001",
            barcode: "",
            mpn: null,
            productCost: "120.0",
            tradePrice: "150.0",
          },
          sourceImportId: IMPORT_ID,
        },
      },
      ...overrides,
    };
  }

  it("saves a deterministic finding and never touches a model", async () => {
    const modelFactory = vi.fn(() => {
      throw new Error("deterministic supplier intel must not build a model");
    });
    const { service, fake } = harness({
      options: supplierOptions(),
      createModel: modelFactory as never,
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "client-supplier",
        text: `compile supplier intel for listing ${SUPPLIER_LISTING_ID}`,
        skillKey: "supplier.intel_proposal",
      }),
    );
    expect(result.reply.skillVersion).toBe("1.1.0");
    expect(result.reply.status).toBe("answered");
    expect(result.reply.outputs).toHaveLength(1);
    expect(modelFactory).not.toHaveBeenCalled();
    expect(fake.state.runs[0]?.status).toBe("succeeded");
    expect(fake.state.writes).toContain("platformProducts.getByListingId");
    expect(fake.state.writes).toContain("sourceImports.getById");
    expect(fake.state.writes).toContain("outputs.create");
    expect(fake.state.writes).toContain("outputs.addVersion");
    expect(fake.state.outputs[0]?.title).toContain("Supplier intel ·");

    const version = fake.state.outputVersions[0];
    expect(version?.payload).toMatchObject({
      schemaVersion: "wukong-supplier-intel/v1",
      listingId: SUPPLIER_LISTING_ID,
      productId: "product-supplier-1",
      missingFields: ["barcode", "mpn"],
    });
    const fields = version?.payload.fields as Array<{
      field: string;
      value: string;
      evidenceRefs: string[];
    }>;
    expect(fields.map((entry) => entry.field)).toEqual([
      "supplier",
      "brand",
      "sku",
      "productCost",
      "tradePrice",
    ]);
    expect(fields[0]).toEqual({
      field: "supplier",
      value: "Demo Supplier Ltd",
      evidenceRefs: [
        "workbook:product-supplier-1",
        `source_import:${IMPORT_ID}`,
      ],
    });
    expect(result.reply.limitations.map((line) => line.key)).toEqual(
      expect.arrayContaining([
        "studio.limit.supplier_not_applied",
        "studio.limit.supplier_website_unlinked",
        "studio.limit.supplier_fields_missing",
      ]),
    );
  });

  it("stays partial without a linked workbook row and saves nothing", async () => {
    const { service, fake } = harness({
      options: supplierOptions({ platformProductByListing: {} }),
    });
    const threadId = await openThread(service);
    const result = await service.sendMessage(
      threadId,
      body({
        clientMessageId: "client-supplier-missing",
        text: `compile supplier intel for listing ${SUPPLIER_LISTING_ID}`,
        skillKey: "supplier.intel_proposal",
      }),
    );
    expect(result.reply.status).toBe("partial");
    expect(result.reply.outputs).toEqual([]);
    expect(fake.state.outputs).toEqual([]);
    expect(result.reply.limitations.map((line) => line.key)).toContain(
      "studio.limit.supplier_workbook_unavailable",
    );
  });
});
