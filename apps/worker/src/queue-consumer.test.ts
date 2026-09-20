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
      {
        LISTING_PAID_OPERATIONS_ENABLED: "false",
        WINE_ENRICHMENT_ENABLED: "false",
      } as any,
      undefined,
      { consumeListingMessage: listing, consumeWebsiteMessage: web },
    );
    expect(listing).toHaveBeenCalledTimes(1);
    expect(listing.mock.calls[0]?.[0]).toEqual(legacy);
    expect(web).toHaveBeenCalledTimes(2);
    expect(messages.every((m) => m.ack.mock.calls.length === 1)).toBe(true);
  });
});

it("dispatches exact product_shot kind without website or listing AI routing", async () => {
  const body = {
    kind: "product_shot",
    workspaceId: "ws",
    draftId: "10000000-0000-4000-8000-000000000001",
    attemptId: "10000000-0000-4000-8000-000000000002",
  };
  const message = { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
  const shot = vi.fn(async () => ({ retryAfterSeconds: 121 })),
    listing = vi.fn(),
    website = vi.fn();
  await handleQueue(
    { queue: "wukong-listing-preview", messages: [message] } as any,
    {} as any,
    undefined,
    {
      consumeProductShotMessage: shot,
      consumeListingMessage: listing,
      consumeWebsiteMessage: website,
    },
  );
  // The delivery counter goes through too: product-shot messages ride the
  // listing queue, and the consumer has to know which delivery is the last one
  // so it can record a terminal state rather than dead-letter the attempt.
  expect(shot).toHaveBeenCalledWith(body, expect.anything(), {
    attempt: 1,
    maxAttempts: 4,
  });
  expect(listing).not.toHaveBeenCalled();
  expect(website).not.toHaveBeenCalled();
  expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 121 });
});

it("routes wine independently from legacy even when live admission is off", async () => {
  const body = {
    schemaVersion: 2,
    flowVersion: "wine-enrichment-v1",
    workspaceId: "ws",
    draftId: "10000000-0000-4000-8000-000000000001",
    runId: "10000000-0000-4000-8000-000000000002",
    inputRevision: 1,
    activeVersionSequence: 0,
    stage: "generation",
  };
  const message = { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
  const wine = vi.fn(async () => "ack" as const),
    legacy = vi.fn(async () => "ack" as const);
  await handleQueue(
    { queue: "wukong-listing-preview", messages: [message] } as never,
    {
      LISTING_PAID_OPERATIONS_ENABLED: "false",
      WINE_ENRICHMENT_ENABLED: "false",
    } as never,
    undefined,
    { consumeWineMessage: wine, consumeListingMessage: legacy },
  );
  expect(wine).toHaveBeenCalledWith(body, expect.anything());
  expect(legacy).not.toHaveBeenCalled();
  expect(message.ack).toHaveBeenCalledOnce();
});
