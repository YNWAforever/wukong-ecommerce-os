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
    BUILD_SHA: "abc1234",
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
  it.each([LISTING_INGRESS_PATH, SHOPLINE_INGRESS_PATH])(
    "rejects a body tampered after signing on %s",
    async (path) => {
      const bindings = env();
      const payload = path === LISTING_INGRESS_PATH ? listing : shopline;
      const signature = await signQueueRequest({
        secret,
        timestamp: nowSeconds,
        path,
        body: JSON.stringify(payload),
      });
      const response = await handleIngress(
        await signedRequest(
          path,
          { ...payload, workspaceId: "ws_foreign" },
          { signature },
        ),
        bindings,
        undefined,
        { nowSeconds: () => nowSeconds },
      );
      expect(response.status).toBe(401);
      expect(bindings.LISTING_QUEUE.send).not.toHaveBeenCalled();
      expect(bindings.SHOPLINE_QUEUE.send).not.toHaveBeenCalled();
    },
  );

  it("rejects a valid SHOPLINE body signed for the listing path", async () => {
    const bindings = env();
    const signature = await signQueueRequest({
      secret,
      timestamp: nowSeconds,
      path: LISTING_INGRESS_PATH,
      body: JSON.stringify(shopline),
    });
    const response = await handleIngress(
      await signedRequest(SHOPLINE_INGRESS_PATH, shopline, { signature }),
      bindings,
      undefined,
      { nowSeconds: () => nowSeconds },
    );
    expect(response.status).toBe(401);
    expect(bindings.SHOPLINE_QUEUE.send).not.toHaveBeenCalled();
    expect(bindings.LISTING_QUEUE.send).not.toHaveBeenCalled();
  });

  it.each([
    [4096, 202],
    [4097, 413],
  ])(
    "enforces the byte limit for %i streamed UTF-8 bytes (HTTP %i)",
    async (byteLength, status) => {
      const bindings = env();
      const payload = { ...listing, workspaceId: "ws_酒" };
      const json = JSON.stringify(payload);
      const body =
        json +
        " ".repeat(byteLength - new TextEncoder().encode(json).byteLength);
      const bytes = new TextEncoder().encode(body);
      expect(bytes.byteLength).toBe(byteLength);
      // Split the three-byte character across three chunks: each chunk alone
      // would be invalid UTF-8, while the concatenated signed body is valid.
      const split = bytes.indexOf(0xe9) + 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, split));
          controller.enqueue(bytes.slice(split, split + 1));
          controller.enqueue(bytes.slice(split + 1));
          controller.close();
        },
      });
      const signed = await signedRequest(LISTING_INGRESS_PATH, payload, {
        body,
      });
      signed.headers.set("content-length", "1");
      const request = new Request(signed, {
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const response = await handleIngress(request, bindings, undefined, {
        nowSeconds: () => nowSeconds,
      });
      expect(response.status).toBe(status);
      if (status === 202) {
        expect(bindings.LISTING_QUEUE.send).toHaveBeenCalledExactlyOnceWith(
          payload,
        );
      } else {
        expect(bindings.LISTING_QUEUE.send).not.toHaveBeenCalled();
      }
      expect(bindings.SHOPLINE_QUEUE.send).not.toHaveBeenCalled();
    },
  );

  it("counts streamed UTF-8 bytes and cancels an oversized body with no declared length", async () => {
    const bindings = env();
    const cancel = vi.fn();
    // 2,049 characters, but 4,098 bytes; the stream deliberately never closes.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("é".repeat(1024)));
        controller.enqueue(new TextEncoder().encode("é".repeat(1025)));
      },
      cancel,
    });
    const request = new Request(`https://worker.test${LISTING_INGRESS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.has("content-length")).toBe(false);
    const response = await handleIngress(request, bindings);
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(bindings.LISTING_QUEUE.send).not.toHaveBeenCalled();
    expect(bindings.SHOPLINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8 before signature verification or enqueue", async () => {
    const bindings = env();
    const request = new Request(`https://worker.test${LISTING_INGRESS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0xc3, 0x28]),
    });
    const response = await handleIngress(request, bindings);
    expect(response.status).toBe(400);
    expect(bindings.LISTING_QUEUE.send).not.toHaveBeenCalled();
    expect(bindings.SHOPLINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it("rejects correctly signed malformed JSON before enqueue", async () => {
    const bindings = env();
    const response = await handleIngress(
      await signedRequest(LISTING_INGRESS_PATH, listing, { body: "{" }),
      bindings,
      undefined,
      { nowSeconds: () => nowSeconds },
    );
    expect(response.status).toBe(400);
    expect(bindings.LISTING_QUEUE.send).not.toHaveBeenCalled();
    expect(bindings.SHOPLINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it.each([
    [LISTING_INGRESS_PATH, listing, "LISTING_QUEUE"],
    [SHOPLINE_INGRESS_PATH, shopline, "SHOPLINE_QUEUE"],
  ] as const)(
    "returns unavailable when %s has no queue binding",
    async (path, payload, binding) => {
      const bindings = env();
      const sendListing = bindings.LISTING_QUEUE.send;
      const sendShopline = bindings.SHOPLINE_QUEUE.send;
      delete (bindings as Partial<WorkerEnv>)[binding];
      const response = await handleIngress(
        await signedRequest(path, payload),
        bindings,
        undefined,
        { nowSeconds: () => nowSeconds },
      );
      expect(response.status).toBe(503);
      expect(sendListing).not.toHaveBeenCalled();
      expect(sendShopline).not.toHaveBeenCalled();
    },
  );

  it.each([
    [LISTING_INGRESS_PATH, listing, "LISTING_QUEUE"],
    [SHOPLINE_INGRESS_PATH, shopline, "SHOPLINE_QUEUE"],
  ] as const)(
    "waits for queue acceptance before acknowledging %s",
    async (path, payload, binding) => {
      const bindings = env();
      const acceptance = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const send = vi.fn(() => {
        started.resolve();
        return acceptance.promise;
      });
      bindings[binding] = { send } as never;
      let settled = false;
      const response = handleIngress(
        await signedRequest(path, payload),
        bindings,
        undefined,
        { nowSeconds: () => nowSeconds },
      ).then((result) => {
        settled = true;
        return result;
      });
      try {
        await started.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(send).toHaveBeenCalledExactlyOnceWith(payload);
        const other =
          binding === "LISTING_QUEUE" ? "SHOPLINE_QUEUE" : "LISTING_QUEUE";
        expect(bindings[other].send).not.toHaveBeenCalled();
      } finally {
        acceptance.resolve();
      }
      expect((await response).status).toBe(202);
    },
  );

  it.each([
    [LISTING_INGRESS_PATH, listing, "LISTING_QUEUE"],
    [SHOPLINE_INGRESS_PATH, shopline, "SHOPLINE_QUEUE"],
  ] as const)(
    "does not acknowledge %s when queue acceptance fails",
    async (path, payload, binding) => {
      const bindings = env();
      const failure = new Error("queue unavailable");
      const send = vi.fn(async () => {
        throw failure;
      });
      bindings[binding] = { send } as never;
      await expect(
        handleIngress(await signedRequest(path, payload), bindings, undefined, {
          nowSeconds: () => nowSeconds,
        }),
      ).rejects.toBe(failure);
      expect(send).toHaveBeenCalledExactlyOnceWith(payload);
      const other =
        binding === "LISTING_QUEUE" ? "SHOPLINE_QUEUE" : "LISTING_QUEUE";
      expect(bindings[other].send).not.toHaveBeenCalled();
    },
  );

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
      aiProvider: "openai",
      productShotProvider: "disabled",
      wineEnrichmentEnabled: false,
      buildSha: "abc1234",
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

  it("limits unauthenticated GET /health to safe metadata", async () => {
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
      "aiProvider",
      "bindings",
      "buildSha",
      "productShotProvider",
      "wineEnrichmentEnabled",
    ]);
  });
});

it("accepts the strict website variant on the existing listing queue", async () => {
  const bindings = env();
  bindings.WEBSITE_FETCH_BASE_URL = "https://app.example";
  const payload = {
    kind: "website_scan",
    workspaceId: "ws",
    scanId: listing.draftId,
    revision: 0,
  };
  const response = await handleIngress(
    await signedRequest("/ingress/website-scans", payload),
    bindings,
    undefined,
    { nowSeconds: () => nowSeconds },
  );
  expect(response.status).toBe(202);
  expect(bindings.LISTING_QUEUE.send).toHaveBeenCalledWith(payload);
  expect(bindings.SHOPLINE_QUEUE.send).not.toHaveBeenCalled();
});
it("refuses website ingress when its callback is not configured", async () => {
  const response = await handleIngress(
    await signedRequest("/ingress/website-scans", {
      kind: "website_scan",
      workspaceId: "ws",
      scanId: listing.draftId,
      revision: 0,
    }),
    env(),
    undefined,
    { nowSeconds: () => nowSeconds },
  );
  expect(response.status).toBe(503);
});

const shot = {
  kind: "product_shot",
  workspaceId: "ws_opak",
  draftId: listing.draftId,
  attemptId: shopline.versionId,
};
it("accepts signed strict product shots on the existing listing binding and denies malformed or unsigned ingress", async () => {
  const bindings = env();
  for (const [payload, signature, status] of [
    [shot, undefined, 202],
    [{ ...shot, storageKey: "injected" }, undefined, 400],
    [shot, "unsigned", 401],
  ] as const) {
    const res = await handleIngress(
      await signedRequest("/ingress/product-shots", payload, { signature }),
      bindings,
      undefined,
      { nowSeconds: () => nowSeconds },
    );
    expect(res.status).toBe(status);
  }
  expect(bindings.LISTING_QUEUE.send).toHaveBeenCalledExactlyOnceWith(shot);
});

it("accepts an authenticated generation-first wine envelope with admission flags off", async () => {
  const bindings = env();
  const job = {
    ...listing,
    schemaVersion: 2,
    flowVersion: "wine-enrichment-v1",
    runId: "10000000-0000-4000-8000-000000000002",
    inputRevision: 1,
    stage: "generation",
  };
  const result = await handleIngress(
    await signedRequest(LISTING_INGRESS_PATH, job),
    bindings,
    undefined,
    { nowSeconds: () => nowSeconds },
  );
  expect(result.status).toBe(202);
  expect(bindings.LISTING_QUEUE.send).toHaveBeenCalledWith(job);
});
