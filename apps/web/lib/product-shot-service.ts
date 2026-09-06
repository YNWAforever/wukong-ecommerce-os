import { createHash } from "node:crypto";
import type { AssetStore } from "@wukong/assets";
import {
  renderProductShot,
  validateProductShotSource,
} from "@wukong/assets/product-shot-render";
import { PRODUCT_SHOT_LIMITS } from "@wukong/core";
import type { Database, SourceAsset } from "@wukong/db";
import { ApiError } from "./route-support";
export type ProductShotServiceDeps = {
  forWorkspace: Database["forWorkspace"];
  assetStore: AssetStore;
  render?: typeof renderProductShot;
};
type Scope = { workspaceId: string; listingId: string; actorId: string };
type Observation = Scope & { attemptId: string; expectedVersionId: string };
export type ProductShotView = {
  state: string;
  attemptId: string | null;
  expectedVersionId: string | null;
  sourceAssetId: string | null;
  sourcePreviewUrl: string | null;
  candidatePreviewUrl: string | null;
  candidateDigest: string | null;
  lowResolution: boolean;
  sources: Array<{ assetId: string; previewUrl: string }>;
  allowedActions: string[];
};
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function conflict(code: string): never {
  throw new ApiError(
    409,
    code,
    "The image review has changed. Reload and try again.",
  );
}
export function eligibleProductShotSource(asset: SourceAsset): boolean {
  return (
    ["image/png", "image/jpeg", "image/webp"].includes(asset.kind) &&
    !String(
      (asset.metadata as Record<string, unknown> | null)?.role ?? "",
    ).startsWith("product_shot_")
  );
}
async function snapshot(
  input: Scope,
  deps: ProductShotServiceDeps,
  observation?: Observation,
) {
  return deps.forWorkspace(input.workspaceId, async (r) => {
    if (observation) await r.listings.lockReviewState(input.listingId);
    const review = await r.listings.getReviewSnapshot(input.listingId);
    if (!review)
      throw new ApiError(404, "listing_not_found", "Listing not found.");
    const version = review.activeVersion?.id ?? null;
    if (
      observation &&
      (version !== observation.expectedVersionId ||
        review.listing.activeVersionId !== version)
    )
      conflict("version_conflict");
    const attempt = await r.productShots.currentForListing(input.listingId);
    if (
      observation &&
      (!attempt ||
        attempt.attemptId !== observation.attemptId ||
        attempt.listingId !== input.listingId)
    )
      conflict("selection_changed");
    const assets = (
      await r.sourceAssets.listForListing(input.listingId)
    ).filter(
      (a) =>
        a.workspaceId === input.workspaceId && a.listingId === input.listingId,
    );
    return { version, attempt, assets };
  });
}
export async function readProductShot(
  input: Scope,
  deps: ProductShotServiceDeps,
): Promise<ProductShotView> {
  const first = await snapshot(input, deps);
  const { attempt, assets, version } = first;
  const url = async (id: string | undefined | null) => {
    const asset = assets.find((a) => a.id === id);
    return asset
      ? (
          await deps.assetStore.createReadUrl(
            input.workspaceId,
            asset.storageKey,
          )
        ).url
      : null;
  };
  const sources = await Promise.all(
    assets
      .filter(eligibleProductShotSource)
      .map(async (a) => ({ assetId: a.id, previewUrl: (await url(a.id))! })),
  );
  const sourcePreviewUrl = await url(attempt?.sourceAssetId),
    candidatePreviewUrl = await url(attempt?.candidate?.assetId);
  // Signing URLs is external IO. Discard the response if its observation changed.
  const last = await snapshot(input, deps);
  if (
    last.version !== version ||
    last.attempt?.attemptId !== attempt?.attemptId ||
    last.attempt?.state !== attempt?.state ||
    last.attempt?.candidate?.digest !== attempt?.candidate?.digest
  )
    conflict("selection_changed");
  const state =
    attempt?.state ??
    (sources.length === 0
      ? "no_source"
      : sources.length > 1
        ? "source_selection_required"
        : "not_requested");
  const allowedActions = version ? ["select_source"] : [];
  if (version && !attempt && sources.length === 1)
    allowedActions.push("request");
  if (attempt?.state === "cutout_ready") allowedActions.push("prepare");
  if (
    (attempt?.state === "candidate_ready" || attempt?.state === "approved") &&
    candidatePreviewUrl
  )
    allowedActions.push("approve");
  if (attempt?.state === "failed" || attempt?.state === "outcome_unknown")
    allowedActions.push("fresh_attempt");
  if (attempt?.state === "queued") allowedActions.push("retry_queue");
  return {
    state,
    attemptId: attempt?.attemptId ?? null,
    expectedVersionId: version,
    sourceAssetId: attempt?.sourceAssetId ?? null,
    sourcePreviewUrl,
    candidatePreviewUrl,
    candidateDigest: attempt?.candidate?.digest ?? null,
    lowResolution: attempt?.candidate?.lowResolution ?? false,
    sources,
    allowedActions,
  };
}
export async function prepareProductShot(
  input: Observation,
  deps: ProductShotServiceDeps,
): Promise<ProductShotView> {
  const initial = await snapshot(input, deps, input);
  const attempt = initial.attempt!;
  if (attempt.candidate) return readProductShot(input, deps);
  if (
    attempt.state !== "cutout_ready" ||
    !attempt.cutoutAssetId ||
    !attempt.cutoutDigest
  )
    conflict("candidate_not_ready");
  const cutout = initial.assets.find((a) => a.id === attempt.cutoutAssetId);
  if (!cutout || cutout.kind !== "image/png") conflict("cutout_not_found");
  const head = await deps.assetStore.head(input.workspaceId, cutout.storageKey);
  if (!head || head.size < 1 || head.size > PRODUCT_SHOT_LIMITS.inputBytes)
    throw new ApiError(422, "invalid_image", "The processed image is invalid.");
  const bytes = await deps.assetStore.readObject(
    input.workspaceId,
    cutout.storageKey,
  );
  if (sha(bytes) !== attempt.cutoutDigest)
    throw new ApiError(422, "invalid_image", "The processed image is invalid.");
  let output: Awaited<ReturnType<typeof renderProductShot>>;
  try {
    output = await (deps.render ?? renderProductShot)(bytes);
    const geometry = await validateProductShotSource(
      output.bytes,
      "image/jpeg",
    );
    if (
      output.mimeType !== "image/jpeg" ||
      output.bytes.length > PRODUCT_SHOT_LIMITS.outputBytes ||
      geometry.width !== output.width ||
      geometry.height !== output.height ||
      output.width !== output.height ||
      output.width > PRODUCT_SHOT_LIMITS.canvas ||
      typeof output.lowResolution !== "boolean"
    )
      throw new Error("invalid_image");
  } catch {
    throw new ApiError(
      422,
      "invalid_image",
      "The final image could not be prepared. Retry preparation.",
    );
  }
  const digest = sha(output.bytes);
  const identity = sha(
    Buffer.from(`${attempt.cutoutDigest}:${attempt.renderVersion}`),
  );
  const key = `ws/${input.workspaceId}/sources/${attempt.attemptId}/candidate-${identity}-${digest}.jpg`;
  await deps.assetStore.writeObjectIfAbsent(
    input.workspaceId,
    key,
    output.bytes,
    "image/jpeg",
  );
  const persisted = await deps.assetStore.readObject(input.workspaceId, key);
  if (sha(persisted) !== digest)
    throw new ApiError(
      422,
      "invalid_image",
      "The stored image does not match the preview.",
    );
  await deps.forWorkspace(input.workspaceId, async (r) => {
    await r.listings.lockReviewState(input.listingId);
    const review = await r.listings.getReviewSnapshot(input.listingId);
    if (
      review?.activeVersion?.id !== input.expectedVersionId ||
      review.listing.activeVersionId !== input.expectedVersionId
    )
      conflict("version_conflict");
    const current = await r.productShots.currentForListing(input.listingId);
    if (
      !current ||
      current.attemptId !== input.attemptId ||
      current.sourceAssetId !== attempt.sourceAssetId ||
      current.sourceDigest !== attempt.sourceDigest ||
      current.cutoutDigest !== attempt.cutoutDigest ||
      current.renderVersion !== attempt.renderVersion
    )
      conflict("selection_changed");
    // The listing lock serializes candidate attachment; a competing prepare reads the winner.
    if (current.candidate) return;
    const asset = await r.sourceAssets.create({
      storageKey: key,
      kind: "image/jpeg",
      metadata: {
        role: "product_shot_candidate",
        attemptId: attempt.attemptId,
        sourceAssetId: attempt.sourceAssetId,
        sourceDigest: attempt.sourceDigest,
        providerVersion: attempt.providerVersion,
        renderVersion: attempt.renderVersion,
        digest,
        mimeType: "image/jpeg",
        size: persisted.length,
        width: output.width,
        height: output.height,
        lowResolution: output.lowResolution,
      },
    });
    await r.sourceAssets.attachToListing(input.listingId, [asset.id]);
    await r.productShots.saveCandidate({
      attemptId: attempt.attemptId,
      candidate: {
        assetId: asset.id,
        digest,
        size: persisted.length,
        width: output.width,
        height: output.height,
        lowResolution: output.lowResolution,
      },
    });
  });
  return readProductShot(input, deps);
}
export async function approveProductShot(
  input: Observation & { candidateDigest: string },
  deps: ProductShotServiceDeps,
): Promise<void> {
  await deps.forWorkspace(input.workspaceId, async (r) => {
    await r.listings.lockReviewState(input.listingId);
    const current = await r.productShots.currentForListing(input.listingId);
    if (
      !current ||
      current.attemptId !== input.attemptId ||
      current.listingId !== input.listingId
    )
      conflict("selection_changed");
    await r.productShots.approve({
      attemptId: input.attemptId,
      expectedVersionId: input.expectedVersionId,
      candidateDigest: input.candidateDigest,
      actorId: input.actorId,
    });
  });
}
