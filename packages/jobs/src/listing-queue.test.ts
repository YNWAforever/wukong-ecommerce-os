import { describe, expect, it } from "vitest";

import {
  LISTING_QUEUE,
  bullmqListingJobId,
  enqueueListingPipeline,
  listingJobSchema,
  listingPipelineJobId,
  type ListingQueuePort,
} from "./listing-queue.js";

describe("listing queue payload", () => {
  it.each([
    {},
    { workspaceId: "", draftId: "draft_1", activeVersionSequence: 0 },
    { workspaceId: "ws_opak", draftId: "", activeVersionSequence: 0 },
    { workspaceId: "ws_opak", draftId: "draft_1", activeVersionSequence: -1 },
  ])("rejects malformed queue identity %#", (input) => {
    expect(() => listingJobSchema.parse(input)).toThrow();
  });

  it.each([
    { workspaceId: "ws:a", draftId: "draft_1", activeVersionSequence: 0 },
    { workspaceId: "ws_opak", draftId: "draft:1", activeVersionSequence: 0 },
  ])("rejects colon-bearing queue identity %#", (input) => {
    expect(() => listingJobSchema.parse(input)).toThrow(/must not contain ':'/);
  });
});

describe("enqueueListingPipeline", () => {
  it("enqueues only revision identity with bounded exponential retries", async () => {
    const calls: unknown[] = [];
    const queue: ListingQueuePort = {
      async add(name, data, options) {
        calls.push({ name, data, options });
        return { id: options.jobId! };
      },
    };

    const input = {
      workspaceId: "ws_opak",
      draftId: "draft_1",
      activeVersionSequence: 4,
    };
    const job = await enqueueListingPipeline(input, { queue });

    expect(job.id).toBe(bullmqListingJobId(input));
    expect(calls).toEqual([
      {
        name: LISTING_QUEUE,
        data: input,
        options: {
          jobId: bullmqListingJobId(input),
          attempts: 3,
          backoff: { type: "exponential", delay: 2_000 },
        },
      },
    ]);
    expect(Object.keys((calls[0] as { data: object }).data).sort()).toEqual([
      "activeVersionSequence",
      "draftId",
      "workspaceId",
    ]);
  });
});

describe("BullMQ job ID transport mapping", () => {
  it("preserves the exact canonical idempotency key while mapping it collision-free to BullMQ", () => {
    const first = {
      workspaceId: "ws_opak",
      draftId: "draft_1",
      activeVersionSequence: 4,
    };
    const second = {
      workspaceId: "ws_opak",
      draftId: "draft_2",
      activeVersionSequence: 4,
    };
    const canonical = listingPipelineJobId(first);
    const encoded = bullmqListingJobId(first);

    expect(canonical).toBe("listing:ws_opak:draft_1:4");
    expect(encoded).not.toContain(":");
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(canonical);
    expect(bullmqListingJobId(second)).not.toBe(encoded);
    expect(bullmqListingJobId(first)).toBe(encoded);
  });
});
