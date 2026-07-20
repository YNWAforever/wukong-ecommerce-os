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

import { consumeListingMessage } from "./listing-consumer.js";
import { handleQueue } from "./queue-consumer.js";

const valid = { workspaceId, draftId, activeVersionSequence: 0 };

function runtimeHarness(error?: Error) {
  const { deps, state } = makeHarness({ extractError: error });
  const close = vi.fn(async () => undefined);
  runtimeMocks.createCloudflareRuntime.mockReturnValue({
    dependencies: deps,
    close,
  });
  return { state, close };
}

function queueMessage() {
  return {
    body: valid,
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
