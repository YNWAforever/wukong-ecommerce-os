import { z } from "zod";

/**
 * Bounded multi-listing review contracts.
 *
 * An operator selects at most five listings and the server runs the existing
 * deterministic guided stages (workspace audit, then selected-listing gaps) per
 * listing, each in its own Studio thread. The batch is an aggregation: it adds
 * no workflow table and never starts work on its own. Copy proposals stay a
 * manual send inside each thread, so this module never authorizes a model call.
 */

export const STUDIO_REVIEW_BATCH_LIMIT = 5;

const uuid = z.uuid().transform((value) => value.toLowerCase());

/** Strict request body: unique listing ids, 1..5 entries. */
export const studioReviewBatchBodySchema = z
  .strictObject({
    listingIds: z.array(uuid).min(1).max(STUDIO_REVIEW_BATCH_LIMIT),
    /** Presentation only: the language of the synthetic guided requests. */
    locale: z.enum(["en", "zh-Hant"]).default("en"),
  })
  .refine(
    (value) => new Set(value.listingIds).size === value.listingIds.length,
    "Listing ids must be unique",
  );
export type StudioReviewBatchBody = z.infer<typeof studioReviewBatchBodySchema>;

/** `GET /api/studio/reviews` query: comma-separated ids, 1..5 unique. */
export const studioReviewBatchQuerySchema = z
  .strictObject({
    listingIds: z
      .string()
      .min(1)
      .max(400)
      .transform((value) => value.split(","))
      .pipe(
        z
          .array(uuid)
          .min(1)
          .max(STUDIO_REVIEW_BATCH_LIMIT)
          .refine(
            (ids) => new Set(ids).size === ids.length,
            "Listing ids must be unique",
          ),
      ),
  })
  .transform((value) => value.listingIds);

/** Bounded, client-safe reasons a listing review could not complete. */
export const STUDIO_REVIEW_FAILURE_CODES = [
  "listing_unavailable",
  "listing_changed",
  "review_unavailable",
  "review_failed",
] as const;
export type StudioReviewFailureCode =
  (typeof STUDIO_REVIEW_FAILURE_CODES)[number];

/** Exact recorded artifact reference (never substituted with newer content). */
export type StudioReviewArtifact = {
  outputId: string;
  revision: number;
  contentDigest: string;
};

export type StudioReviewBatchItem = {
  listingId: string;
  /** Listing title at read time; empty when the listing is unavailable. */
  title: string;
  outcome: "complete" | "partial" | "failed";
  failureCode: StudioReviewFailureCode | null;
  threadId: string | null;
  audit: StudioReviewArtifact | null;
  gap: StudioReviewArtifact | null;
};

export type StudioReviewBatchResult = {
  /** Correlation id for this response; not a persisted entity. */
  batchId: string;
  items: StudioReviewBatchItem[];
  requested: number;
  completed: number;
  partial: number;
  failed: number;
};

/** Per-listing recorded state used to rebuild the surface after a reload. */
export type StudioListingReviewState = {
  listingId: string;
  available: boolean;
  title: string;
  status: string | null;
  activeVersion: { versionId: string; sequence: number } | null;
  threadId: string | null;
  audit: StudioReviewArtifact | null;
  gap: StudioReviewArtifact | null;
};

export type StudioListingReviewsResult = {
  items: StudioListingReviewState[];
};

/** A digest is only usable as an exact pin when it is the persisted sha256. */
export function reviewArtifact(
  value: {
    outputId: string;
    revision: number;
    contentDigest: string;
  } | null,
): StudioReviewArtifact | null {
  return value !== null && /^[a-f0-9]{64}$/.test(value.contentDigest)
    ? {
        outputId: value.outputId,
        revision: value.revision,
        contentDigest: value.contentDigest,
      }
    : null;
}
