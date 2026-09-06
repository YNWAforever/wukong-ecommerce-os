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
  explicitFreshAttempt?: boolean;
};
export type ProductShotRequestResult = { state: string; attemptId?: string };
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
/** Called only with server-resolved workspace/actor and validated route inputs. */
export async function requestProductShot(
  input: ProductShotRequestInput,
  deps: ProductShotRequestDeps,
): Promise<ProductShotRequestResult> {
  if (deps.providerName === "disabled") return { state: "setup_required" };
  const existing = await deps.forWorkspace(input.workspaceId, (r) =>
    r.productShots.currentForListing(input.listingId),
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
  const { attemptId } = await deps.forWorkspace(input.workspaceId, (r) =>
    r.productShots.ensure({
      workspaceId: input.workspaceId,
      listingId: input.listingId,
      actorId: input.actorId,
      sourceAssetId: source.id,
      sourceDigest: createHash("sha256").update(bytes).digest("hex"),
      providerVersion: `${deps.providerName}:1.0.0`,
      renderVersion: PRODUCT_SHOT_RENDER_VERSION,
      explicitFreshAttempt: input.explicitFreshAttempt ?? false,
    }),
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
