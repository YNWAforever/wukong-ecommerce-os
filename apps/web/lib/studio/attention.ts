import type { StudioCopyKey } from "../studio-copy";
import type { StudioInboxResult } from "./contracts";

/**
 * Priority queue derived from the read-only orchestration inbox (P1).
 *
 * The inbox already reads and classifies every source safely: unavailable
 * sources are `null`/`unavailable`, never a fabricated zero, and bounded lists
 * say `truncated`. This module only re-orders those records for a first-time
 * operator: one row per decision, one action link, and the role that owns the
 * decision. It performs no read, write or model call and does not bypass the
 * inbox bounds.
 *
 * Ordering:
 *  1. the review queue (intake/in-review work)
 *  2. quality gaps
 *  3. listings without an active version
 *  4. active versions that cannot be assessed
 *  5. pipeline jobs that are not `succeeded`
 *  6. drafts awaiting an operator
 *  7. saved work awaiting reviewer sign-off
 *  8. recent conversations (lowest; context, not a decision)
 *
 * A count of `0` is dropped (there is nothing to do). A `null` count means the
 * source could not be read and is dropped too — the component reports the
 * incomplete read separately instead of implying "no work".
 */

export type StudioAttentionOwner = "operator" | "reviewer" | "admin";

export type StudioAttentionKind =
  | "review"
  | "gaps"
  | "noActiveVersion"
  | "unassessableVersion"
  | "job"
  | "draftOutput"
  | "signoffOutput"
  | "conversation";

export type StudioAttentionEntry = {
  readonly id: string;
  readonly kind: StudioAttentionKind;
  readonly owner: StudioAttentionOwner;
  readonly line: {
    readonly key: StudioCopyKey;
    readonly values?: Readonly<Record<string, string | number>>;
  };
  readonly href: string;
  readonly actionKey: StudioCopyKey;
};

export type StudioAttentionQueue = {
  readonly items: readonly StudioAttentionEntry[];
  readonly total: number;
  /** Every source could not be read. */
  readonly unavailable: boolean;
  /** At least one source failed or a count is missing; an empty list proves nothing. */
  readonly incomplete: boolean;
  /** A bounded source dropped older records; the queue is not the full set. */
  readonly truncated: boolean;
};

const OWNER_BY_KIND = {
  review: "operator",
  gaps: "operator",
  noActiveVersion: "operator",
  unassessableVersion: "operator",
  job: "operator",
  draftOutput: "operator",
  signoffOutput: "reviewer",
  conversation: "operator",
} as const satisfies Record<StudioAttentionKind, StudioAttentionOwner>;

const JOB_STATE_KEYS = {
  failed: "studio.today.job.failed",
  running: "studio.today.job.running",
  queued: "studio.today.job.queued",
  cancelled: "studio.today.job.cancelled",
} as const satisfies Record<string, StudioCopyKey>;

function attentionCount(
  inbox: StudioInboxResult,
  key: StudioInboxResult["needsAttention"]["items"][number]["key"],
): number | null {
  return (
    inbox.needsAttention.items.find((item) => item.key === key)?.count ?? null
  );
}

/**
 * Stored artifact titles end with the generation timestamp (the output service
 * writes `"<kind label> · <ISO>"`). A raw ISO timestamp on the primary queue is
 * a machine fact, not a title, so keep the readable part for display only.
 * The stored record is untouched.
 */
export function displayArtifactTitle(title: string): string {
  return (
    title.replace(/\s*·\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*$/, "").trim() || title
  );
}

function countEntry(
  inbox: StudioInboxResult,
  input: {
    kind: StudioAttentionKind;
    sourceKey: Parameters<typeof attentionCount>[1];
    lineKey: StudioCopyKey;
    href: string;
    actionKey: StudioCopyKey;
  },
): StudioAttentionEntry | null {
  const count = attentionCount(inbox, input.sourceKey);
  if (count === null || count <= 0) return null;
  return {
    id: `${input.kind}:${input.sourceKey}`,
    kind: input.kind,
    owner: OWNER_BY_KIND[input.kind],
    line: { key: input.lineKey, values: { count } },
    href: input.href,
    actionKey: input.actionKey,
  };
}

/** Re-order the inbox aggregate into one prioritised, owner-labelled list. */
export function buildStudioAttentionQueue(
  inbox: StudioInboxResult,
): StudioAttentionQueue {
  const items: StudioAttentionEntry[] = [];

  const counts: readonly (StudioAttentionEntry | null)[] = [
    countEntry(inbox, {
      kind: "review",
      sourceKey: "listings_awaiting_review",
      lineKey: "studio.today.line.review",
      href: "/dashboard",
      actionKey: "studio.today.action.review",
    }),
    countEntry(inbox, {
      kind: "gaps",
      sourceKey: "listings_with_gaps",
      lineKey: "studio.today.line.gaps",
      href: "/quality",
      actionKey: "studio.today.action.quality",
    }),
    countEntry(inbox, {
      kind: "noActiveVersion",
      sourceKey: "listings_without_active_version",
      lineKey: "studio.today.line.noActive",
      href: "/quality",
      actionKey: "studio.today.action.quality",
    }),
    countEntry(inbox, {
      kind: "unassessableVersion",
      sourceKey: "unassessable_active_version",
      lineKey: "studio.today.line.unassessable",
      href: "/quality",
      actionKey: "studio.today.action.quality",
    }),
  ];
  for (const entry of counts) if (entry) items.push(entry);

  for (const job of inbox.jobs.items) {
    items.push({
      id: `job:${job.jobId}`,
      kind: "job",
      owner: OWNER_BY_KIND.job,
      line: {
        key:
          JOB_STATE_KEYS[job.state as keyof typeof JOB_STATE_KEYS] ??
          "studio.today.job.other",
      },
      href: job.deepLink,
      actionKey: "studio.today.action.jobs",
    });
  }

  for (const output of inbox.outputs.items) {
    if (output.status === "draft") {
      items.push({
        id: `draft:${output.outputId}`,
        kind: "draftOutput",
        owner: OWNER_BY_KIND.draftOutput,
        line: {
          key: "studio.today.line.draftOutput",
          values: { title: displayArtifactTitle(output.title) },
        },
        href: output.deepLink ?? "/studio/outputs",
        actionKey: "studio.today.action.outputs",
      });
      continue;
    }
    // A confirmed save is already signed off; only an unconfirmed one is work.
    if (output.confirmation !== "unconfirmed") continue;
    items.push({
      id: `signoff:${output.outputId}`,
      kind: "signoffOutput",
      owner: OWNER_BY_KIND.signoffOutput,
      line: {
        key: "studio.today.line.signoffOutput",
        values: { title: displayArtifactTitle(output.title) },
      },
      href: output.deepLink ?? "/studio/outputs",
      actionKey: "studio.today.action.outputs",
    });
  }

  for (const thread of inbox.conversations.items) {
    items.push({
      id: `thread:${thread.threadId}`,
      kind: "conversation",
      owner: OWNER_BY_KIND.conversation,
      line: {
        key: "studio.today.line.conversation",
        values: { title: thread.title },
      },
      href: thread.deepLink,
      actionKey: "studio.today.action.thread",
    });
  }

  const unavailable =
    inbox.needsAttention.unavailable &&
    inbox.jobs.unavailable &&
    inbox.outputs.unavailable &&
    inbox.conversations.unavailable;
  const countsMissing = inbox.needsAttention.items.some(
    (entry) => entry.count === null,
  );
  const incomplete =
    !unavailable &&
    (inbox.needsAttention.unavailable ||
      countsMissing ||
      inbox.jobs.unavailable ||
      inbox.outputs.unavailable ||
      inbox.conversations.unavailable);
  const truncated =
    inbox.jobs.truncated ||
    inbox.outputs.truncated ||
    inbox.conversations.truncated;
  return { items, total: items.length, unavailable, incomplete, truncated };
}
