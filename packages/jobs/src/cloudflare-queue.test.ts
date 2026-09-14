import { describe, expect, it } from "vitest";

import {
  LISTING_INGRESS_PATH,
  SHOPLINE_INGRESS_PATH,
  listingJobSchema,
  listingRunKey,
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
    expect(
      shoplinePublishJobSchema.parse({
        workspaceId: "ws_opak",
        draftId,
        versionId,
        connectionId,
      }),
    ).toEqual({ workspaceId: "ws_opak", draftId, versionId, connectionId });
    expect(() =>
      shoplinePublishJobSchema.parse({
        workspaceId: "ws_opak",
        draftId,
        versionId,
        connectionId,
        payloadDigest: "must-stay-on-the-publish-job",
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

describe("queue signing vector", () => {
  // scripts/runtime-doctor.mjs duplicates this algorithm, because a diagnostic
  // must run when the workspace build is broken and so cannot import from here.
  // Both sides pin this same vector: change the message format below and this
  // test fails, which is the signal to update the copy in the doctor.
  it("pins the signature the runtime doctor also pins", async () => {
    await expect(
      signQueueRequest({
        secret: "q".repeat(32),
        timestamp: 1_784_556_000,
        path: "/health",
        body: "{}",
      }),
    ).resolves.toBe("6UdPcVDj1a7-vHLBVMYWhcENn3OQzYFUdJVk2GhFpkE");
  });
});

describe("listing run identity", () => {
  const base = { workspaceId: "ws_opak", draftId, activeVersionSequence: 0 };

  it("keeps the historical key for the first run", () => {
    // Every run already recorded was keyed this way. A new key format here
    // would orphan them and re-run work that is already done and paid for.
    expect(listingRunKey(base)).toBe(`listing:ws_opak:${draftId}:0`);
    expect(listingRunKey({ ...base, runAttempt: 0 })).toBe(
      `listing:ws_opak:${draftId}:0`,
    );
  });

  it("gives a deliberate re-run its own key", () => {
    expect(listingRunKey({ ...base, runAttempt: 1 })).toBe(
      `listing:ws_opak:${draftId}:0#1`,
    );
    expect(listingRunKey({ ...base, runAttempt: 2 })).not.toBe(
      listingRunKey({ ...base, runAttempt: 1 }),
    );
  });

  it("distinguishes a re-run from a later revision", () => {
    // Attempt 1 of revision 0 and revision 1 are different work; collapsing
    // them would let one read back the other's cached result.
    expect(listingRunKey({ ...base, runAttempt: 1 })).not.toBe(
      listingRunKey({ ...base, activeVersionSequence: 1 }),
    );
  });

  it("accepts a message from a producer that predates runAttempt", () => {
    const parsed = listingJobSchema.parse(base);
    expect(parsed.runAttempt).toBeUndefined();
    expect(listingRunKey(parsed)).toBe(`listing:ws_opak:${draftId}:0`);
  });

  it("still rejects an unknown field", () => {
    expect(() =>
      listingJobSchema.parse({ ...base, operationId: "nope" }),
    ).toThrow();
  });

  it("rejects a runAttempt that is not a bounded non-negative integer", () => {
    for (const runAttempt of [-1, 1.5, 1000]) {
      expect(() => listingJobSchema.parse({ ...base, runAttempt })).toThrow();
    }
  });
});
