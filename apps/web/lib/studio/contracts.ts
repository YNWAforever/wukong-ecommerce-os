import { z } from "zod";

import type { StudioTraceStep, StudioTurnReply } from "./types";

/**
 * Strict HTTP request bodies and response types for the Studio conversation
 * APIs (plan Task 6, spec §3.2).
 *
 * Every request schema is `.strict()`: a tenant id, role, actor, model or any
 * other unknown key is a 400, never silently dropped. Nothing here names a
 * workspace, role, provider or model — those come from the resolved session
 * and the workspace settings row.
 */

/** Thread titles are stored data, never formatted copy. */
export const STUDIO_DEFAULT_THREAD_TITLE = "Studio conversation";

export const createThreadBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  skillKey: z.string().trim().min(1).max(120).optional(),
});
export type CreateThreadBody = z.infer<typeof createThreadBodySchema>;

export const sendMessageBodySchema = z.strictObject({
  /** Client-generated idempotency key, unique per thread. */
  clientMessageId: z.string().min(1).max(128),
  text: z.string().min(1).max(2000),
  skillKey: z.string().trim().min(1).max(120).optional(),
  attachmentAssetIds: z.array(z.string().min(1).max(200)).max(8).optional(),
  locale: z.enum(["zh-Hant", "en"]),
});
export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

export type StudioThreadResponse = {
  threadId: string;
  title: string;
  skillKey: string | null;
  visibility: "workspace" | "private";
  status: "open" | "archived";
  createdBy: string;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A persisted message as stored. Operator content is
 * `{ text, locale, skillKey?, attachmentAssetIds? }`; assistant content is a
 * validated `StudioTurnReply` and therefore already locale-independent.
 */
export type StudioMessageResponse = {
  messageId: string;
  sequence: number;
  role: "operator" | "assistant" | "system" | "tool";
  content: Record<string, unknown>;
  clientMessageId: string | null;
  runId: string | null;
  createdBy: string;
  createdAt: string;
};

export type CreateThreadResult = { threadId: string };

export type ListThreadsResult = {
  items: StudioThreadResponse[];
  truncated: boolean;
  /** Row offset this page was read at; `truncated` means a later page exists. */
  offset: number;
};

export type GetThreadResult = {
  thread: StudioThreadResponse;
  messages: StudioMessageResponse[];
};

/** What `POST /api/studio/threads/[id]/messages` returns. */
export type StudioSendResult = {
  threadId: string;
  messageId: string;
  runId: string;
  reply: StudioTurnReply;
  trace: StudioTraceStep[];
  replayed: boolean;
};

export type StudioRunEventResponse = {
  eventId: string;
  sequence: number;
  kind: string;
  toolId: string | null;
  state: string;
  payload: Record<string, unknown>;
  durationMs: number | null;
  createdAt: string;
};

export type StudioRunResponse = {
  runId: string;
  threadId: string;
  status: string;
  skillKey: string;
  skillVersion: string;
  provider: string | null;
  model: string | null;
  promptVersions: Record<string, unknown>;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: string | null;
  reservedUsd: string | null;
  settledUsd: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  events: StudioRunEventResponse[];
};

/**
 * Deterministic home strip (plan Task 6): reads canonical repositories only,
 * never reserves budget and never calls a model. Each section carries the
 * existing screen it opens.
 */
export type StudioOverviewResult = {
  listingCounts: {
    byStatus: Record<string, number>;
    total: number;
    deepLink: "/dashboard";
  };
  quality: {
    assessmentVersion: string;
    totalListings: number;
    totalAssessed: number;
    cleanCount: number;
    hasGapsCount: number;
    noActiveVersion: number;
    unassessableActiveVersion: number;
    projectionState: "ready" | "pending" | "failed";
    asOf: string | null;
    deepLink: "/quality";
  };
  recentJobs: {
    items: Array<{
      jobId: string;
      state: string;
      createdAt: string;
      deepLink: "/jobs";
    }>;
    deepLink: "/jobs";
  };
};

/** One actionable count in the orchestration inbox (P3.1). */
export type StudioInboxAttentionItem = {
  key:
    | "listings_with_gaps"
    | "listings_without_active_version"
    | "unassessable_active_version"
    | "listings_awaiting_review";
  /** `null` means the source read was unavailable, never a fabricated zero. */
  count: number | null;
  deepLink: "/quality" | "/dashboard";
};

/** A recent non-success pipeline job in the inbox (already bounded by the builder). */
export type StudioInboxJobItem = {
  jobId: string;
  state: string;
  errorCode: string | null;
  createdAt: string;
  deepLink: "/jobs";
};

/** A draft (needs save) or saved (awaits sign-off) Studio artifact. */
export type StudioInboxOutputItem = {
  outputId: string;
  kind: string;
  title: string;
  status: "draft" | "saved";
  deepLink: "/studio/outputs";
};

/** A recent conversation; labelled as recent, with no fabricated reply status. */
export type StudioInboxConversationItem = {
  threadId: string;
  title: string;
  updatedAt: string;
  deepLink: string;
};

/**
 * Read-only orchestration inbox aggregate (`/studio/inbox`, P3.1).
 *
 * Every section is built from existing workspace-scoped reads; a section whose
 * source could not be read says `unavailable` instead of showing zeros, and the
 * bounded lists carry `truncated` so a partial view never implies completeness.
 */
export type StudioInboxResult = {
  asOf: string;
  needsAttention: {
    items: StudioInboxAttentionItem[];
    unavailable: boolean;
    deepLink: "/quality";
  };
  jobs: {
    items: StudioInboxJobItem[];
    truncated: boolean;
    unavailable: boolean;
    deepLink: "/jobs";
  };
  outputs: {
    items: StudioInboxOutputItem[];
    truncated: boolean;
    unavailable: boolean;
    deepLink: "/studio/outputs";
  };
  conversations: {
    items: StudioInboxConversationItem[];
    truncated: boolean;
    unavailable: boolean;
    deepLink: "/studio/threads";
  };
};

/** Versioned Studio artifacts (plan Task 9). */
export type StudioOutputSummary = {
  outputId: string;
  kind: string;
  title: string;
  status: string;
  currentVersion: number;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StudioOutputVersionResponse = {
  revision: number;
  payload: Record<string, unknown>;
  contentDigest: string;
  asOf: string;
  scope: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
};

export type ListOutputsResult = {
  items: StudioOutputSummary[];
  truncated: boolean;
  /** Row offset this page was read at; `truncated` means a later page exists. */
  offset: number;
};

export type GetOutputResult = {
  output: StudioOutputSummary;
  versions: StudioOutputVersionResponse[];
};

export type OutputActionResult = {
  outputId: string;
  status: string;
  version: number;
};

export const outputActionBodySchema = z
  .object({ action: z.enum(["save", "sign_off"]) })
  .strict();
export type OutputActionBody = z.infer<typeof outputActionBodySchema>;

/** Exact artifact kinds a filtered outputs list may request. */
export const STUDIO_OUTPUT_KINDS = [
  "copy_proposal",
  "gap_report",
  "merchant_audit",
  "finding",
] as const;
export type StudioOutputKindFilter = (typeof STUDIO_OUTPUT_KINDS)[number];

/** Exact artifact statuses a filtered outputs list may request. */
export const STUDIO_OUTPUT_STATUSES = [
  "draft",
  "saved",
  "signed_off",
  "discarded",
] as const;
export type StudioOutputStatusFilter = (typeof STUDIO_OUTPUT_STATUSES)[number];

/** Shared bound for the operator's free-text search. */
export const STUDIO_SEARCH_MAX_LENGTH = 120;

/** Studio list pages read this many rows at a time (offset pagination). */
export const STUDIO_PAGE_SIZE = 50;
/** Highest accepted row offset; larger values are a 400, never silently clamped. */
export const STUDIO_MAX_OFFSET = 100_000;

const studioOffsetSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(STUDIO_MAX_OFFSET)
  .default(0);

/**
 * `GET /api/studio/threads` query contract. `q` is a server-side search over
 * title/skill; blank means "no search". `offset` is the row offset of the page
 * (integers 0..100000, default 0). Unknown or malformed parameters are a 400
 * rather than silently ignored or clamped.
 */
export const studioThreadListQuerySchema = z
  .object({
    q: z.string().trim().max(STUDIO_SEARCH_MAX_LENGTH).optional(),
    offset: studioOffsetSchema,
  })
  .strict();
export type StudioThreadListQuery = {
  q?: string;
  offset?: number;
};

/**
 * `GET /api/studio/outputs` query contract: free-text title search plus exact
 * kind/status filters and the page offset. All are optional and combine with
 * AND server-side; a malformed/out-of-range offset is a 400.
 */
export const studioOutputListQuerySchema = z
  .object({
    q: z.string().trim().max(STUDIO_SEARCH_MAX_LENGTH).optional(),
    kind: z.enum(STUDIO_OUTPUT_KINDS).optional(),
    status: z.enum(STUDIO_OUTPUT_STATUSES).optional(),
    offset: studioOffsetSchema,
  })
  .strict();
export type StudioOutputListQuery = {
  q?: string;
  kind?: string;
  status?: string;
  offset?: number;
};

/** The admin usage summary window (A5.2). */
export const STUDIO_METRICS_WINDOW_DAYS = 30;

/**
 * Admin-facing Studio usage summary (A5.2).
 *
 * A read-only projection of the existing studio tables for the last
 * `windowDays`; token sums and spend are decimal strings so they remain
 * bigint-safe, counts are numbers. `asOf`/`since` come from the injected clock.
 */
export type StudioMetricsResult = {
  windowDays: number;
  since: string;
  asOf: string;
  runs: {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    outcomeUnknown: number;
    queuedOrRunning: number;
  };
  tokens: { input: string; output: string };
  spendUsd: { settled: string; reserved: string };
  mcpCalls: {
    total: number;
    ok: number;
    denied: number;
    error: number;
    unavailable: number;
    schemaDrift: number;
  };
  threadsCreated: number;
  messages: number;
};
