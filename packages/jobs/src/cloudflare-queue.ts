import { Buffer } from "node:buffer";

import { z } from "zod";

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
  })
  .strict();

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
export type QueueMessage = ListingJob | ShoplinePublishJob;

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
    difference |=
      (expectedBytes[index] ?? 0) ^ (receivedBytes[index] ?? 0);
  }

  return difference === 0;
}

export async function verifyQueueRequest(input: VerifyInput): Promise<boolean> {
  if (!/^\d+$/.test(input.timestamp)) return false;

  const timestamp = Number(input.timestamp);
  if (!Number.isSafeInteger(timestamp) || input.timestamp !== String(timestamp)) {
    return false;
  }
  if (!Number.isFinite(input.nowSeconds) || Math.abs(input.nowSeconds - timestamp) > 300) {
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
