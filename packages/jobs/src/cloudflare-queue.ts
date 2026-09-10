import { Buffer } from "node:buffer";

import { z } from "zod";
import type { ProductShotJob } from "./product-shot-queue.js";
import type { WebsiteJob } from "./website-queue.js";

const safeId = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes(":"), {
    message: "identifier must not contain ':'",
  });

export const LISTING_INGRESS_PATH = "/ingress/listings";
export const SHOPLINE_INGRESS_PATH = "/ingress/shopline-publish";

export const listingJobSchema = z
  .object({
    workspaceId: safeId,
    draftId: z.string().uuid(),
    activeVersionSequence: z.number().int().nonnegative(),
    /**
     * Which deliberate re-run of this revision this message is.
     *
     * `activeVersionSequence` alone cannot identify a run: a listing that ends
     * in `needs_info` appends no version, so its sequence stays where it was and
     * the derived key keeps resolving to the run that already completed. The
     * operator supplies what was missing and nothing can happen.
     *
     * Optional, and absent means 0, so a message produced before this field
     * existed still parses and still derives exactly the key it derived before.
     * A NEW producer must not run against an OLD Worker, though: the schema is
     * strict, so an unrecognized key makes safeParse fail and the consumer acks
     * the message away. Deploy the Worker first.
     */
    runAttempt: z.number().int().min(0).max(999).optional(),
  })
  .strict();

/**
 * The idempotency key for one listing pipeline run.
 *
 * Both the web producer and the Worker derive this, and they must agree
 * exactly, so it lives here rather than being spelled out on each side.
 * Attempt 0 keeps the historical `listing:<ws>:<draft>:<sequence>` form so
 * every run already recorded stays reachable under the same key.
 */
export function listingRunKey(input: {
  workspaceId: string;
  draftId: string;
  activeVersionSequence: number;
  runAttempt?: number;
}): string {
  const base = `listing:${input.workspaceId}:${input.draftId}:${input.activeVersionSequence}`;
  return input.runAttempt ? `${base}#${input.runAttempt}` : base;
}

export const shoplinePublishJobSchema = z
  .object({
    workspaceId: safeId,
    draftId: z.string().uuid(),
    versionId: z.string().uuid(),
    connectionId: z.string().uuid(),
  })
  .strict();

export type ListingJob = z.infer<typeof listingJobSchema>;
export type ShoplinePublishJob = z.infer<typeof shoplinePublishJobSchema>;
export type QueueMessage =
  ListingJob | ShoplinePublishJob | WebsiteJob | ProductShotJob;

type SignInput = {
  secret: string;
  timestamp: number;
  path: string;
  body: string;
};

type VerifyInput = {
  secret: string;
  nowSeconds: number;
  timestamp: string;
  signature: string;
  path: string;
  body: string;
};

async function createHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function signQueueRequest(input: SignInput): Promise<string> {
  const key = await createHmacKey(input.secret);
  const bytes = new TextEncoder().encode(
    `${input.timestamp}\n${input.path}\n${input.body}`,
  );
  return Buffer.from(await crypto.subtle.sign("HMAC", key, bytes)).toString(
    "base64url",
  );
}

function isConstantTimeEqual(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected, "base64url");
  const receivedBytes = Buffer.from(received, "base64url");
  const length = Math.max(expectedBytes.length, receivedBytes.length);
  let difference = expectedBytes.length ^ receivedBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (expectedBytes[index] ?? 0) ^ (receivedBytes[index] ?? 0);
  }

  return difference === 0;
}

export async function verifyQueueRequest(input: VerifyInput): Promise<boolean> {
  if (!/^\d+$/.test(input.timestamp)) return false;

  const timestamp = Number(input.timestamp);
  if (
    !Number.isSafeInteger(timestamp) ||
    input.timestamp !== String(timestamp)
  ) {
    return false;
  }
  if (
    !Number.isFinite(input.nowSeconds) ||
    Math.abs(input.nowSeconds - timestamp) > 300
  ) {
    return false;
  }

  const expected = await signQueueRequest({
    secret: input.secret,
    timestamp,
    path: input.path,
    body: input.body,
  });
  return isConstantTimeEqual(expected, input.signature);
}
