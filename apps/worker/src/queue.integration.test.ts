import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createListingQueue, enqueueListingPipeline } from "./queue.js";

const redisUrl = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6389";

describe("listing queue Redis integration", () => {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = createListingQueue(connection);

  beforeAll(async () => {
    await queue.pause();
    await queue.obliterate({ force: true });
    await queue.resume();
  });

  afterAll(async () => {
    await queue.close();
    await connection.quit();
  });

  it("returns the existing job when the same listing revision is enqueued twice", async () => {
    const input = { workspaceId: "ws_opak", draftId: "draft_redis", activeVersionSequence: 7 };

    const first = await enqueueListingPipeline(input, { queue });
    const second = await enqueueListingPipeline(input, { queue });

    expect(second.id).toBe(first.id);
    expect(await queue.getJobCountByTypes("waiting", "delayed", "paused", "prioritized")).toBe(1);
    const persisted = await queue.getJob(first.id!);
    expect(persisted?.data).toEqual(input);
  });
});
