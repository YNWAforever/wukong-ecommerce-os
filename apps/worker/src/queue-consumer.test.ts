import { describe, it, expect, vi } from "vitest";
import { handleQueue } from "./queue-consumer.js";
describe("listing queue website routing", () => {
  it("preserves legacy listing payload and never sends discriminated website payloads to AI", async () => {
    const legacy = {
      workspaceId: "ws",
      draftId: "10000000-0000-4000-8000-000000000001",
      activeVersionSequence: 0,
    };
    const website = {
      kind: "website_scan",
      workspaceId: "ws",
      scanId: legacy.draftId,
      revision: 0,
    };
    const messages = [
      legacy,
      website,
      { ...website, url: "https://injected.example" },
    ].map((body) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() }));
    const listing = vi.fn(async (_payload: unknown) => "ack" as const),
      web = vi.fn(async () => "ack" as const);
    await handleQueue(
      { queue: "wukong-listing-preview", messages } as any,
      {} as any,
      undefined,
      { consumeListingMessage: listing, consumeWebsiteMessage: web },
    );
    expect(listing).toHaveBeenCalledTimes(1);
    expect(listing.mock.calls[0]?.[0]).toEqual(legacy);
    expect(web).toHaveBeenCalledTimes(2);
    expect(messages.every((m) => m.ack.mock.calls.length === 1)).toBe(true);
  });
});
