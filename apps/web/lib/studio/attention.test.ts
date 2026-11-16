import { describe, expect, it } from "vitest";

import {
  buildStudioAttentionQueue,
  displayArtifactTitle,
  type StudioAttentionEntry,
} from "./attention";
import type { StudioInboxResult } from "./contracts";

const AS_OF = "2026-11-17T00:00:00.000Z";

function output(
  overrides: Partial<StudioInboxResult["outputs"]["items"][number]>,
): StudioInboxResult["outputs"]["items"][number] {
  return {
    outputId: "output-1",
    kind: "copy_proposal",
    title: "Draft copy",
    status: "draft",
    updatedAt: AS_OF,
    pin: { revision: 1, digest: "a".repeat(64) },
    confirmation: "not_applicable",
    deepLink: "/studio/outputs/output-1?revision=1&digest=" + "a".repeat(64),
    ...overrides,
  };
}

function job(
  overrides: Partial<StudioInboxResult["jobs"]["items"][number]>,
): StudioInboxResult["jobs"]["items"][number] {
  return {
    jobId: "job-1",
    state: "failed",
    errorCode: "E_TEST",
    createdAt: AS_OF,
    deepLink: "/jobs",
    ...overrides,
  };
}

function inbox(overrides: {
  counts?: Partial<
    Record<
      StudioInboxResult["needsAttention"]["items"][number]["key"],
      number | null
    >
  >;
  jobs?: StudioInboxResult["jobs"]["items"];
  outputs?: StudioInboxResult["outputs"]["items"];
  conversations?: StudioInboxResult["conversations"]["items"];
  unavailable?: Partial<
    Record<"needsAttention" | "jobs" | "outputs" | "conversations", boolean>
  >;
  truncated?: Partial<Record<"jobs" | "outputs" | "conversations", boolean>>;
}): StudioInboxResult {
  const counts = {
    listings_awaiting_review: 4,
    listings_with_gaps: 2,
    listings_without_active_version: 1,
    unassessable_active_version: 0,
    ...overrides.counts,
  };
  return {
    asOf: AS_OF,
    needsAttention: {
      items: [
        {
          key: "listings_with_gaps",
          count: counts.listings_with_gaps,
          deepLink: "/quality",
        },
        {
          key: "listings_without_active_version",
          count: counts.listings_without_active_version,
          deepLink: "/quality",
        },
        {
          key: "unassessable_active_version",
          count: counts.unassessable_active_version,
          deepLink: "/quality",
        },
        {
          key: "listings_awaiting_review",
          count: counts.listings_awaiting_review,
          deepLink: "/dashboard",
        },
      ],
      unavailable: overrides.unavailable?.needsAttention ?? false,
      deepLink: "/quality",
    },
    jobs: {
      items: overrides.jobs ?? [],
      truncated: overrides.truncated?.jobs ?? false,
      unavailable: overrides.unavailable?.jobs ?? false,
      deepLink: "/jobs",
    },
    outputs: {
      items: overrides.outputs ?? [],
      truncated: overrides.truncated?.outputs ?? false,
      unavailable: overrides.unavailable?.outputs ?? false,
      deepLink: "/studio/outputs",
    },
    conversations: {
      items: overrides.conversations ?? [],
      truncated: overrides.truncated?.conversations ?? false,
      unavailable: overrides.unavailable?.conversations ?? false,
      deepLink: "/studio/threads",
    },
  };
}

function kinds(items: readonly StudioAttentionEntry[]): string[] {
  return items.map((item) => item.kind);
}

describe("displayArtifactTitle", () => {
  it("drops the generated ISO suffix but keeps real titles", () => {
    expect(displayArtifactTitle("Gap review · 2026-11-15T19:43:48.755Z")).toBe(
      "Gap review",
    );
    expect(displayArtifactTitle("供應商備註")).toBe("供應商備註");
    expect(displayArtifactTitle(" · 2026-11-15T19:43:48.755Z")).toBe(
      " · 2026-11-15T19:43:48.755Z",
    );
  });
});

describe("buildStudioAttentionQueue", () => {
  it("orders a mixed inbox from review work down to recent conversations", () => {
    const result = buildStudioAttentionQueue(
      inbox({
        counts: { unassessable_active_version: 3 },
        jobs: [job({})],
        outputs: [
          output({}),
          output({
            outputId: "output-2",
            status: "saved",
            confirmation: "unconfirmed",
            title: "Saved copy",
          }),
        ],
        conversations: [
          {
            threadId: "thread-1",
            title: "Opak follow-up",
            updatedAt: AS_OF,
            deepLink: "/studio/t/thread-1",
          },
        ],
      }),
    );

    expect(kinds(result.items)).toEqual([
      "review",
      "gaps",
      "noActiveVersion",
      "unassessableVersion",
      "job",
      "draftOutput",
      "signoffOutput",
      "conversation",
    ]);
    expect(result.total).toBe(8);
    expect(result.unavailable).toBe(false);
    expect(result.incomplete).toBe(false);
  });

  it("gives every row one owner, one action link and one action label", () => {
    const result = buildStudioAttentionQueue(
      inbox({
        jobs: [job({ jobId: "job-9" })],
        outputs: [
          output({ outputId: "draft-1" }),
          output({
            outputId: "saved-1",
            status: "saved",
            confirmation: "unconfirmed",
          }),
        ],
        conversations: [
          {
            threadId: "thread-1",
            title: "Opak follow-up",
            updatedAt: AS_OF,
            deepLink: "/studio/t/thread-1",
          },
        ],
      }),
    );

    expect(result.items.map((item) => item.owner)).toEqual([
      "operator",
      "operator",
      "operator",
      "operator",
      "operator",
      "reviewer",
      "operator",
    ]);
    expect(result.items.every((item) => item.href.startsWith("/"))).toBe(true);
    expect(result.items.every((item) => item.actionKey)).toBe(true);
    expect(result.items.find((item) => item.kind === "job")?.line.key).toBe(
      "studio.today.job.failed",
    );
    expect(result.items.find((item) => item.kind === "job")?.href).toBe(
      "/jobs",
    );
  });

  it("drops zero counts and never treats a null count as zero", () => {
    const result = buildStudioAttentionQueue(
      inbox({
        counts: {
          listings_awaiting_review: 0,
          listings_with_gaps: null,
          listings_without_active_version: 1,
          unassessable_active_version: 0,
        },
      }),
    );

    expect(kinds(result.items)).toEqual(["noActiveVersion"]);
    expect(result.incomplete).toBe(true);
  });

  it("marks the queue incomplete when a count is missing, and truncated separately", () => {
    const failedSource = buildStudioAttentionQueue(
      inbox({
        counts: {
          listings_awaiting_review: 4,
          listings_with_gaps: null,
          listings_without_active_version: 1,
          unassessable_active_version: 2,
        },
      }),
    );
    expect(failedSource.total).toBe(3);
    expect(failedSource.incomplete).toBe(true);
    expect(failedSource.truncated).toBe(false);

    const truncated = buildStudioAttentionQueue(
      inbox({ truncated: { outputs: true } }),
    );
    expect(truncated.incomplete).toBe(false);
    expect(truncated.truncated).toBe(true);
  });

  it("reports a wholly unavailable inbox instead of an empty queue", () => {
    const result = buildStudioAttentionQueue(
      inbox({
        counts: {
          listings_awaiting_review: null,
          listings_with_gaps: null,
          listings_without_active_version: null,
          unassessable_active_version: null,
        },
        unavailable: {
          needsAttention: true,
          jobs: true,
          outputs: true,
          conversations: true,
        },
      }),
    );

    expect(result.items).toEqual([]);
    expect(result.unavailable).toBe(true);
    expect(result.incomplete).toBe(false);
  });

  it("skips confirmed saved work and maps every known job state", () => {
    const result = buildStudioAttentionQueue(
      inbox({
        counts: {
          listings_awaiting_review: 0,
          listings_with_gaps: 0,
          listings_without_active_version: 0,
        },
        jobs: [
          job({ jobId: "j1", state: "failed" }),
          job({ jobId: "j2", state: "running" }),
          job({ jobId: "j3", state: "queued" }),
          job({ jobId: "j4", state: "cancelled" }),
          job({ jobId: "j5", state: "mystery" }),
        ],
        outputs: [
          output({
            outputId: "saved-ok",
            status: "saved",
            confirmation: "confirmed",
          }),
        ],
      }),
    );

    expect(result.items.map((item) => item.line.key)).toEqual([
      "studio.today.job.failed",
      "studio.today.job.running",
      "studio.today.job.queued",
      "studio.today.job.cancelled",
      "studio.today.job.other",
    ]);
  });

  it("falls back to the saved-work list when an exact-version link is unavailable", () => {
    const result = buildStudioAttentionQueue(
      inbox({
        counts: {
          listings_awaiting_review: 0,
          listings_with_gaps: 0,
          listings_without_active_version: 0,
        },
        outputs: [
          output({
            outputId: "draft-2",
            deepLink: null,
            pin: null,
          }),
        ],
      }),
    );

    expect(result.items[0]).toMatchObject({
      kind: "draftOutput",
      href: "/studio/outputs",
      actionKey: "studio.today.action.outputs",
    });
  });
});
