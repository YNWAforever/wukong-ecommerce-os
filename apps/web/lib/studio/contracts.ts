import { z } from "zod";

import type {
  StudioTraceStep,
  StudioTurnReply,
} from "./types";

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
  attachmentAssetIds: z
    .array(z.string().min(1).max(200))
    .max(8)
    .optional(),
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
