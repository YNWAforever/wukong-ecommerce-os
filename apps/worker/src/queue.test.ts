import { describe, expect, it } from "vitest";

import {
  LISTING_QUEUE,
  bullmqListingJobId,
  enqueueListingPipeline,
  type ListingQueuePort,
} from "./queue.js";

describe("enqueueListingPipeline", () => {
  it("enqueues only revision identity with bounded exponential retries", async () => {
    const calls: unknown[] = [];
    const queue: ListingQueuePort = {
      async add(name, data, options) {
        calls.push({ name, data, options });
        return { id: options.jobId! };
      },
    };

    const job = await enqueueListingPipeline(
      { workspaceId: "ws_opak", draftId: "draft_1", activeVersionSequence: 4 },
      { queue },
    );

    expect(job.id).toBe(bullmqListingJobId({ workspaceId: "ws_opak", draftId: "draft_1", activeVersionSequence: 4 }));
    expect(calls).toEqual([
      {
        name: LISTING_QUEUE,
        data: { workspaceId: "ws_opak", draftId: "draft_1", activeVersionSequence: 4 },
        options: {
          jobId: bullmqListingJobId({ workspaceId: "ws_opak", draftId: "draft_1", activeVersionSequence: 4 }),
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
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
