import { describe, expect, it, vi } from "vitest";

import { createListingPublisher } from "./listing-queue-runtime.js";

describe("listing queue runtime", () => {
  it("fails closed without REDIS_URL", async () => {
    await expect(
      createListingPublisher({ env: {} }).enqueue({
        workspaceId: "ws_opak",
        draftId: "draft_1",
        activeVersionSequence: 0,
      }),
    ).rejects.toThrow("REDIS_URL is required");
  });

  it("passes only listing identity to the injected queue", async () => {
    const add = vi.fn(async (_name, _data, options) => ({
      id: String(options.jobId),
    }));
    const publisher = createListingPublisher({
      env: {
        REDIS_URL: "rediss://default:secret@example.upstash.io:6379",
      },
      redisFactory: () => ({ quit: vi.fn() }) as never,
      queueFactory: () => ({ add }) as never,
    });

    const result = await publisher.enqueue({
      workspaceId: "ws_opak",
      draftId: "draft_1",
      activeVersionSequence: 0,
    });

    expect(result.id).toBeTruthy();
    expect(add.mock.calls[0]?.[1]).toEqual({
      workspaceId: "ws_opak",
      draftId: "draft_1",
      activeVersionSequence: 0,
    });
  });
});
