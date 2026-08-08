import {
  LISTING_INGRESS_PATH,
  SHOPLINE_INGRESS_PATH,
  signQueueRequest,
} from "@wukong/jobs";
import { describe, expect, it, vi } from "vitest";

import {
  createCloudflareIngressClient,
  type CloudflareIngressClient,
  QueueIngressError,
} from "./cloudflare-queue-runtime.js";

const payload = {
  workspaceId: "ws_opak",
  draftId: "00000000-0000-4000-8000-000000000001",
  activeVersionSequence: 0,
};

describe("Cloudflare queue ingress runtime", () => {
  it("types each ingress path to its strict queue payload", () => {
    const ingress = null as unknown as CloudflareIngressClient;

    if (false) {
      // @ts-expect-error The SHOPLINE ingress message never carries the persisted digest.
      void ingress.enqueue(SHOPLINE_INGRESS_PATH, {
        workspaceId: "ws_opak",
        draftId: "00000000-0000-4000-8000-000000000001",
        versionId: "00000000-0000-4000-8000-000000000002",
        connectionId: "00000000-0000-4000-8000-000000000003",
        payloadDigest: "must-not-cross-ingress",
      });
    }
  });

  it("posts exact JSON with timestamp and HMAC without logging the secret", async () => {
    const secret = "s".repeat(32);
    const fetch = vi.fn(
      async (_request: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 202 }),
    );
    const client = createCloudflareIngressClient({
      env: {
        QUEUE_INGRESS_URL: "https://queue.example",
        QUEUE_INGRESS_SECRET: secret,
      },
      now: () => 1_784_455_200_000,
      fetch,
    });

    await client.enqueue(LISTING_INGRESS_PATH, payload);

    const [request, init] = fetch.mock.calls[0]!;
    const body = JSON.stringify(payload);
    expect(String(request)).toBe("https://queue.example/ingress/listings");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wukong-timestamp": "1784455200",
        "x-wukong-signature": await signQueueRequest({
          secret,
          timestamp: 1_784_455_200,
          path: LISTING_INGRESS_PATH,
          body,
        }),
      },
      body,
    });
    expect(JSON.stringify(init)).not.toContain(secret);
  });

  it("posts the strict ID-only SHOPLINE publish payload", async () => {
    const fetch = vi.fn(
      async (_request: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 202 }),
    );
    const client = createCloudflareIngressClient({
      env: {
        QUEUE_INGRESS_URL: "https://queue.example",
        QUEUE_INGRESS_SECRET: "s".repeat(32),
      },
      fetch,
    });
    const shoplinePayload = {
      workspaceId: "ws_opak",
      draftId: "00000000-0000-4000-8000-000000000001",
      versionId: "00000000-0000-4000-8000-000000000002",
      connectionId: "00000000-0000-4000-8000-000000000003",
    };

    await client.enqueue(SHOPLINE_INGRESS_PATH, shoplinePayload);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1]?.body).toBe(JSON.stringify(shoplinePayload));
    await expect(
      client.enqueue(SHOPLINE_INGRESS_PATH, {
        ...shoplinePayload,
        payloadDigest: "must-not-cross-ingress",
      } as never),
    ).rejects.toEqual(new QueueIngressError("invalid_payload"));
  });

  it("fails safely when ingress configuration is missing", async () => {
    await expect(
      createCloudflareIngressClient({ env: {} }).enqueue(
        LISTING_INGRESS_PATH,
        payload,
      ),
    ).rejects.toEqual(new QueueIngressError("not_configured"));
  });

  it("fails safely when ingress does not accept the request", async () => {
    const client = createCloudflareIngressClient({
      env: {
        QUEUE_INGRESS_URL: "https://queue.example",
        QUEUE_INGRESS_SECRET: "s".repeat(32),
      },
      fetch: vi.fn(
        async () => new Response("internal secret response", { status: 500 }),
      ),
    });

    await expect(client.enqueue(LISTING_INGRESS_PATH, payload)).rejects.toEqual(
      new QueueIngressError("rejected"),
    );
  });

  it("uses a five-second abort and fails safely on timeout", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);
    const client = createCloudflareIngressClient({
      env: {
        QUEUE_INGRESS_URL: "https://queue.example",
        QUEUE_INGRESS_SECRET: "s".repeat(32),
      },
      fetch: vi.fn(async () => {
        throw new DOMException("request timed out", "AbortError");
      }),
    });

    await expect(client.enqueue(LISTING_INGRESS_PATH, payload)).rejects.toEqual(
      new QueueIngressError("unreachable"),
    );
    expect(timeout).toHaveBeenCalledWith(5_000);
  });
});
