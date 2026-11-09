import { describe, expect, it } from "vitest";

import { STUDIO_INBOX_LIMITS, buildStudioInbox } from "./inbox";

/**
 * Pure orchestration-inbox builder (P3.1).
 *
 * The builder receives already-read records; these tests pin the classification
 * (quality counts, non-success jobs, draft/saved outputs, recent threads), the
 * explicit bounds/truncation and the honest missing-source behaviour. No
 * database, no clock: `now` is injected.
 */

const NOW = new Date("2026-11-09T12:00:00.000Z");

function job(id: string, status: string, minutes: number) {
  return {
    id,
    status,
    errorCode: status === "failed" ? "provider_error" : null,
    createdAt: new Date(NOW.getTime() - minutes * 60_000),
  };
}

function output(id: string, status: string, kind = "copy_proposal") {
  return { id, kind, title: `Artifact ${id}`, status };
}

function thread(id: string, minutes: number) {
  return {
    id,
    title: `Conversation ${id}`,
    updatedAt: new Date(NOW.getTime() - minutes * 60_000),
  };
}

const FULL_INPUT = {
  now: NOW,
  listingCounts: { in_review: 2, needs_info: 1, approved: 4 } as Record<
    string,
    number
  >,
  quality: {
    hasGapsCount: 3,
    noActiveVersion: 1,
    unassessableActiveVersion: 2,
  },
  jobs: [
    job("job-failed-1", "failed", 1),
    job("job-succeeded", "succeeded", 2),
    job("job-started", "started", 3),
    job("job-failed-2", "failed", 4),
    job("job-failed-3", "failed", 5),
    job("job-failed-4", "failed", 6),
    job("job-failed-5", "failed", 7),
  ],
  outputs: [
    output("out-draft-1", "draft"),
    output("out-saved-1", "saved"),
    output("out-draft-2", "draft", "finding"),
    output("out-signed", "signed_off"),
    output("out-discarded", "discarded"),
  ],
  threads: Array.from({ length: 7 }, (_, index) =>
    thread(`thread-${index + 1}`, index + 1),
  ),
};

describe("buildStudioInbox", () => {
  it("uses the injected clock for asOf and is pure", () => {
    const first = buildStudioInbox(FULL_INPUT);
    const second = buildStudioInbox(FULL_INPUT);
    expect(first.asOf).toBe(NOW.toISOString());
    expect(first).toEqual(second);
  });

  it("derives attention counts from the quality projection and listing counts", () => {
    const inbox = buildStudioInbox(FULL_INPUT);
    expect(inbox.needsAttention.unavailable).toBe(false);
    expect(inbox.needsAttention.deepLink).toBe("/quality");
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
  });

  it("keeps honest zeros instead of dropping a zero count", () => {
    const inbox = buildStudioInbox({
      ...FULL_INPUT,
      listingCounts: {},
      quality: {
        hasGapsCount: 0,
        noActiveVersion: 0,
        unassessableActiveVersion: 0,
      },
      jobs: [],
      outputs: [],
      threads: [],
    });
    expect(
      inbox.needsAttention.items.find(
        (item) => item.key === "listings_with_gaps",
      )?.count,
    ).toBe(0);
    expect(
      inbox.needsAttention.items.find(
        (item) => item.key === "listings_awaiting_review",
      )?.count,
    ).toBe(0);
    expect(inbox.jobs.items).toEqual([]);
    expect(inbox.jobs.truncated).toBe(false);
    expect(inbox.outputs.items).toEqual([]);
    expect(inbox.conversations.items).toEqual([]);
  });

  it("surfaces only non-success jobs, bounded and truncated honestly", () => {
    const inbox = buildStudioInbox(FULL_INPUT);
    expect(inbox.jobs.deepLink).toBe("/jobs");
    expect(inbox.jobs.unavailable).toBe(false);
    expect(inbox.jobs.items).toHaveLength(STUDIO_INBOX_LIMITS.jobs);
    expect(inbox.jobs.truncated).toBe(true);
    expect(inbox.jobs.items.map((item) => item.jobId)).toEqual([
      "job-failed-1",
      "job-started",
      "job-failed-2",
      "job-failed-3",
      "job-failed-4",
    ]);
    expect(inbox.jobs.items[0]).toEqual({
      jobId: "job-failed-1",
      state: "failed",
      errorCode: "provider_error",
      createdAt: job("x", "failed", 1).createdAt.toISOString(),
      deepLink: "/jobs",
    });
  });

  it("lists drafts before saved artifacts, excludes other statuses, and bounds", () => {
    const inbox = buildStudioInbox(FULL_INPUT);
    expect(inbox.outputs.deepLink).toBe("/studio/outputs");
    expect(inbox.outputs.items.map((item) => item.outputId)).toEqual([
      "out-draft-1",
      "out-draft-2",
      "out-saved-1",
    ]);
    expect(inbox.outputs.items.map((item) => item.status)).toEqual([
      "draft",
      "draft",
      "saved",
    ]);
    expect(inbox.outputs.truncated).toBe(false);
    expect(
      inbox.outputs.items.some((item) => item.outputId === "out-signed"),
    ).toBe(false);
    expect(
      inbox.outputs.items.some((item) => item.outputId === "out-discarded"),
    ).toBe(false);

    const many = buildStudioInbox({
      ...FULL_INPUT,
      outputs: Array.from({ length: STUDIO_INBOX_LIMITS.outputs + 2 }, (_, i) =>
        output(`bulk-${i}`, "draft"),
      ),
    });
    expect(many.outputs.items).toHaveLength(STUDIO_INBOX_LIMITS.outputs);
    expect(many.outputs.truncated).toBe(true);
  });

  it("bounds recent conversations and links each one to its thread", () => {
    const inbox = buildStudioInbox(FULL_INPUT);
    expect(inbox.conversations.deepLink).toBe("/studio/threads");
    expect(inbox.conversations.items).toHaveLength(
      STUDIO_INBOX_LIMITS.conversations,
    );
    expect(inbox.conversations.truncated).toBe(true);
    expect(inbox.conversations.items[0]).toEqual({
      threadId: "thread-1",
      title: "Conversation thread-1",
      updatedAt: thread("thread-1", 1).updatedAt.toISOString(),
      deepLink: "/studio/t/thread-1",
    });
  });

  it("marks unreadable sources unavailable and never fabricates a zero", () => {
    const inbox = buildStudioInbox({
      now: NOW,
      listingCounts: null,
      quality: null,
      jobs: null,
      outputs: null,
      threads: null,
    });
    expect(inbox.needsAttention.unavailable).toBe(true);
    expect(
      inbox.needsAttention.items.every((item) => item.count === null),
    ).toBe(true);
    expect(inbox.jobs).toEqual({
      items: [],
      truncated: false,
      unavailable: true,
      deepLink: "/jobs",
    });
    expect(inbox.outputs.unavailable).toBe(true);
    expect(inbox.conversations.unavailable).toBe(true);
  });

  it("keeps available sections while another source is missing", () => {
    const inbox = buildStudioInbox({
      ...FULL_INPUT,
      quality: null,
    });
    expect(inbox.needsAttention.unavailable).toBe(false);
    expect(
      inbox.needsAttention.items
        .filter((item) => item.key !== "listings_awaiting_review")
        .every((item) => item.count === null),
    ).toBe(true);
    expect(
      inbox.needsAttention.items.find(
        (item) => item.key === "listings_awaiting_review",
      )?.count,
    ).toBe(3);
    expect(inbox.jobs.unavailable).toBe(false);
    expect(inbox.outputs.unavailable).toBe(false);
    expect(inbox.conversations.unavailable).toBe(false);
  });
});
