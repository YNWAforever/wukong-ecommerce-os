import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

import { ApiError } from "../route-support";

/** SHA-256 hex of a canonical JSON string (shared by both receipt routes). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Optional HMAC-SHA256 export receipt (B3, shared by the export and receipt
 * endpoints).
 *
 * When `STUDIO_EXPORT_SIGNING_KEY` is configured, an export carries a `receipt`
 * over a small, fixed message. The key is read from the server environment only,
 * never returned; `STUDIO_EXPORT_SIGNING_KEY_ID` is the only key identity that
 * appears in a receipt. Without the key the export says `signed: false` and has
 * no receipt object — no fake signature is ever emitted.
 *
 * This module is server-only (`node:crypto`); client components read receipts
 * through `GET /api/studio/outputs/[id]/receipt`, never by importing this file.
 */

export const STUDIO_EXPORT_SCHEMA_VERSION = "wukong-studio-output-export/v1";

/** Only a saved/signed-off artifact is exportable or receiptable. */
export const STUDIO_EXPORTABLE_STATUSES: ReadonlySet<string> = new Set([
  "saved",
  "signed_off",
]);

/** The preview digest the caller must echo back before content is exposed. */
export const exportDigestQuerySchema = z.object({
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .max(64),
});

export type StudioExportReceipt = {
  alg: "HMAC-SHA256";
  keyId: string;
  signedAt: string;
  payloadSha256: string;
  signature: string;
};

export type StudioExportReceiptInput = {
  schemaVersion: string;
  payloadSha256: string;
  outputId: string;
  revision: number;
  asOf: string;
  keyId: string;
};

/** The exact bytes a verifier must feed to HMAC. Exported for tests/docs. */
export function exportReceiptMessage(input: StudioExportReceiptInput): string {
  // Sorted-key JSON with no whitespace: the canonical form is part of the
  // verification recipe, not an implementation detail.
  return JSON.stringify({
    asOf: input.asOf,
    keyId: input.keyId,
    outputId: input.outputId,
    payloadSha256: input.payloadSha256,
    revision: input.revision,
    schemaVersion: input.schemaVersion,
  });
}

export function signStudioExportReceipt(
  key: Buffer,
  input: StudioExportReceiptInput & { signedAt: string },
): StudioExportReceipt {
  return {
    alg: "HMAC-SHA256",
    keyId: input.keyId,
    signedAt: input.signedAt,
    payloadSha256: input.payloadSha256,
    signature: createHmac("sha256", key)
      .update(exportReceiptMessage(input))
      .digest("hex"),
  };
}

/** Decode a hex or base64 signing key; `null` when absent, `false` invalid. */
export function decodeExportSigningKey(
  raw: string | undefined,
): Buffer | false | null {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return null;
  let key: Buffer;
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "base64");
  } else {
    return false;
  }
  // 16 bytes is the shortest key that can be considered a secret rather than a
  // typo; HMAC-SHA256 itself accepts any length, so this is a config guard.
  return key.length >= 16 ? key : false;
}

export type ExportSigningConfig = {
  readonly key: Buffer;
  readonly keyId: string;
};

/**
 * Resolve the configured signing key. `null` means signing is off; a malformed
 * configuration throws the same 500 for exports and receipts so neither
 * silently serves unsigned/unsignable content while a key is configured.
 */
export function resolveExportSigningConfig(
  env: NodeJS.ProcessEnv,
): ExportSigningConfig | null {
  const key = decodeExportSigningKey(env.STUDIO_EXPORT_SIGNING_KEY);
  if (key === null) return null;
  if (key === false)
    throw new ApiError(
      500,
      "export_signing_misconfigured",
      "The export signing key is not available.",
    );
  const rawKeyId = (env.STUDIO_EXPORT_SIGNING_KEY_ID ?? "").trim();
  const keyId = rawKeyId.length === 0 ? "v1" : rawKeyId;
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(keyId))
    throw new ApiError(
      500,
      "export_signing_misconfigured",
      "The export signing key id is not available.",
    );
  return { key, keyId };
}

/**
 * Build the server-side receipt state for one version. A signing problem throws
 * before any caller can fall back to an unsigned claim.
 */
export function buildExportReceipt(
  input: Omit<StudioExportReceiptInput, "keyId"> & {
    env: NodeJS.ProcessEnv;
    signedAt: Date;
  },
): {
  keyConfigured: boolean;
  signed: boolean;
  receipt: StudioExportReceipt | null;
} {
  const config = resolveExportSigningConfig(input.env);
  if (config === null)
    return { keyConfigured: false, signed: false, receipt: null };
  return {
    keyConfigured: true,
    signed: true,
    receipt: signStudioExportReceipt(config.key, {
      schemaVersion: input.schemaVersion,
      payloadSha256: input.payloadSha256,
      outputId: input.outputId,
      revision: input.revision,
      asOf: input.asOf,
      keyId: config.keyId,
      signedAt: input.signedAt.toISOString(),
    }),
  };
}
