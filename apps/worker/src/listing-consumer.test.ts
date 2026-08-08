import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProviderApiError,
  ProviderOutputError,
  ProviderRefusalError,
} from "@wukong/ai";

import { draftId, makeHarness, workspaceId } from "./pipeline-test-support.js";

const runtimeMocks = vi.hoisted(() => ({ createCloudflareRuntime: vi.fn() }));
vi.mock("./cloudflare-runtime.js", () => ({
  createCloudflareRuntime: runtimeMocks.createCloudflareRuntime,
}));

import {
  consumeListingMessage,
  LISTING_MAX_ATTEMPTS,
} from "./listing-consumer.js";
import { handleQueue } from "./queue-consumer.js";

const valid = { workspaceId, draftId, activeVersionSequence: 0 };

function runtimeHarness(
  error?: Error,
  closeError?: Error,
  extraOptions: Parameters<typeof makeHarness>[0] = {},
) {
  const { deps, state } = makeHarness({ extractError: error, ...extraOptions });
  const close = vi.fn(async () => {
    if (closeError) throw closeError;
  });
  runtimeMocks.createCloudflareRuntime.mockReturnValue({
    dependencies: deps,
    close,
  });
  return { state, close };
}

function queueMessage(attempts = 1) {
  return {
    body: valid,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

beforeEach(() => {
  runtimeMocks.createCloudflareRuntime.mockReset();
});

describe("Cloudflare listing consumer", () => {
  it("parses before runtime/database access and acknowledges malformed payloads", async () => {
    await expect(
      consumeListingMessage({ ...valid, token: "secret" }, {} as never),
    ).resolves.toBe("ack");
    expect(runtimeMocks.createCloudflareRuntime).not.toHaveBeenCalled();
  });

  it("retries when runtime dependencies are temporarily unavailable", async () => {
    runtimeMocks.createCloudflareRuntime.mockImplementation(() => {
      throw new Error("temporary dependency failure secret-content-123");
    });

    await expect(consumeListingMessage(valid, {} as never)).resolves.toEqual({
      retryAfterSeconds: 30,
    });
  });

  it("runs the tenant-scoped listing pipeline and acknowledges success", async () => {
    const { close } = runtimeHarness();

    await expect(consumeListingMessage(valid, {} as never)).resolves.toBe(
      "ack",
    );

    expect(runtimeMocks.createCloudflareRuntime).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps a terminal acknowledgement when runtime cleanup fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { state } = runtimeHarness(
      new ProviderOutputError("AI evidence invalid secret-content-123"),
      new Error("cleanup failed secret-content-123"),
    );

    await expect(consumeListingMessage(valid, {} as never)).resolves.toBe("ack");
    expect(state.failure).toBe("provider_failure");
    expect(logged).not.toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-content-123");
    logged.mockRestore();
  });

  it("records terminal failure once a transient error exhausts the delivery budget", async () => {
    // A transient provider error is not terminal by class, so before the
    // attempt counter was wired through, this listing sat at `processing`
    // forever with no audit trail once the queue gave up on it.
    const { state } = runtimeHarness(new ProviderApiError("upstream 503"));

    await expect(
      consumeListingMessage(valid, {} as never, {
        attempt: LISTING_MAX_ATTEMPTS,
        maxAttempts: LISTING_MAX_ATTEMPTS,
      }),
    ).resolves.toEqual({ retryAfterSeconds: 30 });

    expect(state.status).toBe("failed");
    expect(state.failure).toBe("provider_failure");
    expect(state.audits).toContain("listing.pipeline_failed");
  });

  it("waits out a blocking lease instead of retrying into a guaranteed no-op", async () => {
    // The step lease outlives the whole 4-delivery budget at a flat 30s, so a
    // fixed delay spends every remaining delivery failing the same way and then
    // dead-letters a listing that was only ever busy.
    const busyLeaseExpiresAt = new Date(Date.now() + 240_000);
    runtimeHarness(undefined, undefined, {
      generationUnavailable: true,
      busyLeaseExpiresAt,
    });

    const outcome = await consumeListingMessage(valid, {} as never, {
      attempt: 1,
      maxAttempts: LISTING_MAX_ATTEMPTS,
    });

    expect(outcome).not.toBe("ack");
    const retryAfterSeconds = (outcome as { retryAfterSeconds: number })
      .retryAfterSeconds;
    expect(retryAfterSeconds).toBeGreaterThan(180);
    expect(retryAfterSeconds).toBeLessThanOrEqual(240);
  });

  it("falls back to the flat delay when the blocking lease expiry is unknown", async () => {
    runtimeHarness(undefined, undefined, { generationUnavailable: true });

    await expect(
      consumeListingMessage(valid, {} as never, {
        attempt: 1,
        maxAttempts: LISTING_MAX_ATTEMPTS,
      }),
    ).resolves.toEqual({ retryAfterSeconds: 30 });
  });

  it("leaves the listing retryable on an earlier delivery attempt", async () => {
    const { state } = runtimeHarness(new ProviderApiError("upstream 503"));

    await expect(
      consumeListingMessage(valid, {} as never, {
        attempt: 1,
        maxAttempts: LISTING_MAX_ATTEMPTS,
      }),
    ).resolves.toEqual({ retryAfterSeconds: 30 });

    expect(state.status).toBe("processing");
    expect(state.audits).not.toContain("listing.pipeline_failed");
  });

  it("keeps a transient retry outcome when runtime cleanup fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runtimeHarness(
      new ProviderApiError("AI provider unavailable secret-content-123"),
      new Error("cleanup failed secret-content-123"),
    );

    await expect(consumeListingMessage(valid, {} as never)).resolves.toEqual({
      retryAfterSeconds: 30,
    });
    expect(logged).not.toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-content-123");
    logged.mockRestore();
  });

  it("retries provider availability failures without persisting model content", async () => {
    const { state } = runtimeHarness(
      new ProviderApiError("AI provider request timed out secret-content-123"),
    );

    await expect(consumeListingMessage(valid, {} as never)).resolves.toEqual({
      retryAfterSeconds: 30,
    });
    expect(state.failure).toBeUndefined();
    expect(state.audits).not.toContain("secret-content-123");
  });

  it.each([
    new ProviderOutputError(
      "AI evidence did not support its value secret-content-123",
    ),
    new ProviderRefusalError(
      "AI provider refused the request secret-content-123",
    ),
  ])("persists a safe terminal failure and acknowledges %s", async (error) => {
    const { state } = runtimeHarness(error);

    await expect(consumeListingMessage(valid, {} as never)).resolves.toBe(
      "ack",
    );
    expect(state.failure).toBe("provider_failure");
    expect(state.audits).toContain("listing.pipeline_failed");
    expect(state.audits).not.toContain("secret-content-123");
  });
});

describe("Cloudflare queue acknowledgement", () => {
  it("acks listing success and retries transient outcomes with the configured delay", async () => {
    const success = queueMessage();
    const transient = queueMessage();
    const consume = vi
      .fn()
      .mockResolvedValueOnce("ack")
      .mockResolvedValueOnce({ retryAfterSeconds: 30 });

    await handleQueue(
      { queue: "wukong-listing-preview", messages: [success] } as never,
      {} as never,
      undefined,
      { consumeListingMessage: consume },
    );
    await handleQueue(
      { queue: "wukong-listing-production", messages: [transient] } as never,
      {} as never,
      undefined,
      { consumeListingMessage: consume },
    );

    expect(success.ack).toHaveBeenCalledOnce();
    expect(success.retry).not.toHaveBeenCalled();
    expect(transient.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(transient.ack).not.toHaveBeenCalled();
  });

  it("forwards the delivery attempt so the pipeline can escalate on the last one", async () => {
    const message = queueMessage(LISTING_MAX_ATTEMPTS);
    const consume = vi.fn().mockResolvedValue("ack");

    await handleQueue(
      { queue: "wukong-listing-production", messages: [message] } as never,
      {} as never,
      undefined,
      { consumeListingMessage: consume },
    );

    expect(consume).toHaveBeenCalledWith(message.body, expect.anything(), {
      attempt: LISTING_MAX_ATTEMPTS,
      maxAttempts: LISTING_MAX_ATTEMPTS,
    });
  });

  it("throws for an unknown queue before acknowledgement", async () => {
    const message = queueMessage();
    const consume = vi.fn();

    await expect(
      handleQueue(
        { queue: "wukong-unknown-preview", messages: [message] } as never,
        {} as never,
        undefined,
        { consumeListingMessage: consume },
      ),
    ).rejects.toThrow(/unknown queue/i);

    expect(consume).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
