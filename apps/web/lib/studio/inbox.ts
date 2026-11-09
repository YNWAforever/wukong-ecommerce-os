import type {
  StudioInboxAttentionItem,
  StudioInboxConversationItem,
  StudioInboxJobItem,
  StudioInboxOutputItem,
  StudioInboxResult,
} from "./contracts";

/**
 * Pure builder for the read-only orchestration inbox (P3.1).
 *
 * It receives records that the service already read through one
 * `db.forWorkspace` transaction and only classifies/bounds them. There are no
 * writes, no model calls and no new repository methods. An input that is `null`
 * means "that source could not be read": the section is marked unavailable and
 * its counts stay `null`, never a fabricated zero. Bounds are explicit and each
 * bounded list says `truncated` when records were dropped.
 */

export const STUDIO_INBOX_LIMITS = {
  jobs: 5,
  outputs: 10,
  conversations: 5,
} as const;

/** Statuses whose counts mean "a person still has review work to do". */
const AWAITING_REVIEW_STATUSES = [
  "received",
  "processing",
  "needs_info",
  "in_review",
  "reopened",
] as const;

export type StudioInboxInput = {
  /** Injected clock: the builder never reads the system time itself. */
  now: Date;
  listingCounts: Readonly<Record<string, number>> | null;
  quality: {
    hasGapsCount: number;
    noActiveVersion: number;
    unassessableActiveVersion: number;
  } | null;
  jobs: ReadonlyArray<{
    id: string;
    status: string;
    errorCode: string | null;
    createdAt: Date;
  }> | null;
  outputs: ReadonlyArray<{
    id: string;
    kind: string;
    title: string;
    status: string;
  }> | null;
  threads: ReadonlyArray<{
    id: string;
    title: string;
    updatedAt: Date;
  }> | null;
};

function buildAttention(
  input: StudioInboxInput,
): StudioInboxResult["needsAttention"] {
  const items: StudioInboxAttentionItem[] = [];
  const quality = input.quality;

  items.push({
    key: "listings_with_gaps",
    count: quality?.hasGapsCount ?? null,
    deepLink: "/quality",
  });
  items.push({
    key: "listings_without_active_version",
    count: quality?.noActiveVersion ?? null,
    deepLink: "/quality",
  });
  items.push({
    key: "unassessable_active_version",
    count: quality?.unassessableActiveVersion ?? null,
    deepLink: "/quality",
  });

  const counts = input.listingCounts;
  items.push({
    key: "listings_awaiting_review",
    count:
      counts === null
        ? null
        : AWAITING_REVIEW_STATUSES.reduce(
            (sum, status) => sum + (counts[status] ?? 0),
            0,
          ),
    deepLink: "/dashboard",
  });

  return {
    items,
    unavailable: input.quality === null && input.listingCounts === null,
    deepLink: "/quality",
  };
}

function buildJobs(input: StudioInboxInput): StudioInboxResult["jobs"] {
  if (input.jobs === null)
    return {
      items: [],
      truncated: false,
      unavailable: true,
      deepLink: "/jobs",
    };
  // A "succeeded" run is not actionable; started/failed both are surfaced.
  const actionable = input.jobs.filter((job) => job.status !== "succeeded");
  const visible = actionable.slice(0, STUDIO_INBOX_LIMITS.jobs);
  const items: StudioInboxJobItem[] = visible.map((job) => ({
    jobId: job.id,
    state: job.status,
    errorCode: job.errorCode,
    createdAt: job.createdAt.toISOString(),
    deepLink: "/jobs",
  }));
  return {
    items,
    truncated: actionable.length > visible.length,
    unavailable: false,
    deepLink: "/jobs",
  };
}

function buildOutputs(input: StudioInboxInput): StudioInboxResult["outputs"] {
  if (input.outputs === null)
    return {
      items: [],
      truncated: false,
      unavailable: true,
      deepLink: "/studio/outputs",
    };
  const drafts = input.outputs.filter((output) => output.status === "draft");
  const saved = input.outputs.filter((output) => output.status === "saved");
  const combined = [...drafts, ...saved];
  const visible = combined.slice(0, STUDIO_INBOX_LIMITS.outputs);
  const items: StudioInboxOutputItem[] = visible.map((output) => ({
    outputId: output.id,
    kind: output.kind,
    title: output.title,
    status: output.status === "draft" ? "draft" : "saved",
    deepLink: "/studio/outputs",
  }));
  return {
    items,
    truncated: combined.length > visible.length,
    unavailable: false,
    deepLink: "/studio/outputs",
  };
}

function buildConversations(
  input: StudioInboxInput,
): StudioInboxResult["conversations"] {
  if (input.threads === null)
    return {
      items: [],
      truncated: false,
      unavailable: true,
      deepLink: "/studio/threads",
    };
  const visible = input.threads.slice(0, STUDIO_INBOX_LIMITS.conversations);
  const items: StudioInboxConversationItem[] = visible.map((thread) => ({
    threadId: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt.toISOString(),
    deepLink: `/studio/t/${encodeURIComponent(thread.id)}`,
  }));
  return {
    items,
    truncated: input.threads.length > visible.length,
    unavailable: false,
    deepLink: "/studio/threads",
  };
}

/** Classify and bound already-read records into the inbox aggregate. */
export function buildStudioInbox(input: StudioInboxInput): StudioInboxResult {
  return {
    asOf: input.now.toISOString(),
    needsAttention: buildAttention(input),
    jobs: buildJobs(input),
    outputs: buildOutputs(input),
    conversations: buildConversations(input),
  };
}
