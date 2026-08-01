import { describe, expect, it, vi } from "vitest";

import {
  LISTING_INGRESS_PATH,
  SHOPLINE_INGRESS_PATH,
  signQueueRequest,
} from "@wukong/jobs";

import { handleIngress } from "./ingress.js";
import type { WorkerEnv } from "./worker-env.js";

const nowSeconds = 1_784_556_000;
const secret = "q".repeat(32);
const listing = {
  workspaceId: "ws_opak",
  draftId: "b9df5d9e-8214-4d76-9a8d-38f802d03d11",
  activeVersionSequence: 2,
};
const shopline = {
  workspaceId: "ws_opak",
  draftId: "b9df5d9e-8214-4d76-9a8d-38f802d03d11",
  versionId: "47ccbc52-cae7-4e1b-9c21-7d84cd7a4044",
  connectionId: "c5479df0-0557-4223-a4f4-49f55a7e1409",
};

function env(): WorkerEnv {
  return {
    HYPERDRIVE: { connectionString: "opaque-connection-string" } as never,
    LISTING_QUEUE: { send: vi.fn(async () => undefined) } as never,
    SHOPLINE_QUEUE: { send: vi.fn(async () => undefined) } as never,
    QUEUE_INGRESS_SECRET: secret,
    BUILD_SHA: "abc123",
    SHOPLINE_ADAPTER: "disabled",
  };
}

async function signedRequest(
  path: string,
  payload: unknown,
  overrides: { body?: string; timestamp?: number; signature?: string } = {},
) {
  const body = overrides.body ?? JSON.stringify(payload);
  const timestamp = overrides.timestamp ?? nowSeconds;
  const signature =
    overrides.signature ??
    (await signQueueRequest({ secret, timestamp, path, body }));
  return new Request(`https://worker.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wukong-timestamp": String(timestamp),
      "x-wukong-signature": signature,
    },
    body,
  });
}

describe("Cloudflare Worker ingress", () => {
  it("verifies exact raw bytes and enqueues the strict listing payload", async () => {
    const bindings = env();
    const body = ` {"workspaceId":"ws_opak","draftId":"${listing.draftId}","activeVersionSequence":2}`;
    const response = await handleIngress(
      await signedRequest(LISTING_INGRESS_PATH, listing, { body }),
      bindings,
      undefined,
      { nowSeconds: () => nowSeconds },
    );

    expect(response.status).toBe(202);
    expect(bindings.LISTING_QUEUE.send).toHaveBeenCalledWith(listing);
    expect(bindings.SHOPLINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it("rejects a BOM-prefixed body signed only for the canonical bytes", async () => {
    const bindings = env();
    const canonicalBody = JSON.stringify(listing);
    const signature = await signQueueRequest({
      secret,
      timestamp: nowSeconds,
      path: LISTING_INGRESS_PATH,
      body: canonicalBody,
    });
    const canonicalBytes = new TextEncoder().encode(canonicalBody);
    const rawBody = new Uint8Array(3 + canonicalBytes.byteLength);
    rawBody.set([0xef, 0xbb, 0xbf]);
    rawBody.set(canonicalBytes, 3);
    const request = new Request(`https://worker.test${LISTING_INGRESS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wukong-timestamp": String(nowSeconds),
        "x-wukong-signature": signature,
      },
      body: rawBody,
    });

    const response = await handleIngress(request, bindings, undefined, {
      nowSeconds: () => nowSeconds,
    });

    expect(response.status).toBe(401);
    expect(bindings.LISTING_QUEUE.send).not.toHaveBeenCalled();
  });

  it("routes strict SHOPLINE payloads to the isolated queue", async () => {
    const bindings = env();
    const response = await handleIngress(
      await signedRequest(SHOPLINE_INGRESS_PATH, shopline),
      bindings,
      undefined,
      { nowSeconds: () => nowSeconds },
    );

    expect(response.status).toBe(202);
    expect(bindings.SHOPLINE_QUEUE.send).toHaveBeenCalledWith(shopline);
    expect(bindings.LISTING_QUEUE.send).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", { signature: "" }],
    ["tampered", { signature: "not-a-valid-signature" }],
    ["skewed", { timestamp: nowSeconds - 301 }],
  ])(
    "rejects %s authentication before enqueueing",
    async (_label, overrides) => {
      const bindings = env();
      const request = await signedRequest(
        LISTING_INGRESS_PATH,
        listing,
        overrides,
      );
      if ("signature" in overrides && overrides.signature === "")
        request.headers.delete("x-wukong-signature");
      const response = await handleIngress(request, bindings, undefined, {
        nowSeconds: () => nowSeconds,
      });

      expect(response.status).toBe(401);
      expect(bindings.LISTING_QUEUE.send).not.toHaveBeenCalled();
    },
  );

  it("returns 404 for unknown routes", async () => {
    const response = await handleIngress(
      new Request("https://worker.test/not-a-route"),
      env(),
    );
    expect(response.status).toBe(404);
  });

  it("rejects non-JSON media types before enqueueing", async () => {
    const bindings = env();
    const request = await signedRequest(LISTING_INGRESS_PATH, listing);
    request.headers.set("content-type", "application/json-patch+json");
    const response = await handleIngress(request, bindings, undefined, {
      nowSeconds: () => nowSeconds,
    });

    expect(response.status).toBe(415);
    expect(bindings.LISTING_QUEUE.send).not.toHaveBeenCalled();
  });

  it("rejects bodies over 4 KiB and extra schema fields before enqueueing", async () => {
    const bindings = env();
    const oversized = await handleIngress(
      await signedRequest(LISTING_INGRESS_PATH, listing, {
        body: JSON.stringify({ ...listing, padding: "x".repeat(4096) }),
      }),
      bindings,
      undefined,
      { nowSeconds: () => nowSeconds },
    );
    const extra = await handleIngress(
      await signedRequest(LISTING_INGRESS_PATH, { ...listing, token: "no" }),
      bindings,
      undefined,
      { nowSeconds: () => nowSeconds },
    );

    expect(oversized.status).toBe(413);
    expect(extra.status).toBe(400);
    expect(bindings.LISTING_QUEUE.send).not.toHaveBeenCalled();
  });

  it("exposes only safe health metadata and binding presence", async () => {
    const response = await handleIngress(
      new Request("https://worker.test/health"),
      env(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      buildSha: "abc123",
      adapterMode: "disabled",
      bindings: {
        hyperdrive: true,
        listingQueue: true,
        shoplineQueue: true,
        ingressSecret: true,
      },
    });
  });

  it("answers a signed POST /health with authenticated detail", async () => {
    const response = await handleIngress(
      await signedRequest("/health", {}),
      env(),
      undefined,
      { nowSeconds: () => nowSeconds },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authenticated: true,
      bindings: { ingressSecret: true },
    });
  });

  it("rejects an unsigned POST /health", async () => {
    const response = await handleIngress(
      new Request("https://worker.test/health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env(),
      undefined,
      { nowSeconds: () => nowSeconds },
    );

    expect(response.status).toBe(401);
  });

  it("rejects a POST /health signed with the wrong secret", async () => {
    const response = await handleIngress(
      await signedRequest("/health", {}, { signature: "not-a-signature" }),
      env(),
      undefined,
      { nowSeconds: () => nowSeconds },
    );

    expect(response.status).toBe(401);
  });

  it("rejects a replayed POST /health outside the timestamp window", async () => {
    const response = await handleIngress(
      await signedRequest("/health", {}, { timestamp: nowSeconds - 3_600 }),
      env(),
      undefined,
      { nowSeconds: () => nowSeconds },
    );

    expect(response.status).toBe(401);
  });

  it("keeps the unauthenticated GET /health body unchanged", async () => {
    const response = await handleIngress(
      new Request("https://worker.test/health", { method: "GET" }),
      env(),
      undefined,
      { nowSeconds: () => nowSeconds },
    );

    expect(response.status).toBe(200);
    // Pins the unauthenticated surface: it must never grow authenticated detail.
    expect(Object.keys(await response.json()).sort()).toEqual([
      "adapterMode",
      "bindings",
      "buildSha",
    ]);
  });
});
