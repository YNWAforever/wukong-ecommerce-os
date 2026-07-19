import { describe, expect, it, vi } from "vitest";

import {
  createListingPublisher,
  listingApplicationJobId,
} from "./listing-queue-runtime.js";

describe("listing queue runtime", () => {
  it("passes only listing identity to ingress and returns the deterministic application job ID", async () => {
    const enqueue = vi.fn(async () => ({ accepted: true as const }));
    const publisher = createListingPublisher({
      ingressClient: { enqueue },
    });
    const input = {
      workspaceId: "ws_opak",
      draftId: "00000000-0000-4000-8000-000000000001",
      activeVersionSequence: 7,
    };

    const result = await publisher.enqueue(input);

    expect(result).toEqual({ id: listingApplicationJobId(input) });
    expect(result.id).toBe(
      "listing:ws_opak:00000000-0000-4000-8000-000000000001:7",
    );
    expect(enqueue).toHaveBeenCalledWith("/ingress/listings", input);
  });

  it("exposes only a safe error when ingress rejects the request", async () => {
    const enqueue = vi.fn(async () => {
      throw new Error("ingress response body must not escape");
    });
    const publisher = createListingPublisher({ ingressClient: { enqueue } });

    await expect(
      publisher.enqueue({
        workspaceId: "ws_opak",
        draftId: "00000000-0000-4000-8000-000000000001",
        activeVersionSequence: 0,
      }),
    ).rejects.toThrow("queue_unavailable");
  });
});
