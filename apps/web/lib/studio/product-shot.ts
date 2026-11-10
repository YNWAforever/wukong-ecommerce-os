import type { ListingAssetEvidence, ProductShotAttemptEvidence } from "./tools";
import {
  translatedLine,
  type ProductShotHandoff,
  type TranslatedLine,
} from "./types";

/**
 * Product-shot prepare skill (C1, activated v1.1).
 *
 * The deterministic slice prepares a *handoff*: it reads the listing, its
 * attached assets and the persisted image-review attempt, then records what the
 * existing gated product-shot screen would act on. It never calls the image
 * provider, never mints a signed URL and never approves anything.
 */

/** The reviewed image content types the provider accepts (see assets package). */
export const PRODUCT_SHOT_SOURCE_CONTENT_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
] as const);

/** Structured facts the turn service needs to build the handoff. */
export type ProductShotPrepareContext = {
  listingId: string;
  listingTitle: string;
  /** At most eight usable source image ids (the tool/dispatch limit). */
  eligibleAssetIds: string[];
  /** Cutouts/candidates already produced by the existing flow. */
  derivedAssetCount: number;
  /** Source assets that are not an accepted image type. */
  ineligibleAssetCount: number;
  /** Persisted attempt state, or `null` when no attempt exists yet. */
  state: string | null;
  candidateReady: boolean;
  ready: boolean;
};

/**
 * Split a listing's assets into usable source images, derived outputs and
 * everything else. Only source images are eligible: an accepted candidate must
 * never be fed back as its own source.
 */
export function splitProductShotAssets(
  assets: readonly ListingAssetEvidence[],
): Pick<
  ProductShotPrepareContext,
  "eligibleAssetIds" | "derivedAssetCount" | "ineligibleAssetCount"
> {
  const eligibleAssetIds: string[] = [];
  let derivedAssetCount = 0;
  let ineligibleAssetCount = 0;
  for (const asset of assets) {
    if (asset.role === "derived") {
      derivedAssetCount += 1;
      continue;
    }
    if (
      (PRODUCT_SHOT_SOURCE_CONTENT_TYPES as readonly string[]).includes(
        asset.contentType,
      )
    )
      eligibleAssetIds.push(asset.assetId);
    else ineligibleAssetCount += 1;
  }
  return {
    eligibleAssetIds: eligibleAssetIds.slice(0, 8),
    derivedAssetCount,
    ineligibleAssetCount,
  };
}

/** The prepared handoff recorded on the assistant turn. */
export function productShotHandoffFromContext(
  context: ProductShotPrepareContext,
): ProductShotHandoff {
  return {
    kind: "product_shot_handoff",
    listingId: context.listingId,
    assetIds: [...context.eligibleAssetIds],
    state: context.state,
    ready: context.ready,
  };
}

/** Context from the persisted attempt read; a missing read stays unknown. */
export function productShotAttemptFacts(
  attempt: ProductShotAttemptEvidence | null,
): Pick<ProductShotPrepareContext, "state" | "candidateReady"> {
  return {
    state: attempt?.state ?? null,
    candidateReady: attempt?.candidateReady ?? false,
  };
}

/** Honest limitations for a deterministic product-shot prepare turn. */
export function productShotLimitations(input: {
  listingAvailable: boolean;
  assetsReadable: boolean;
  stateKnown: boolean;
  eligibleAssets: number;
}): TranslatedLine[] {
  const limitations: TranslatedLine[] = [
    translatedLine("studio.limit.product_shot_handoff"),
  ];
  if (!input.listingAvailable)
    limitations.push(
      translatedLine("studio.limit.product_shot_listing_unavailable"),
    );
  else if (!input.assetsReadable)
    limitations.push(
      translatedLine("studio.limit.product_shot_assets_unavailable"),
    );
  else if (input.eligibleAssets === 0)
    limitations.push(translatedLine("studio.limit.product_shot_no_source"));
  if (input.stateKnown === false)
    limitations.push(translatedLine("studio.limit.product_shot_state_unknown"));
  return limitations;
}
