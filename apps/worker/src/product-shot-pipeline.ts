import { createHash } from "node:crypto";
import type { AssetStore } from "@wukong/assets";
import { PRODUCT_SHOT_LIMITS, type ShotIdentity } from "@wukong/core";
import { ProductShotProviderError, type ProductShotProvider } from "@wukong/ai";
import type {
  Database,
  ProductShotAttempt,
  ProductShotOutputMetadata,
} from "@wukong/db";
import type { ProductShotJob } from "@wukong/jobs";
export type ProductShotPipelineDeps = {
  forWorkspace: Database["forWorkspace"];
  providerFor: (identity: ShotIdentity) => ProductShotProvider;
  assetStore: AssetStore;
  providerName: "disabled" | "fake" | "photoroom";
  dailyLimit: number;
  estimatedCostUsd?: number;
  now: () => Date;
};
export class ProductShotBusyError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("product_shot_busy");
  }
}
export class ProductShotBudgetError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("product_shot_budget_exhausted");
  }
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const cutoutKey = (row: ProductShotAttempt) =>
  `ws/${row.workspaceId}/sources/${row.attemptId}/product-shot-cutout.png`;
function validateCutout(bytes: Uint8Array) {
  const invalid = () => {
    throw new ProductShotProviderError("invalid_output");
  };
  if (
    bytes.length < 45 ||
    bytes.length > PRODUCT_SHOT_LIMITS.inputBytes ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)
  )
    invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8,
    hasData = false,
    ended = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset),
      end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    let crc = 0xffffffff;
    for (const byte of bytes.slice(offset + 4, end - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(end - 4)) invalid();
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) invalid();
      const width = view.getUint32(16),
        height = view.getUint32(20);
      if (!width || !height || width * height > PRODUCT_SHOT_LIMITS.inputPixels)
        invalid();
    } else if (type === "IHDR") invalid();
    if (type === "IDAT") hasData = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length || !hasData) invalid();
      ended = true;
      break;
    }
    offset = end;
  }
  if (!ended) invalid();
}
/** Each workspace callback is a short transaction; storage/provider I/O stays outside. */
export async function runProductShot(
  job: ProductShotJob,
  deps: ProductShotPipelineDeps,
): Promise<void> {
  const read = () =>
    deps.forWorkspace(job.workspaceId, (r) =>
      r.productShots.get(job.attemptId),
    );
  const row = await read();
  if (
    !row ||
    row.listingId !== job.draftId ||
    row.workspaceId !== job.workspaceId
  )
    return;
  if (
    [
      "cutout_ready",
      "candidate_ready",
      "approved",
      "failed",
      "outcome_unknown",
    ].includes(row.state)
  )
    return;
  const key = cutoutKey(row);
  async function checkpoint(bytes: Uint8Array, leaseToken: string) {
    validateCutout(bytes);
    const metadata: ProductShotOutputMetadata = {
      role: "product_shot_cutout",
      attemptId: row!.attemptId,
      sourceAssetId: row!.sourceAssetId,
      sourceDigest: row!.sourceDigest,
      providerVersion: row!.providerVersion,
      renderVersion: row!.renderVersion,
      digest: digest(bytes),
      mimeType: "image/png",
      size: bytes.byteLength,
    };
    await deps.forWorkspace(job.workspaceId, async (r) => {
      let asset = await r.sourceAssets.getByStorageKey(key);
      if (!asset) {
        asset = await r.sourceAssets.create({
          storageKey: key,
          kind: "image/png",
          metadata,
        });
        await r.sourceAssets.attachToListing(job.draftId, [asset.id]);
      } else if (
        asset.listingId !== job.draftId ||
        asset.kind !== "image/png" ||
        JSON.stringify(asset.metadata) !== JSON.stringify(metadata)
      ) {
        // Metadata field order is not stable in JSONB; compare exact trusted values.
        const m = asset.metadata as Record<string, unknown>;
        if (
          asset.listingId !== job.draftId ||
          asset.kind !== "image/png" ||
          Object.entries(metadata).some(([k, v]) => m?.[k] !== v)
        )
          throw new Error("cutout_identity_mismatch");
      }
      await r.productShots.saveCutout({
        attemptId: job.attemptId,
        leaseToken,
        assetId: asset.id,
      });
    });
  }
  if (row.state === "processing" && row.leaseToken) {
    // Recovery is safe only while the original durable lease can checkpoint.
    if (row.leaseExpiresAt && row.leaseExpiresAt > deps.now()) {
      if (await deps.assetStore.exists(job.workspaceId, key)) {
        try {
          await checkpoint(
            await deps.assetStore.readObject(job.workspaceId, key),
            row.leaseToken,
          );
          return;
        } catch {
          const current = await read();
          if (current?.cutoutAssetId) return;
        }
      }
      throw new ProductShotBusyError(
        Math.max(1, Math.ceil((+row.leaseExpiresAt - +deps.now()) / 1000) + 1),
      );
    }
    // Reconcile only the original lease, including historical selections.
    // A fresh claim would skip replaced attempts and is never needed here.
    try {
      await deps.forWorkspace(job.workspaceId, (r) =>
        r.productShots.finishFailure({
          attemptId: job.attemptId,
          leaseToken: row.leaseToken!,
          code: "outcome_unknown",
          unknown: true,
        }),
      );
    } catch (error) {
      // A checkpoint or another expiry delivery may have won the lease race.
      const current = await read();
      if (
        current &&
        [
          "cutout_ready",
          "candidate_ready",
          "approved",
          "failed",
          "outcome_unknown",
        ].includes(current.state)
      )
        return;
      throw error;
    }
    return;
  }
  if (deps.providerName === "disabled") return;
  const claim = await deps.forWorkspace(job.workspaceId, (r) =>
    r.productShots.claim({
      attemptId: job.attemptId,
      dailyLimit: deps.dailyLimit,
      now: deps.now(),
      estimatedCostUsd: deps.estimatedCostUsd,
    }),
  );
  if (claim.kind === "budget_exhausted") {
    const now = deps.now();
    const nextDay = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    throw new ProductShotBudgetError(
      Math.min(86400, Math.max(1, Math.ceil((nextDay - now.getTime()) / 1000))),
    );
  }
  if (claim.kind !== "claimed") {
    const current = await read();
    if (current?.state === "processing" && current.leaseExpiresAt)
      throw new ProductShotBusyError(
        Math.max(
          1,
          Math.ceil((+current.leaseExpiresAt - +deps.now()) / 1000) + 1,
        ),
      );
    return;
  }
  let dispatched = false;
  try {
    const [source] = await deps.forWorkspace(job.workspaceId, (r) =>
      r.sourceAssets.getByIds([row.sourceAssetId]),
    );
    if (
      !source ||
      source.listingId !== row.listingId ||
      source.workspaceId !== row.workspaceId ||
      !["image/png", "image/jpeg", "image/webp"].includes(source.kind)
    )
      throw new ProductShotProviderError("rejected");
    const head = await deps.assetStore.head(job.workspaceId, source.storageKey);
    if (!head || head.size > PRODUCT_SHOT_LIMITS.inputBytes || head.size < 1)
      throw new ProductShotProviderError("rejected");
    const bytes = await deps.assetStore.readObject(
      job.workspaceId,
      source.storageKey,
    );
    if (
      bytes.length > PRODUCT_SHOT_LIMITS.inputBytes ||
      digest(bytes) !== row.sourceDigest
    )
      throw new ProductShotProviderError("rejected");
    const provider = deps.providerFor(row);
    dispatched = true;
    const result = await provider.generateProductShot({
      assets: [{ id: source.id, mimeType: source.kind, readUrl: "" }],
    });
    validateCutout(result.cutoutPng);
    await deps.assetStore.writeObjectIfAbsent(
      job.workspaceId,
      key,
      result.cutoutPng,
      "image/png",
    );
    await checkpoint(
      await deps.assetStore.readObject(job.workspaceId, key),
      claim.leaseToken,
    );
  } catch (error) {
    // An object may have committed even when storage or DB reported failure.
    if (dispatched) {
      try {
        if (await deps.assetStore.exists(job.workspaceId, key)) {
          await checkpoint(
            await deps.assetStore.readObject(job.workspaceId, key),
            claim.leaseToken,
          );
          return;
        }
      } catch {
        const current = await read();
        if (current?.cutoutAssetId) return;
      }
    }
    const known =
      error instanceof ProductShotProviderError &&
      error.code !== "outcome_unknown";
    await deps.forWorkspace(job.workspaceId, (r) =>
      r.productShots.finishFailure({
        attemptId: job.attemptId,
        leaseToken: claim.leaseToken,
        code:
          error instanceof ProductShotProviderError
            ? error.code
            : "outcome_unknown",
        unknown: dispatched && !known,
      }),
    );
  }
}
