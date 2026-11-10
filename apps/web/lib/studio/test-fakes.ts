import type {
  ComplianceFlag,
  DomainAuditEvent,
  ReviewableListing,
} from "@wukong/core";
import type {
  StudioApiToken,
  StudioMcpCall,
  StudioMcpConnection,
  StudioMessage,
  StudioOutput,
  StudioOutputVersion,
  StudioRun,
  StudioRunEvent,
  StudioSettings,
  StudioThread,
  WorkspaceRepositories,
} from "@wukong/db";

/**
 * In-memory fakes for the Studio service and route tests (plan Task 6).
 *
 * Not a test suite: no vitest import, no provider, no database. The fake
 * repository bundle records every write so a test can prove that a rejected
 * request never mutated a thread, message, run or audit row.
 */

export type ReviewSnapshot = NonNullable<
  Awaited<ReturnType<WorkspaceRepositories["listings"]["getReviewSnapshot"]>>
>;
export type CatalogPage = Awaited<
  ReturnType<WorkspaceRepositories["reads"]["catalogPage"]>
>;
export type QualitySummary = Awaited<
  ReturnType<WorkspaceRepositories["qualityProjection"]["read"]>
>;
export type PipelineRun = Awaited<
  ReturnType<WorkspaceRepositories["pipelineRuns"]["listForWorkspace"]>
>[number];
export type StudioMetricsSummary = Awaited<
  ReturnType<WorkspaceRepositories["studio"]["metrics"]["summary"]>
>;

const ZERO_METRICS: StudioMetricsSummary = {
  runs: {
    total: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    outcomeUnknown: 0,
    queuedOrRunning: 0,
  },
  tokens: { input: "0", output: "0" },
  spend: { settledUsd: "0", reservedUsd: "0" },
  mcpCalls: {
    total: 0,
    ok: 0,
    denied: 0,
    error: 0,
    unavailable: 0,
    schemaDrift: 0,
  },
  threadsCreated: 0,
  messages: 0,
};

export type FakeBudgetReservation = {
  runId: string;
  pricingVersion: string;
  reservedUsd: string;
  settledUsd: string | null;
  state: "reserved" | "settled" | "released" | "uncertain";
};

/** One seeded workspace membership, as the hosted MCP server resolves it. */
export type FakeMembership = {
  userId: string;
  role: "viewer" | "operator" | "reviewer" | "admin" | "owner";
};

/** A token row plus the sha256 bearer secret that resolves to it. */
export type FakeTokenLookup = {
  hash: string;
  token: StudioApiToken;
};

const FIXED_NOW = new Date("2026-11-08T10:00:00.000Z");

const DEFAULT_SETTINGS: StudioSettings = {
  workspaceId: "ws_test",
  enabled: true,
  allowedSkills: [],
  monthlyBudgetUsd: null,
  runCeilingUsd: null,
  retentionDays: null,
  defaultHome: false,
  ai: null,
  updatedBy: "actor_ops",
  updatedAt: FIXED_NOW,
};

const DEFAULT_QUALITY: QualitySummary = {
  assessmentVersion: "opak-current-content-v1",
  totalListings: 3,
  totalAssessed: 2,
  cleanCount: 1,
  hasGapsCount: 1,
  noActiveVersion: 1,
  unassessableActiveVersion: 0,
  missingCurrentContent: 0,
  invalidCurrentContent: 0,
  gapCounts: {
    untranslatedName: 1,
    untranslatedSeoTitle: 0,
    seoTitleMirrorsName: 0,
    seoDescriptionMirrorsSeoTitle: 0,
    keywordsMirrorName: 0,
    summaryMissing: 0,
  },
  projection: {
    state: "ready",
    asOf: FIXED_NOW.toISOString(),
    stale: false,
    pendingCount: 0,
    failedCount: 0,
  },
};

/** Full `ReviewableListing` content for gap tests, with overrides. */
export function reviewableContent(
  overrides: Partial<ReviewableListing> = {},
): ReviewableListing {
  return {
    sku: "SKU-1",
    producer: "Demo Estate",
    productType: "wine",
    country: "France",
    region: "Bordeaux",
    vintage: 2019,
    grapeVarieties: ["Merlot"],
    volumeMl: 750,
    abvPercent: 13.5,
    packQuantity: 1,
    priceHkd: 188,
    stockQuantity: 6,
    criticScores: [],
    awards: [],
    title: { en: "Margaux 2019", "zh-Hant": "瑪歌 2019" },
    description: { en: "Tasting notes", "zh-Hant": "品飲筆記" },
    seo: {
      title: { en: "Margaux 2019 wine", "zh-Hant": "瑪歌 2019 葡萄酒" },
      description: { en: "Buy Margaux 2019", "zh-Hant": "購買瑪歌 2019" },
    },
    tags: ["Margaux", "Bordeaux"],
    imageAssetIds: [],
    ...overrides,
  };
}

/** Build a review snapshot for the fake listing repository. */
export function reviewSnapshot(input: {
  listingId: string;
  status?: string;
  content?: ReviewableListing | null;
  versionId?: string;
  sequence?: number;
  flags?: ComplianceFlag[];
  workspaceId?: string;
}): ReviewSnapshot {
  const workspaceId = input.workspaceId ?? "ws_test";
  const content = input.content ?? null;
  const activeVersion =
    content === null
      ? null
      : {
          id: input.versionId ?? "version-1",
          sequence: input.sequence ?? 1,
          content,
        };
  return {
    listing: {
      id: input.listingId,
      workspaceId,
      status: (input.status ??
        "in_review") as ReviewSnapshot["listing"]["status"],
      target: "shopline",
      note: null,
      activeVersionId: activeVersion?.id ?? null,
      inputRevision: 1,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    },
    activeVersion,
    evidence: [],
    flags: input.flags ?? [],
  };
}

export function openBlockingFlag(): ComplianceFlag {
  return {
    id: "flag-1",
    field: "description.en",
    rule: "health_claim",
    severity: "blocking",
    status: "open",
    resolutionReason: null,
  };
}

/** Listing id used by the shared "one matching record" catalog fixture. */
export const FAKE_LISTING_ID = "listing-1";

/** A workspace with one linked listing, a clean snapshot and one job. */
export function answeredTurnOptions(): FakeStudioOptions {
  const createdAt = FIXED_NOW.toISOString();
  return {
    catalog: {
      items: [
        {
          sourceType: "platform",
          id: "product-1",
          remoteProductId: "remote-1",
          origin: "import",
          sku: null,
          listingId: FAKE_LISTING_ID,
          specVersion: null,
          title: "Margaux 2019",
          listingStatus: "in_review",
          openBlockingFlagCount: 0,
          needsReview: false,
          needsAttention: false,
          createdAt,
          updatedAt: createdAt,
          contentDigest: null,
        } as unknown as CatalogPage["items"][number],
      ],
      totalMatching: 1,
      summary: { unlinked: 0, website: 0, workbook: 0, total: 1, linked: 1 },
    },
    snapshots: {
      [FAKE_LISTING_ID]: reviewSnapshot({
        listingId: FAKE_LISTING_ID,
        content: reviewableContent(),
        flags: [],
      }),
    },
    pipelineRuns: [
      {
        id: "job-1",
        listingId: FAKE_LISTING_ID,
        versionId: null,
        status: "succeeded",
        errorCode: null,
        createdAt: FIXED_NOW,
      },
    ],
  };
}

export type FakeStudioOptions = {
  settings?: Partial<StudioSettings>;
  threads?: StudioThread[];
  messages?: StudioMessage[];
  runs?: StudioRun[];
  runEvents?: StudioRunEvent[];
  snapshots?: Record<string, ReviewSnapshot>;
  catalog?: {
    items: CatalogPage["items"];
    totalMatching?: number;
    summary?: Partial<CatalogPage["summary"]>;
  };
  quality?: Partial<QualitySummary>;
  pipelineRuns?: PipelineRun[];
  /** Source assets the draft/proposal skills may resolve (plan Task 10). */
  sourceAssets?: Array<{
    id: string;
    kind: string;
    listingId: string | null;
    metadata?: Record<string, unknown> | null;
  }>;
  /**
   * Product-shot image-review attempt per listing id (C1 prepare/handoff).
   * `candidateReady` stands in for the persisted candidate row; only the
   * boolean crosses the read-deps boundary, never an asset or URL.
   */
  productShotAttempts?: Record<
    string,
    {
      state: string;
      sourceAssetId: string;
      candidateReady: boolean;
    }
  >;
  /** Listing-pipeline operations keyed by run id, for run-status reads. */
  operations?: Record<string, { listingId: string; executionState: string }>;
  /** Recent export attempts for the merchant audit report (plan Task 11). */
  exportAttempts?: Array<{
    id: string;
    artifactStatus: "pending" | "ready" | "failed" | null;
    rowCount: number;
    createdAt: Date;
  }>;
  counts?: Record<string, number>;
  /** Current workspace memberships; defaults to one admin (`actor_ops`). */
  memberships?: FakeMembership[];
  apiTokens?: StudioApiToken[];
  mcpCalls?: StudioMcpCall[];
  mcpConnections?: StudioMcpConnection[];
  outputs?: StudioOutput[];
  outputVersions?: StudioOutputVersion[];
  /** Pre-existing budget reservations (e.g. committed spend for alert tests). */
  budgets?: FakeBudgetReservation[];
  /** Make the assistant message append fail, to exercise the failure path. */
  failOnAssistantAppend?: boolean;
  /** Usage aggregate returned by the fake `metrics.summary` (A5.2). */
  metrics?: StudioMetricsSummary;
  /** Make an inbox/list source reject, to exercise partial-read resilience. */
  failSources?: Array<
    "counts" | "quality" | "pipelineRuns" | "outputs" | "threads"
  >;
};

export type FakeStudio = {
  repos: WorkspaceRepositories;
  state: {
    settings: StudioSettings;
    threads: StudioThread[];
    messages: StudioMessage[];
    runs: StudioRun[];
    runEvents: StudioRunEvent[];
    budgets: FakeBudgetReservation[];
    memberships: FakeMembership[];
    apiTokens: StudioApiToken[];
    mcpCalls: StudioMcpCall[];
    mcpConnections: StudioMcpConnection[];
    outputs: StudioOutput[];
    outputVersions: StudioOutputVersion[];
    audits: DomainAuditEvent[];
    writes: string[];
    workspaceCalls: string[];
    metricsSince: Date | null;
  };
};

let sequenceCounter = 0;
function nextId(prefix: string): string {
  sequenceCounter += 1;
  return `${prefix}-${String(sequenceCounter).padStart(4, "0")}`;
}

function uuid(prefix: string): string {
  // Deterministic fake UUID (valid v4 layout) so service-level UUID checks and
  // route path params behave exactly as they do with real rows.
  nextId(prefix);
  return `00000000-0000-4000-8000-${String(sequenceCounter).padStart(12, "0")}`;
}

export function fakeStudioThread(input: {
  workspaceId: string;
  createdBy: string;
  title: string;
  skillKey?: string | null;
  visibility?: "workspace" | "private";
}): StudioThread {
  const createdAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
  return {
    id: uuid("thread"),
    workspaceId: input.workspaceId,
    createdBy: input.createdBy,
    title: input.title,
    skillKey: input.skillKey ?? null,
    visibility: input.visibility ?? "workspace",
    status: "open",
    lastMessageAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export function fakeStudioRun(input: {
  threadId: string;
  triggerMessageId: string;
  skillKey?: string;
  skillVersion?: string;
  idempotencyKey?: string;
  status?: StudioRun["status"];
  workspaceId?: string;
}): StudioRun {
  const createdAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
  return {
    id: uuid("run"),
    workspaceId: input.workspaceId ?? "ws_test",
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    status: input.status ?? "succeeded",
    skillKey: input.skillKey ?? "catalog.find",
    skillVersion: input.skillVersion ?? "1.0.0",
    provider: null,
    model: null,
    promptVersions: { planner: "1.0.0", composer: "1.0.0" },
    contextDigest: null,
    idempotencyKey: input.idempotencyKey ?? `studio:${input.threadId}:msg`,
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    reservedUsd: null,
    settledUsd: null,
    errorCode: null,
    startedAt: null,
    finishedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export function fakeMessage(input: {
  threadId: string;
  role: StudioMessage["role"];
  content?: Record<string, unknown>;
  sequence?: number;
  runId?: string | null;
  clientMessageId?: string | null;
  workspaceId?: string;
  createdAt?: Date;
}): StudioMessage {
  const createdAt =
    input.createdAt ?? new Date(FIXED_NOW.getTime() + sequenceCounter);
  return {
    id: uuid("message"),
    workspaceId: input.workspaceId ?? "ws_test",
    threadId: input.threadId,
    sequence: input.sequence ?? 1,
    role: input.role,
    content: input.content ?? {},
    clientMessageId: input.clientMessageId ?? null,
    runId: input.runId ?? null,
    createdBy: input.role === "operator" ? "actor_ops" : "studio",
    createdAt,
  };
}

export function fakeApiToken(
  input: {
    workspaceId?: string;
    label?: string;
    prefix?: string;
    scopes?: string[];
    createdBy?: string;
    revokedAt?: Date | null;
    rateLimitPerMinute?: number | null;
    monthlyCallQuota?: number | null;
  } = {},
): StudioApiToken {
  const createdAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
  return {
    id: uuid("token"),
    workspaceId: input.workspaceId ?? "ws_test",
    label: input.label ?? "MCP token",
    prefix: input.prefix ?? "abcdefghijkl",
    scopes: [...(input.scopes ?? ["read", "propose"])],
    createdBy: input.createdBy ?? "actor_ops",
    revokedAt: input.revokedAt ?? null,
    lastUsedAt: null,
    rateLimitPerMinute: input.rateLimitPerMinute ?? null,
    monthlyCallQuota: input.monthlyCallQuota ?? null,
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * Build the fake repository bundle. Only the methods the Studio service uses
 * are implemented; everything else stays absent because the service may not
 * touch it.
 */
export function createFakeStudio(options: FakeStudioOptions = {}): FakeStudio {
  const shouldFailSource = (
    source: NonNullable<FakeStudioOptions["failSources"]>[number],
  ) => options.failSources?.includes(source) ?? false;
  const settings: StudioSettings = {
    ...DEFAULT_SETTINGS,
    ...options.settings,
  };
  const state: FakeStudio["state"] = {
    settings,
    threads: [...(options.threads ?? [])],
    messages: [...(options.messages ?? [])],
    runs: [...(options.runs ?? [])],
    runEvents: [...(options.runEvents ?? [])],
    budgets: [...(options.budgets ?? [])],
    memberships: [
      ...(options.memberships ?? [{ userId: "actor_ops", role: "admin" }]),
    ],
    apiTokens: [...(options.apiTokens ?? [])],
    mcpCalls: [...(options.mcpCalls ?? [])],
    mcpConnections: [...(options.mcpConnections ?? [])],
    outputs: [...(options.outputs ?? [])],
    outputVersions: [...(options.outputVersions ?? [])],
    audits: [],
    writes: [],
    workspaceCalls: [],
    metricsSince: null,
  };

  const quality: QualitySummary = {
    ...DEFAULT_QUALITY,
    ...options.quality,
    gapCounts: {
      ...DEFAULT_QUALITY.gapCounts,
      ...(options.quality?.gapCounts ?? {}),
    },
    projection: {
      ...DEFAULT_QUALITY.projection,
      ...(options.quality?.projection ?? {}),
    },
  };

  const repositories = {
    studio: {
      metrics: {
        summary: async (input: { since: Date }) => {
          state.writes.push("metrics.summary");
          state.metricsSince = input.since;
          return options.metrics ?? ZERO_METRICS;
        },
      },
      settings: {
        get: async () => {
          state.writes.push("settings.get");
          return state.settings;
        },
      },
      workspaceSettings: {
        get: async () => {
          state.writes.push("workspaceSettings.get");
          return state.settings;
        },
        update: async (
          input: {
            enabled: boolean;
            allowedSkills: readonly string[];
            monthlyBudgetUsd: string | null;
            runCeilingUsd: string | null;
            retentionDays: number | null;
            defaultHome: boolean;
            ai: StudioSettings["ai"];
          },
          actorId: string,
        ) => {
          state.writes.push("workspaceSettings.update");
          state.settings = {
            ...state.settings,
            ...input,
            allowedSkills: [...input.allowedSkills],
            updatedBy: actorId,
            updatedAt: new Date(FIXED_NOW.getTime() + sequenceCounter),
          };
          return state.settings;
        },
      },
      threads: {
        create: async (input: {
          createdBy: string;
          title: string;
          skillKey?: string | null;
          visibility?: "workspace" | "private";
        }) => {
          state.writes.push("threads.create");
          const thread = fakeStudioThread({
            workspaceId: settings.workspaceId,
            createdBy: input.createdBy,
            title: input.title,
            skillKey: input.skillKey ?? null,
            visibility: input.visibility,
          });
          state.threads.unshift(thread);
          return thread;
        },
        list: async (
          input: {
            limit?: number;
            offset?: number;
            viewerId?: string;
            includePrivate?: boolean;
            q?: string;
          } = {},
        ) => {
          state.writes.push("threads.list");
          if (shouldFailSource("threads"))
            throw new Error("fake threads source unavailable");
          const limit = Math.min(Math.max(input.limit ?? 50, 1), 50);
          const offset = Math.min(Math.max(input.offset ?? 0, 0), 100_000);
          const search = input.q?.trim().toLocaleLowerCase() ?? "";
          const visible = state.threads.filter((thread) => {
            if (input.viewerId === undefined) return true;
            if (thread.visibility !== "private") return true;
            if (thread.createdBy === input.viewerId) return true;
            return input.includePrivate === true;
          });
          const matched = visible.filter(
            (thread) =>
              search.length === 0 ||
              thread.title.toLocaleLowerCase().includes(search),
          );
          const items = matched.slice(offset, offset + limit);
          return {
            items,
            truncated: matched.length > offset + limit,
          };
        },
        getWithMessages: async (
          id: string,
          input: { messageLimit?: number } = {},
        ) => {
          state.writes.push("threads.getWithMessages");
          const thread = state.threads.find(
            (entry) =>
              entry.id === id && entry.workspaceId === settings.workspaceId,
          );
          if (!thread) return null;
          const limit = Math.min(Math.max(input.messageLimit ?? 100, 1), 200);
          const messages = state.messages
            .filter((message) => message.threadId === id)
            .sort((left, right) => left.sequence - right.sequence)
            .slice(0, limit);
          return { thread, messages };
        },
        touchLastMessage: async (id: string, at?: Date) => {
          const thread = state.threads.find((entry) => entry.id === id);
          if (thread) thread.lastMessageAt = at ?? new Date();
        },
        archive: async () => false,
      },
      messages: {
        append: async (input: {
          threadId: string;
          role: StudioMessage["role"];
          content: Record<string, unknown>;
          clientMessageId?: string | null;
          runId?: string | null;
          createdBy: string;
        }) => {
          state.writes.push("messages.append");
          if (input.role === "assistant" && options.failOnAssistantAppend) {
            throw new Error("assistant append failed");
          }
          const clientMessageId = input.clientMessageId ?? null;
          if (clientMessageId) {
            const existing = state.messages.find(
              (message) =>
                message.threadId === input.threadId &&
                message.clientMessageId === clientMessageId,
            );
            if (existing) return { message: existing, replayed: true };
          }
          const thread = state.threads.find(
            (entry) => entry.id === input.threadId,
          );
          if (!thread) throw new Error("studio thread not found");
          const sequence =
            state.messages
              .filter((message) => message.threadId === input.threadId)
              .reduce((max, message) => Math.max(max, message.sequence), 0) + 1;
          const message = fakeMessage({
            threadId: input.threadId,
            role: input.role,
            content: input.content,
            sequence,
            clientMessageId,
            runId: input.runId ?? null,
            workspaceId: settings.workspaceId,
          });
          state.messages.push(message);
          thread.lastMessageAt = message.createdAt;
          thread.updatedAt = message.createdAt;
          return { message, replayed: false };
        },
        list: async (threadId: string, input: { limit?: number } = {}) => {
          state.writes.push("messages.list");
          const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
          return state.messages
            .filter((message) => message.threadId === threadId)
            .sort((left, right) => left.sequence - right.sequence)
            .slice(0, limit);
        },
      },
      runs: {
        create: async (input: {
          threadId: string;
          triggerMessageId: string;
          skillKey: string;
          skillVersion: string;
          idempotencyKey: string;
          provider?: string | null;
          model?: string | null;
          promptVersions?: Record<string, unknown>;
        }) => {
          state.writes.push("runs.create");
          const existing = state.runs.find(
            (run) => run.idempotencyKey === input.idempotencyKey,
          );
          if (existing) return { run: existing, replayed: true };
          const createdAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
          const run: StudioRun = {
            id: uuid("run"),
            workspaceId: settings.workspaceId,
            threadId: input.threadId,
            triggerMessageId: input.triggerMessageId,
            status: "queued",
            skillKey: input.skillKey,
            skillVersion: input.skillVersion,
            provider: input.provider ?? null,
            model: input.model ?? null,
            promptVersions: input.promptVersions ?? {},
            contextDigest: null,
            idempotencyKey: input.idempotencyKey,
            inputTokens: null,
            outputTokens: null,
            estimatedCostUsd: null,
            reservedUsd: null,
            settledUsd: null,
            errorCode: null,
            startedAt: null,
            finishedAt: null,
            createdAt,
            updatedAt: createdAt,
          };
          state.runs.push(run);
          return { run, replayed: false };
        },
        markRunning: async (id: string) => {
          state.writes.push("runs.markRunning");
          const run = state.runs.find((entry) => entry.id === id);
          if (!run || run.status !== "queued") return null;
          run.status = "running";
          run.startedAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
          return run;
        },
        complete: async (
          id: string,
          input: {
            inputTokens?: number | null;
            outputTokens?: number | null;
            estimatedCostUsd?: string | null;
            settledUsd?: string | null;
          },
        ) => {
          state.writes.push("runs.complete");
          const run = state.runs.find((entry) => entry.id === id);
          if (!run || !["queued", "running"].includes(run.status)) return null;
          run.status = "succeeded";
          run.inputTokens = input.inputTokens ?? null;
          run.outputTokens = input.outputTokens ?? null;
          run.estimatedCostUsd = input.estimatedCostUsd ?? null;
          run.settledUsd = input.settledUsd ?? null;
          run.finishedAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
          return run;
        },
        fail: async (
          id: string,
          input: { errorCode: string; outcomeUnknown?: boolean },
        ) => {
          state.writes.push("runs.fail");
          const run = state.runs.find((entry) => entry.id === id);
          if (!run || !["queued", "running"].includes(run.status)) return null;
          run.status = input.outcomeUnknown ? "outcome_unknown" : "failed";
          run.errorCode = input.errorCode;
          run.finishedAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
          return run;
        },
        get: async (id: string) => {
          state.writes.push("runs.get");
          return state.runs.find((entry) => entry.id === id) ?? null;
        },
      },
      runEvents: {
        appendMany: async (
          runId: string,
          events: ReadonlyArray<{
            kind: StudioRunEvent["kind"];
            state: StudioRunEvent["state"];
            toolId?: string | null;
            payload?: Record<string, unknown>;
            durationMs?: number | null;
          }>,
        ) => {
          state.writes.push("runEvents.appendMany");
          if (events.length === 0) return [];
          const run = state.runs.find((entry) => entry.id === runId);
          if (!run) throw new Error("studio run not found");
          let sequence = state.runEvents
            .filter((event) => event.runId === runId)
            .reduce((max, event) => Math.max(max, event.sequence), 0);
          const appended: StudioRunEvent[] = [];
          for (const event of events) {
            sequence += 1;
            const row: StudioRunEvent = {
              id: uuid("event"),
              workspaceId: settings.workspaceId,
              runId,
              sequence,
              kind: event.kind,
              toolId: event.toolId ?? null,
              state: event.state,
              payload: event.payload ?? {},
              durationMs: event.durationMs ?? null,
              createdAt: new Date(FIXED_NOW.getTime() + sequenceCounter),
            };
            state.runEvents.push(row);
            appended.push(row);
          }
          return appended;
        },
        list: async (runId: string) => {
          state.writes.push("runEvents.list");
          return state.runEvents
            .filter((event) => event.runId === runId)
            .sort((left, right) => left.sequence - right.sequence);
        },
      },
      outputs: {
        create: async (input: {
          threadId?: string | null;
          runId?: string | null;
          kind: StudioOutput["kind"];
          title: string;
          createdBy: string;
        }) => {
          state.writes.push("outputs.create");
          const row: StudioOutput = {
            id: uuid("output"),
            workspaceId: settings.workspaceId,
            threadId: input.threadId ?? null,
            runId: input.runId ?? null,
            kind: input.kind,
            title: input.title,
            status: "draft",
            currentVersion: 0,
            createdBy: input.createdBy,
            createdAt: new Date(FIXED_NOW.getTime() + sequenceCounter),
            updatedAt: new Date(FIXED_NOW.getTime() + sequenceCounter),
          };
          state.outputs.push(row);
          return row;
        },
        addVersion: async (input: {
          outputId: string;
          payload: Record<string, unknown>;
          contentDigest: string;
          asOf: Date;
          scope?: Record<string, unknown>;
          createdBy: string;
        }) => {
          state.writes.push("outputs.addVersion");
          const output = state.outputs.find(
            (entry) => entry.id === input.outputId,
          );
          if (!output) throw new Error("studio output not found");
          const revision = output.currentVersion + 1;
          const version: StudioOutputVersion = {
            id: uuid("outputVersion"),
            workspaceId: settings.workspaceId,
            outputId: input.outputId,
            revision,
            payload: input.payload,
            contentDigest: input.contentDigest,
            asOf: input.asOf,
            scope: input.scope ?? {},
            createdBy: input.createdBy,
            createdAt: new Date(FIXED_NOW.getTime() + sequenceCounter),
          };
          state.outputVersions.push(version);
          output.currentVersion = revision;
          output.updatedAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
          return { output, version };
        },
        get: async (id: string) => {
          state.writes.push("outputs.get");
          return state.outputs.find((entry) => entry.id === id) ?? null;
        },
        list: async (
          input: {
            limit?: number;
            offset?: number;
            q?: string;
            kind?: string;
            status?: string;
          } = {},
        ) => {
          state.writes.push("outputs.list");
          if (shouldFailSource("outputs"))
            throw new Error("fake outputs source unavailable");
          const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
          const offset = Math.min(Math.max(input.offset ?? 0, 0), 100_000);
          const search = input.q?.trim().toLocaleLowerCase() ?? "";
          const filtered = [...state.outputs]
            .filter(
              (output) =>
                (search.length === 0 ||
                  output.title.toLocaleLowerCase().includes(search)) &&
                (input.kind === undefined || output.kind === input.kind) &&
                (input.status === undefined || output.status === input.status),
            )
            .sort(
              (left, right) =>
                right.createdAt.getTime() - left.createdAt.getTime(),
            );
          return {
            items: filtered.slice(offset, offset + limit),
            truncated: filtered.length > offset + limit,
          };
        },
        versions: async (outputId: string) => {
          state.writes.push("outputs.versions");
          return state.outputVersions
            .filter((version) => version.outputId === outputId)
            .sort((left, right) => right.revision - left.revision);
        },
        setStatus: async (
          id: string,
          status: Exclude<StudioOutput["status"], "draft">,
        ) => {
          state.writes.push("outputs.setStatus");
          const output = state.outputs.find((entry) => entry.id === id);
          if (!output || output.currentVersion === 0) return false;
          output.status = status;
          output.updatedAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
          return true;
        },
      },
      budget: {
        reserve: async (input: {
          runId: string;
          pricingVersion: string;
          reservedUsd: string;
          workspaceCapUsd: string;
        }) => {
          state.writes.push("budget.reserve");
          const existing = state.budgets.find(
            (budget) => budget.runId === input.runId,
          );
          if (existing) return { accepted: true, state: existing.state };
          const committed = state.budgets
            .filter((budget) =>
              ["reserved", "settled", "uncertain"].includes(budget.state),
            )
            .reduce(
              (sum, budget) =>
                sum + Number(budget.settledUsd ?? budget.reservedUsd),
              0,
            );
          if (
            committed + Number(input.reservedUsd) >
            Number(input.workspaceCapUsd)
          ) {
            return { accepted: false, state: "blocked" as const };
          }
          state.budgets.push({
            runId: input.runId,
            pricingVersion: input.pricingVersion,
            reservedUsd: input.reservedUsd,
            settledUsd: null,
            state: "reserved",
          });
          return { accepted: true, state: "reserved" as const };
        },
        settle: async (runId: string, settledUsd: string) => {
          state.writes.push("budget.settle");
          const budget = state.budgets.find(
            (entry) => entry.runId === runId && entry.state === "reserved",
          );
          if (!budget) return false;
          budget.state = "settled";
          budget.settledUsd = settledUsd;
          return true;
        },
        release: async (runId: string) => {
          state.writes.push("budget.release");
          const budget = state.budgets.find(
            (entry) => entry.runId === runId && entry.state === "reserved",
          );
          if (!budget) return false;
          budget.state = "released";
          return true;
        },
        markUncertain: async (runId: string) => {
          state.writes.push("budget.markUncertain");
          const budget = state.budgets.find(
            (entry) => entry.runId === runId && entry.state === "reserved",
          );
          if (!budget) return false;
          budget.state = "uncertain";
          return true;
        },
        committedUsd: async () =>
          String(
            state.budgets
              .filter((budget) =>
                ["reserved", "settled", "uncertain"].includes(budget.state),
              )
              .reduce(
                (sum, budget) =>
                  sum + Number(budget.settledUsd ?? budget.reservedUsd),
                0,
              ),
          ),
      },
      apiTokens: {
        create: async (input: {
          label: string;
          tokenHash: string;
          prefix: string;
          scopes: readonly string[];
          createdBy: string;
          rateLimitPerMinute?: number | null;
          monthlyCallQuota?: number | null;
        }) => {
          state.writes.push("apiTokens.create");
          const createdAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
          const token: StudioApiToken = {
            id: uuid("token"),
            workspaceId: settings.workspaceId,
            label: input.label,
            prefix: input.prefix,
            scopes: [...input.scopes],
            createdBy: input.createdBy,
            revokedAt: null,
            lastUsedAt: null,
            rateLimitPerMinute: input.rateLimitPerMinute ?? null,
            monthlyCallQuota: input.monthlyCallQuota ?? null,
            createdAt,
            updatedAt: createdAt,
          };
          state.apiTokens.push(token);
          return token;
        },
        get: async (id: string) => {
          state.writes.push("apiTokens.get");
          return state.apiTokens.find((entry) => entry.id === id) ?? null;
        },
        findByHash: async () => null,
        revoke: async (id: string) => {
          state.writes.push("apiTokens.revoke");
          const token = state.apiTokens.find(
            (entry) => entry.id === id && entry.revokedAt === null,
          );
          if (!token) return false;
          token.revokedAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
          token.updatedAt = token.revokedAt;
          return true;
        },
        updateLimits: async (
          id: string,
          input: {
            rateLimitPerMinute: number | null;
            monthlyCallQuota: number | null;
          },
        ) => {
          state.writes.push("apiTokens.updateLimits");
          const token = state.apiTokens.find(
            (entry) => entry.id === id && entry.revokedAt === null,
          );
          if (!token) return false;
          token.rateLimitPerMinute = input.rateLimitPerMinute;
          token.monthlyCallQuota = input.monthlyCallQuota;
          token.updatedAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
          return true;
        },
        touch: async (id: string) => {
          state.writes.push("apiTokens.touch");
          const token = state.apiTokens.find((entry) => entry.id === id);
          if (token)
            token.lastUsedAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
        },
        list: async (input: { limit?: number } = {}) => {
          state.writes.push("apiTokens.list");
          const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
          return state.apiTokens.slice(0, limit);
        },
        countActive: async () => {
          state.writes.push("apiTokens.countActive");
          return state.apiTokens.filter((entry) => entry.revokedAt === null)
            .length;
        },
      },
      mcpCalls: {
        append: async (input: {
          runId?: string | null;
          connectionId?: string | null;
          tokenId?: string | null;
          toolName: string;
          requestDigest: string;
          responseDigest?: string | null;
          status: StudioMcpCall["status"];
          errorCode?: string | null;
          latencyMs?: number | null;
          caller: StudioMcpCall["caller"];
        }) => {
          state.writes.push("mcpCalls.append");
          const call: StudioMcpCall = {
            id: uuid("mcpcall"),
            workspaceId: settings.workspaceId,
            runId: input.runId ?? null,
            connectionId: input.connectionId ?? null,
            tokenId: input.tokenId ?? null,
            toolName: input.toolName,
            requestDigest: input.requestDigest,
            responseDigest: input.responseDigest ?? null,
            status: input.status,
            errorCode: input.errorCode ?? null,
            latencyMs: input.latencyMs ?? null,
            caller: input.caller,
            createdAt: new Date(FIXED_NOW.getTime() + sequenceCounter),
          };
          state.mcpCalls.push(call);
          return call;
        },
        list: async (input: { limit?: number } = {}) => {
          state.writes.push("mcpCalls.list");
          const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
          return state.mcpCalls.slice(0, limit);
        },
        countForTokenSince: async (tokenId: string, since: Date) => {
          state.writes.push("mcpCalls.countForTokenSince");
          return state.mcpCalls.filter(
            (call) =>
              call.tokenId === tokenId &&
              call.createdAt.getTime() >= since.getTime(),
          ).length;
        },
      },
      mcpConnections: {
        create: async (input: {
          label: string;
          endpointUrl: string;
          transport?: "http" | "sse";
          toolAllowlist: readonly string[];
          schemaHashes: Record<string, unknown>;
          credentialEnvelope?: string | null;
          createdBy: string;
        }) => {
          state.writes.push("mcpConnections.create");
          const createdAt = new Date(FIXED_NOW.getTime() + sequenceCounter);
          const connection: StudioMcpConnection = {
            id: uuid("connection"),
            workspaceId: settings.workspaceId,
            label: input.label,
            endpointUrl: input.endpointUrl,
            transport: input.transport ?? "http",
            status: "draft",
            generation: 1,
            toolAllowlist: [...input.toolAllowlist],
            schemaHashes: { ...input.schemaHashes },
            credentialEnvelope: input.credentialEnvelope ?? null,
            createdBy: input.createdBy,
            approvedBy: null,
            approvedAt: null,
            createdAt,
            updatedAt: createdAt,
          };
          state.mcpConnections.push(connection);
          return connection;
        },
        list: async () => {
          state.writes.push("mcpConnections.list");
          return state.mcpConnections.slice();
        },
        get: async (id: string) => {
          state.writes.push("mcpConnections.get");
          return state.mcpConnections.find((entry) => entry.id === id) ?? null;
        },
        updateStatus: async (
          id: string,
          status: StudioMcpConnection["status"],
          approvedBy: string | null = null,
        ) => {
          state.writes.push("mcpConnections.updateStatus");
          const connection = state.mcpConnections.find(
            (entry) => entry.id === id,
          );
          if (!connection) return null;
          connection.status = status;
          if (status === "approved") {
            connection.approvedBy = approvedBy;
            connection.approvedAt = new Date(
              FIXED_NOW.getTime() + sequenceCounter,
            );
          }
          connection.updatedAt = new Date(
            FIXED_NOW.getTime() + sequenceCounter,
          );
          return connection;
        },
        updateCredential: async (
          id: string,
          credentialEnvelope: string | null,
        ) => {
          state.writes.push("mcpConnections.updateCredential");
          const connection = state.mcpConnections.find(
            (entry) => entry.id === id,
          );
          if (!connection) return null;
          connection.credentialEnvelope = credentialEnvelope;
          connection.generation += 1;
          if (connection.status === "approved") connection.status = "draft";
          connection.updatedAt = new Date(
            FIXED_NOW.getTime() + sequenceCounter,
          );
          return connection;
        },
        updateSchemaHashes: async (
          id: string,
          schemaHashes: Record<string, unknown>,
        ) => {
          state.writes.push("mcpConnections.updateSchemaHashes");
          const connection = state.mcpConnections.find(
            (entry) => entry.id === id,
          );
          if (!connection) return null;
          connection.schemaHashes = { ...schemaHashes };
          connection.generation += 1;
          if (connection.status === "approved") connection.status = "draft";
          connection.updatedAt = new Date(
            FIXED_NOW.getTime() + sequenceCounter,
          );
          return connection;
        },
      },
    },
    memberships: {
      findActiveByUserId: async (
        userId: string,
        requestedWorkspaceId?: string,
      ) => {
        state.writes.push("memberships.findActiveByUserId");
        if (
          requestedWorkspaceId !== undefined &&
          requestedWorkspaceId !== settings.workspaceId
        )
          return null;
        const membership = state.memberships.find(
          (entry) => entry.userId === userId,
        );
        return membership
          ? { userId: membership.userId, role: membership.role }
          : null;
      },
    },
    audit: {
      write: async (event: DomainAuditEvent) => {
        state.writes.push("audit.write");
        state.audits.push(event);
      },
    },
    exportAttempts: {
      listForWorkspace: async (limit = 100) => {
        state.writes.push("exportAttempts.listForWorkspace");
        return (options.exportAttempts ?? []).slice(
          0,
          Math.min(Math.max(limit, 1), 20),
        );
      },
    },
    reads: {
      catalogPage: async () => {
        state.writes.push("reads.catalogPage");
        const items = options.catalog?.items ?? [];
        return {
          nextCursor: null,
          previousCursor: null,
          items,
          totalMatching: options.catalog?.totalMatching ?? items.length,
          summary: {
            website: 0,
            workbook: 0,
            total: items.length,
            linked: 0,
            unlinked: 0,
            needsReview: 0,
            needsAttention: 0,
            published: 0,
            referenceRows: 0,
            drafts: 0,
            boundProducts: 0,
            ...(options.catalog?.summary ?? {}),
          },
        };
      },
    },
    listings: {
      getReviewSnapshot: async (id: string) => {
        state.writes.push("listings.getReviewSnapshot");
        return options.snapshots?.[id] ?? null;
      },
      getById: async (id: string) => {
        state.writes.push("listings.getById");
        const snapshot = options.snapshots?.[id];
        return snapshot ? snapshot.listing : null;
      },
      countByStatus: async () => {
        state.writes.push("listings.countByStatus");
        if (shouldFailSource("counts"))
          throw new Error("fake counts source unavailable");
        const counts: Record<string, number> = {
          received: 0,
          processing: 0,
          needs_info: 0,
          in_review: 0,
          approved: 0,
          reopened: 0,
          publishing: 0,
          published: 0,
          publish_failed: 0,
          failed: 0,
          ...(options.counts ?? {}),
        };
        return counts as never;
      },
    },
    qualityProjection: {
      read: async () => {
        state.writes.push("qualityProjection.read");
        if (shouldFailSource("quality"))
          throw new Error("fake quality source unavailable");
        return quality;
      },
    },
    sourceAssets: {
      getByIds: async (ids: readonly string[]) => {
        state.writes.push("sourceAssets.getByIds");
        const rows = options.sourceAssets ?? [];
        return ids.flatMap((id) => {
          const row = rows.find((asset) => asset.id === id);
          return row ? [{ ...row }] : [];
        });
      },
      listForListing: async (listingId: string) => {
        state.writes.push("sourceAssets.listForListing");
        return (options.sourceAssets ?? [])
          .filter((asset) => asset.listingId === listingId)
          .map((asset) => ({ ...asset }));
      },
      attachToListing: async (listingId: string, ids: readonly string[]) => {
        state.writes.push("sourceAssets.attachToListing");
        for (const asset of options.sourceAssets ?? []) {
          if (ids.includes(asset.id)) asset.listingId = listingId;
        }
      },
      getByStorageKey: async () => null,
    },
    productShots: {
      currentForListing: async (listingId: string) => {
        state.writes.push("productShots.currentForListing");
        const attempt = options.productShotAttempts?.[listingId];
        if (!attempt) return null;
        return {
          attemptId: `attempt-${listingId}`,
          listingId,
          sourceAssetId: attempt.sourceAssetId,
          state: attempt.state as never,
          candidate: attempt.candidateReady ? ({} as never) : null,
        } as never;
      },
    },
    dispatchOutbox: {
      record: async () => [],
      pending: async () => [],
      markDispatched: async (ids: readonly string[]) => {
        state.writes.push(`dispatchOutbox.markDispatched:${ids.length}`);
      },
      markAttempted: async (ids: readonly string[]) => {
        state.writes.push(`dispatchOutbox.markAttempted:${ids.length}`);
      },
    },
    pipelineRuns: {
      getOperation: async (id: string) => {
        state.writes.push("pipelineRuns.getOperation");
        const operation = options.operations?.[id];
        if (!operation) return null;
        return {
          id,
          listingId: operation.listingId,
          executionState: operation.executionState,
        };
      },
      listForWorkspace: async (limit = 100) => {
        state.writes.push("pipelineRuns.listForWorkspace");
        if (shouldFailSource("pipelineRuns"))
          throw new Error("fake pipeline-runs source unavailable");
        return (options.pipelineRuns ?? []).slice(
          0,
          Math.min(Math.max(limit, 1), 100),
        );
      },
    },
  };

  return {
    repos: repositories as unknown as WorkspaceRepositories,
    state,
  };
}

/** A `getDatabase` fake that records workspace-scoped calls and resolves tokens. */
export function fakeGetDatabase(
  repos: WorkspaceRepositories,
  workspaceCalls: string[] = [],
  tokens: readonly FakeTokenLookup[] = [],
) {
  return () =>
    ({
      forWorkspace: async (
        workspaceId: string,
        work: (repositories: WorkspaceRepositories) => unknown,
      ) => {
        workspaceCalls.push(workspaceId);
        return work(repos);
      },
      lookupStudioApiToken: async (tokenHash: string) => {
        const found = tokens.find((entry) => entry.hash === tokenHash);
        if (!found) return null;
        const { token } = found;
        return {
          workspaceId: token.workspaceId,
          tokenId: token.id,
          createdBy: token.createdBy,
          scopes: [...token.scopes],
          revokedAt: token.revokedAt,
          prefix: token.prefix,
          rateLimitPerMinute: token.rateLimitPerMinute,
          monthlyCallQuota: token.monthlyCallQuota,
        };
      },
    }) as never;
}

/** A `SessionContextPort` fake for one fixed membership. */
export function fakeSessionContext(
  role: "viewer" | "operator" | "reviewer" | "admin" | "owner" = "operator",
  overrides: { workspaceId?: string; actorId?: string } = {},
) {
  const context = {
    workspaceId: overrides.workspaceId ?? "ws_test",
    actorId: overrides.actorId ?? "actor_ops",
    role,
  };
  return {
    context,
    port: {
      resolve: async () => context,
    },
  };
}
