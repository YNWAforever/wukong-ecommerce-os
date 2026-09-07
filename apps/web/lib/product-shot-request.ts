import { ApiError } from "./route-support";
import { createHash } from "node:crypto";
import { PRODUCT_SHOT_LIMITS } from "@wukong/core";
import type { AssetStore } from "@wukong/assets";
import { validateProductShotSource } from "@wukong/assets/product-shot-render";
import type { Database } from "@wukong/db";
import { PRODUCT_SHOT_INGRESS_PATH, type ProductShotJob } from "@wukong/jobs";
import { createCloudflareIngressClient } from "./cloudflare-queue-runtime";
import { getAssetStore, getDatabase } from "./intake-runtime";
export type ProductShotRequestInput = {
  workspaceId: string;
  listingId: string;
  actorId: string;
  sourceAssetId?: string;
  expectedVersionId?: string;
  explicitFreshAttempt?: boolean;
};
export type ProductShotRequestResult = { state: string; attemptId?: string };
export type ProductShotAttachInput = {
  workspaceId: string;
  listingId: string;
  actorId: string;
  sourceAssetId: string;
  expectedVersionId: string;
};
export type ProductShotAttachDeps = {
  forWorkspace: Database["forWorkspace"];
  requestShot: (
    input: ProductShotRequestInput,
  ) => Promise<ProductShotRequestResult>;
};
export type ProductShotRequestDeps = {
  forWorkspace: Database["forWorkspace"];
  assetStore: AssetStore;
  providerName: "disabled" | "fake" | "photoroom";
  enqueue: (job: ProductShotJob) => Promise<unknown>;
  validateSource?: (
    bytes: Uint8Array,
    mimeType: string,
  ) => Promise<{ width: number; height: number }>;
};
export const PRODUCT_SHOT_RENDER_VERSION = "white-v1";

function assertMutableObservedVersion(
  snapshot: Awaited<
    ReturnType<
      Parameters<
        Parameters<Database["forWorkspace"]>[1]
      >[0]["listings"]["getReviewSnapshot"]
    >
  >,
  expectedVersionId: string,
): void {
  if (!snapshot?.activeVersion)
    throw new ApiError(404, "listing_not_found", "Listing not found.");
  if (
    snapshot.activeVersion.id !== expectedVersionId ||
    snapshot.listing.activeVersionId !== expectedVersionId
  )
    throw new ApiError(
      409,
      "version_conflict",
      "Reload the listing before changing its image.",
    );
  if (snapshot.listing.status === "publishing")
    throw new ApiError(
      409,
      "listing_publishing",
      "Wait for publishing to finish before changing the image.",
    );
}

export async function attachProductShotSource(
  input: ProductShotAttachInput,
  deps: ProductShotAttachDeps,
): Promise<ProductShotRequestResult> {
  await deps.forWorkspace(input.workspaceId, async (repositories) => {
    await repositories.listings.lockReviewState(input.listingId);
    const snapshot = await repositories.listings.getReviewSnapshot(
      input.listingId,
    );
    assertMutableObservedVersion(snapshot, input.expectedVersionId);
    const [asset] = await repositories.sourceAssets.getByIds([
      input.sourceAssetId,
    ]);
    const metadata =
      typeof asset?.metadata === "object" && asset.metadata !== null
        ? (asset.metadata as Record<string, unknown>)
        : {};
    if (
      !asset ||
      asset.workspaceId !== input.workspaceId ||
      (asset.listingId !== null && asset.listingId !== input.listingId) ||
      !["image/jpeg", "image/png", "image/webp"].includes(asset.kind) ||
      (typeof metadata.role === "string" &&
        metadata.role.startsWith("product_shot_"))
    )
      throw new ApiError(
        422,
        "source_asset_unavailable",
        "Choose a finalized image available to this listing.",
      );
    if (asset.listingId === input.listingId) return;
    try {
      await repositories.sourceAssets.attachToListing(input.listingId, [
        input.sourceAssetId,
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          "One or more source assets are missing or already associated"
      )
        throw new ApiError(
          409,
          "source_asset_conflict",
          "Reload the listing before attaching this image.",
        );
      throw error;
    }
    await repositories.audit.write({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      entityId: input.listingId,
      action: "product_shot.source_attached",
      metadata: { sourceAssetId: input.sourceAssetId },
    });
  });
  return deps.requestShot({ ...input, explicitFreshAttempt: false });
}

/** Called only with server-resolved workspace/actor and validated route inputs. */
export async function requestProductShot(
  input: ProductShotRequestInput,
  deps: ProductShotRequestDeps,
): Promise<ProductShotRequestResult> {
  if (deps.providerName === "disabled") return { state: "setup_required" };
  const assertObservedVersion = async (
    r: Parameters<Parameters<Database["forWorkspace"]>[1]>[0],
  ) => {
    if (!input.expectedVersionId) return;
    await r.listings.lockReviewState(input.listingId);
    const snapshot = await r.listings.getReviewSnapshot(input.listingId);
    if (!snapshot?.activeVersion)
      throw new ApiError(404, "listing_not_found", "Listing not found.");
    assertMutableObservedVersion(snapshot, input.expectedVersionId);
  };
  const existing = await deps.forWorkspace(input.workspaceId, async (r) => {
    await assertObservedVersion(r);
    return r.productShots.currentForListing(input.listingId);
  });
  if (
    input.explicitFreshAttempt &&
    (!existing || !["failed", "outcome_unknown"].includes(existing.state))
  )
    throw new ApiError(
      409,
      "fresh_attempt_not_allowed",
      "Reload the image state before requesting a fresh attempt.",
    );
  if (
    existing &&
    existing.providerVersion === `${deps.providerName}:1.0.0` &&
    existing.renderVersion === PRODUCT_SHOT_RENDER_VERSION &&
    (!input.sourceAssetId || input.sourceAssetId === existing.sourceAssetId) &&
    !input.explicitFreshAttempt
  ) {
    if (existing.state === "queued" || existing.state === "processing")
      await deps.enqueue({
        kind: "product_shot",
        workspaceId: input.workspaceId,
        draftId: input.listingId,
        attemptId: existing.attemptId,
      });
    return { state: existing.state, attemptId: existing.attemptId };
  }
  const assets = await deps.forWorkspace(input.workspaceId, (r) =>
    r.sourceAssets.listForListing(input.listingId),
  );
  const originals = assets.filter(
    (a) =>
      a.workspaceId === input.workspaceId &&
      a.listingId === input.listingId &&
      ["image/png", "image/jpeg", "image/webp"].includes(a.kind) &&
      !(
        typeof a.metadata === "object" &&
        a.metadata !== null &&
        "role" in a.metadata &&
        String(a.metadata.role).startsWith("product_shot_")
      ),
  );
  const selectedId = input.sourceAssetId ?? existing?.sourceAssetId;
  if (!selectedId && originals.length !== 1)
    return {
      state: originals.length ? "source_selection_required" : "no_source",
    };
  const source = selectedId
    ? originals.find((a) => a.id === selectedId)
    : originals[0];
  if (!source) throw new Error("source_not_found");
  const head = await deps.assetStore.head(input.workspaceId, source.storageKey);
  if (!head || head.size < 1 || head.size > PRODUCT_SHOT_LIMITS.inputBytes)
    throw new Error("input_too_large");
  const bytes = await deps.assetStore.readObject(
    input.workspaceId,
    source.storageKey,
  );
  if (bytes.length > PRODUCT_SHOT_LIMITS.inputBytes)
    throw new Error("input_too_large");
  await (deps.validateSource ?? validateProductShotSource)(bytes, source.kind);
  const { attemptId } = await deps.forWorkspace(
    input.workspaceId,
    async (r) => {
      await assertObservedVersion(r);
      if (input.explicitFreshAttempt) {
        await r.listings.lockReviewState(input.listingId);
        const current = await r.productShots.currentForListing(input.listingId);
        if (
          !current ||
          current.attemptId !== existing?.attemptId ||
          current.sourceAssetId !== source.id ||
          !["failed", "outcome_unknown"].includes(current.state)
        )
          throw new ApiError(
            409,
            "fresh_attempt_not_allowed",
            "Reload the image state before requesting a fresh attempt.",
          );
      }
      return r.productShots.ensure({
        workspaceId: input.workspaceId,
        listingId: input.listingId,
        actorId: input.actorId,
        sourceAssetId: source.id,
        sourceDigest: createHash("sha256").update(bytes).digest("hex"),
        providerVersion: `${deps.providerName}:1.0.0`,
        renderVersion: PRODUCT_SHOT_RENDER_VERSION,
        explicitFreshAttempt: input.explicitFreshAttempt ?? false,
      });
    },
  );
  const row = await deps.forWorkspace(input.workspaceId, (r) =>
    r.productShots.get(attemptId),
  );
  if (!row) throw new Error("attempt_not_found");
  if (row.state === "queued" || row.state === "processing")
    await deps.enqueue({
      kind: "product_shot",
      workspaceId: input.workspaceId,
      draftId: input.listingId,
      attemptId,
    });
  return { state: row.state, attemptId };
}
export async function requestProductShotFromProcess(
  input: ProductShotRequestInput,
): Promise<ProductShotRequestResult> {
  const providerName = process.env.PRODUCT_SHOT_PROVIDER?.trim() || "disabled";
  if (providerName === "disabled") return { state: "setup_required" };
  if (providerName !== "fake" && providerName !== "photoroom")
    return { state: "setup_required" };
  if (
    !process.env.QUEUE_INGRESS_URL?.trim() ||
    !process.env.QUEUE_INGRESS_SECRET?.trim()
  )
    return { state: "setup_required" };
  const configuredBudget =
    process.env.PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY?.trim();
  const budget = Number(configuredBudget);
  if (
    (configuredBudget || providerName === "photoroom") &&
    (!Number.isSafeInteger(budget) || budget <= 0 || budget > 2_147_483_647)
  )
    return { state: "setup_required" };
  return requestProductShot(input, {
    providerName,
    forWorkspace: getDatabase().forWorkspace,
    assetStore: getAssetStore(),
    enqueue: (job) =>
      createCloudflareIngressClient().enqueue(PRODUCT_SHOT_INGRESS_PATH, job),
  });
}

export async function attachProductShotSourceFromProcess(
  input: ProductShotAttachInput,
): Promise<ProductShotRequestResult> {
  return attachProductShotSource(input, {
    forWorkspace: getDatabase().forWorkspace,
    requestShot: requestProductShotFromProcess,
  });
}
