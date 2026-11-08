import type {
  ComplianceFlag,
  DomainAuditEvent,
  ReviewableListing,
} from "@wukong/core";
import type {
  StudioMessage,
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
  Awaited<
    ReturnType<WorkspaceRepositories["listings"]["getReviewSnapshot"]>
  >
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

export type FakeBudgetReservation = {
  runId: string;
  pricingVersion: string;
  reservedUsd: string;
  settledUsd: string | null;
  state: "reserved" | "settled" | "released" | "uncertain";
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
      status: (input.status ?? "in_review") as ReviewSnapshot["listing"]["status"],
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
  counts?: Record<string, number>;
  /** Make the assistant message append fail, to exercise the failure path. */
  failOnAssistantAppend?: boolean;
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
    audits: DomainAuditEvent[];
    writes: string[];
    workspaceCalls: string[];
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

/**
 * Build the fake repository bundle. Only the methods the Studio service uses
 * are implemented; everything else stays absent because the service may not
 * touch it.
 */
export function createFakeStudio(
  options: FakeStudioOptions = {},
): FakeStudio {
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
    budgets: [],
    audits: [],
    writes: [],
    workspaceCalls: [],
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
      settings: {
        get: async () => {
          state.writes.push("settings.get");
          return settings;
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
        list: async (input: { limit?: number } = {}) => {
          state.writes.push("threads.list");
          const limit = Math.min(Math.max(input.limit ?? 50, 1), 50);
          const items = state.threads.slice(0, limit);
          return { items, truncated: state.threads.length > limit };
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
              .reduce((max, message) => Math.max(max, message.sequence), 0) +
            1;
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
      outputs: {},
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
          if (existing)
            return { accepted: true, state: existing.state };
          const committed = state.budgets
            .filter((budget) =>
              ["reserved", "settled", "uncertain"].includes(budget.state),
            )
            .reduce(
              (sum, budget) =>
                sum + Number(budget.settledUsd ?? budget.reservedUsd),
              0,
            );
          if (committed + Number(input.reservedUsd) > Number(input.workspaceCapUsd)) {
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
    },
    audit: {
      write: async (event: DomainAuditEvent) => {
        state.writes.push("audit.write");
        state.audits.push(event);
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
      countByStatus: async () => {
        state.writes.push("listings.countByStatus");
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
        return quality;
      },
    },
    pipelineRuns: {
      listForWorkspace: async (limit = 100) => {
        state.writes.push("pipelineRuns.listForWorkspace");
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

/** A `getDatabase` fake that records workspace-scoped calls. */
export function fakeGetDatabase(
  repos: WorkspaceRepositories,
  workspaceCalls: string[] = [],
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
