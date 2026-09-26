import { inspectPdf } from "./inspect-pdf.js";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { verifiedSourceAssetKey, type AssetStore } from "./asset-store.js";
import { MAX_ASSET_SIZE } from "./media-policy.js";

export const MAX_SOURCE_PIXELS = 40_000_000;

export class SourceInspectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceInspectionError";
  }
}

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function preserveVerifiedSource(
  store: AssetStore,
  workspaceId: string,
  uploadKey: string,
  bytes: Uint8Array,
  expected: { mimeType: string; size: number; sha256: string },
): Promise<string> {
  const verifiedStorageKey = verifiedSourceAssetKey(
    workspaceId,
    uploadKey,
    expected.mimeType,
  );
  await store.writeObjectIfAbsent(
    workspaceId,
    verifiedStorageKey,
    bytes,
    expected.mimeType,
  );
  let stored: Uint8Array;
  try {
    stored = await store.readObject(workspaceId, verifiedStorageKey, {
      maxBytes: MAX_ASSET_SIZE,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "asset_body_too_large")
      throw error;
    throw new SourceInspectionError(
      "asset_already_finalized",
      "Asset is already finalized with different content.",
    );
  }
  if (stored.byteLength !== expected.size || hash(stored) !== expected.sha256)
    throw new SourceInspectionError(
      "asset_already_finalized",
      "Asset is already finalized with different content.",
    );
  return verifiedStorageKey;
}

/** Copy validated bytes to a server-owned key before they become a source asset. */
export async function inspectUploadedSource(
  store: AssetStore,
  workspaceId: string,
  key: string,
  expected: { mimeType: string; size: number; sha256: string },
) {
  let bytes: Uint8Array;
  try {
    bytes = await store.readObject(workspaceId, key, {
      maxBytes: MAX_ASSET_SIZE,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "asset_body_too_large")
      throw error;
    throw new SourceInspectionError(
      "asset_content_mismatch",
      "The stored file does not match the selected file. Upload it again.",
    );
  }
  if (
    bytes.byteLength !== expected.size ||
    bytes.byteLength > MAX_ASSET_SIZE ||
    hash(bytes) !== expected.sha256
  )
    throw new SourceInspectionError(
      "asset_content_mismatch",
      "The stored file does not match the selected file. Upload it again.",
    );

  if (expected.mimeType === "application/pdf") {
    const header = Buffer.from(bytes.subarray(0, 8)).toString("ascii");
    if (!/^%PDF-1\.[0-9]|^%PDF-2\.0/.test(header))
      throw new SourceInspectionError(
        "invalid_document",
        "This file is not a PDF. Export a valid PDF and try again.",
      );
    let document;
    try {
      document = await inspectPdf(bytes);
    } catch {
      throw new SourceInspectionError(
        "invalid_document",
        "Use a valid, unencrypted PDF with 1–40 pages. Export a smaller document or enter its facts manually.",
      );
    }
    const verifiedStorageKey = await preserveVerifiedSource(
      store,
      workspaceId,
      key,
      bytes,
      expected,
    );
    return {
      hashVerified: true as const,
      contentSha256: expected.sha256,
      inspectionVersion: 1,
      verifiedStorageKey,
      ...document,
    };
  }

  const format = (
    {
      "image/jpeg": "jpeg",
      "image/png": "png",
      "image/webp": "webp",
    } as Record<string, string>
  )[expected.mimeType];
  if (!format)
    throw new SourceInspectionError(
      "unsupported_type",
      "Convert HEIC or unsupported photos to JPEG, PNG or WebP before uploading.",
    );

  let normalized;
  try {
    const decoder = sharp(Buffer.from(bytes), {
      limitInputPixels: MAX_SOURCE_PIXELS,
      failOn: "error",
      animated: false,
    });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== format ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) > 1
    )
      throw new SourceInspectionError(
        "invalid_image",
        "Use a single JPEG, PNG or WebP photo matching its file type.",
      );
    normalized = await decoder.rotate().toBuffer({ resolveWithObject: true });
    if (normalized.data.byteLength > MAX_ASSET_SIZE)
      throw new SourceInspectionError(
        "image_too_large",
        "The decoded photo exceeds the source size limit. Resize it and try again.",
      );
  } catch (error) {
    if (error instanceof SourceInspectionError) throw error;
    const message = error instanceof Error ? error.message : "";
    throw new SourceInspectionError(
      /pixel limit|input image exceeds/i.test(message)
        ? "image_too_large"
        : "invalid_image",
      "The photo could not be decoded safely. Export or resize it as JPEG, PNG or WebP and try again.",
    );
  }

  const verifiedStorageKey = await preserveVerifiedSource(
    store,
    workspaceId,
    key,
    bytes,
    expected,
  );
  const normalizedSha256 = hash(normalized.data);
  const suffix = format === "jpeg" ? "jpg" : format;
  const normalizedStorageKey =
    verifiedStorageKey.slice(0, verifiedStorageKey.lastIndexOf("/") + 1) +
    "normalized-" +
    normalizedSha256 +
    "." +
    suffix;
  await store.writeObjectIfAbsent(
    workspaceId,
    normalizedStorageKey,
    normalized.data,
    expected.mimeType,
  );
  return {
    hashVerified: true as const,
    contentSha256: expected.sha256,
    inspectionVersion: 1,
    verifiedStorageKey,
    normalizedStorageKey,
    normalizedSha256,
    width: normalized.info.width,
    height: normalized.info.height,
    metadataStripped: true,
  };
}
