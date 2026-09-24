/**
 * What counts as an acceptable upload, in one place.
 *
 * The limits were spread across four layers that had to agree by inspection:
 * the intake form, the presign route, the finalize route, and the create route.
 * They mostly did -- except the form had no size check at all, so an operator
 * could pick a 25 MB photo, be told it was ready, and only discover the limit
 * when presign refused it. And `MAX_ASSET_SIZE` already existed while both
 * routes wrote `20 * 1024 * 1024` out by hand, so the shared constant was
 * present and simply unused.
 *
 * This module is deliberately a LEAF: no `node:` imports, no SDK, no I/O. It is
 * exported as `@wukong/assets/media-policy` so a client component can import it
 * without pulling the AWS SDK into the browser bundle -- which is why
 * `bulk-import-panel.tsx` had to copy its limit with a comment pointing at the
 * route instead.
 */

/** Largest single upload, matching what presign and finalize enforce. */
export const MAX_ASSET_SIZE = 20 * 1024 * 1024;

export const SUPPORTED_ASSET_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export type AssetMimeType = (typeof SUPPORTED_ASSET_MIME_TYPES)[number];

/** Per listing. Enforced by the create route and mirrored by the intake form. */
export const MAX_LISTING_IMAGES = 10;
export const MAX_LISTING_PDFS = 1;

export function isSupportedAssetMimeType(
  mimeType: string,
): mimeType is AssetMimeType {
  return (SUPPORTED_ASSET_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Images and PDFs are counted separately because they are capped separately,
 * and because only images reach the product-shot path.
 */
export function isImageMimeType(mimeType: string): boolean {
  return isSupportedAssetMimeType(mimeType) && mimeType !== "application/pdf";
}

export type MediaRejection =
  | "unsupported_type"
  | "empty_file"
  | "too_large"
  | "too_many_images"
  | "too_many_pdfs";

/**
 * Why one file cannot be accepted, or null when it can.
 *
 * `imagesBefore` / `pdfsBefore` are how many of each are already accepted, so
 * the caller can apply the caps across an accumulated selection rather than one
 * batch at a time.
 */
export function rejectAsset(
  file: { mimeType: string; size: number },
  counts: { imagesBefore: number; pdfsBefore: number } = {
    imagesBefore: 0,
    pdfsBefore: 0,
  },
): MediaRejection | null {
  if (!isSupportedAssetMimeType(file.mimeType)) return "unsupported_type";
  // A zero-byte file passes a MIME check and fails at presign, where
  // `size: z.number().int().min(1)` rejects it far less legibly.
  if (!Number.isInteger(file.size) || file.size < 1) return "empty_file";
  if (file.size > MAX_ASSET_SIZE) return "too_large";
  if (isImageMimeType(file.mimeType)) {
    return counts.imagesBefore >= MAX_LISTING_IMAGES ? "too_many_images" : null;
  }
  return counts.pdfsBefore >= MAX_LISTING_PDFS ? "too_many_pdfs" : null;
}
