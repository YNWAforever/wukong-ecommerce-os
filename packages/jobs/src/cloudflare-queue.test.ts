import { describe, expect, it } from "vitest";

import {
  LISTING_INGRESS_PATH,
  SHOPLINE_INGRESS_PATH,
  listingJobSchema,
  shoplinePublishJobSchema,
  signQueueRequest,
  verifyQueueRequest,
} from "./cloudflare-queue.js";

const draftId = "b9df5d9e-8214-4d76-9a8d-38f802d03d11";
const versionId = "47ccbc52-cae7-4e1b-9c21-7d84cd7a4044";
const connectionId = "c5479df0-0557-4223-a4f4-49f55a7e1409";

describe("Cloudflare queue protocol", () => {
  it("accepts IDs only and rejects extra queue fields", () => {
    expect(
      listingJobSchema.parse({
        workspaceId: "ws_opak",
        draftId,
        activeVersionSequence: 0,
      }),
    ).toEqual({ workspaceId: "ws_opak", draftId, activeVersionSequence: 0 });
    expect(() =>
      shoplinePublishJobSchema.parse({
        workspaceId: "ws_opak",
        draftId,
        versionId,
        connectionId,
        token: "secret",
      }),
    ).toThrow();
  });

  it("signs exact path, timestamp, and bytes", async () => {
    const signature = await signQueueRequest({
      secret: "a".repeat(32),
      timestamp: 1_784_455_200,
      path: LISTING_INGRESS_PATH,
      body: '{"draftId":"x"}',
    });
    await expect(
      verifyQueueRequest({
        secret: "a".repeat(32),
        nowSeconds: 1_784_455_200,
        timestamp: "1784455200",
        signature,
        path: LISTING_INGRESS_PATH,
        body: '{"draftId":"x"}',
      }),
    ).resolves.toBe(true);
    await expect(
      verifyQueueRequest({
        secret: "a".repeat(32),
        nowSeconds: 1_784_455_200,
        timestamp: "1784455200",
        signature,
        path: SHOPLINE_INGRESS_PATH,
        body: '{"draftId":"x"}',
      }),
    ).resolves.toBe(false);
    await expect(
      verifyQueueRequest({
        secret: "a".repeat(32),
        nowSeconds: 1_784_455_200,
        timestamp: "1784455200",
        signature,
        path: LISTING_INGRESS_PATH,
        body: '{"draftId":"y"}',
      }),
    ).resolves.toBe(false);
    await expect(
      verifyQueueRequest({
        secret: "a".repeat(32),
        nowSeconds: 1_784_455_501,
        timestamp: "1784455200",
        signature,
        path: LISTING_INGRESS_PATH,
        body: '{"draftId":"x"}',
      }),
    ).resolves.toBe(false);
  });
});
