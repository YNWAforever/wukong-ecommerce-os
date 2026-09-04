import {
  approveListing as domainApprove,
  assertApprovalFreshness,
  type AuditContext,
  type CanonicalListing,
} from "@wukong/core";
import type {
  AuditWriter,
  SourceRowRepository,
  SourceRowSnapshot,
  ApprovalReceiptRepository,
  ListingRepository,
  PlatformProductRepository,
  ReviewConfirmationRepository,
  SourceAssetRepository,
} from "@wukong/db";

import {
  hashBulkFormRow,
  hashBulkFormHeaderContract,
  isBulkFormRawRow,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
} from "@wukong/shopline";

import { allConfirmed } from "./review-confirmation-keys";
import { ApiError } from "./route-support";

/**
 * The narrow slice of the workspace repositories `approveOne` and
 * `findProductShotAssets` actually use, typed against the real
 * `@wukong/db` repository interfaces instead of `any` — so a signature
 * drift in either interface fails `tsc --noEmit` here instead of passing
 * silently. Callers (both approve routes) still receive an untyped
 * `repositories` from their shared `forWorkspace` callback, matching every
 * other route in this codebase; `any` is freely assignable to this type, so
 * that's not a barrier to calling these functions from there.
 */
export type ApproveOneRepositories = {
  listings: Pick<
    ListingRepository,
    | "lockReviewState"
    | "getReviewSnapshot"
    | "approve"
    | "promoteAndApprove"
    | "appendVersion"
    | "replaceEvidence"
    | "replaceFlags"
  >;
  sourceAssets: Pick<
    SourceAssetRepository,
    "listForListing" | "create" | "attachToListing"
  >;
  reviewConfirmations: Pick<ReviewConfirmationRepository, "getByVersionId">;
  platformProducts: Pick<PlatformProductRepository, "getByListingId">;
  sourceRows: Pick<SourceRowRepository, "getForProduct">;
  approvalReceipts: Pick<ApprovalReceiptRepository, "record">;
  audit: AuditWriter;
};

export type ApproveOneAssetStore = {
  readObject(workspaceId: string, key: string): Promise<Uint8Array>;
  writeObject(
    workspaceId: string,
    key: string,
    body: Uint8Array,
    mimeType: string,
  ): Promise<{ size: number; mimeType: string }>;
  createAssetKey(input: {
    workspaceId: string;
    fileName: string;
    mimeType: string;
    size: number;
  }): string;
};

export type ApproveOneDeps = {
  approve?: typeof domainApprove;
  /** The version and checklist revision observed by the reviewer. Never default to current state. */
  expectedVersionId: string;
  confirmationLedgerRevision: number;
  /** Required whenever the current platform link has import origin. */
  sourceImportId?: string;
  expectedRowDigest?: string;
  /**
   * Set by the route handler once it has already flattened a chosen
   * background onto a cutout and stored the result. `approveOne` itself
   * never does that I/O (no `AssetStore`, no `flattenProductShot`) — it only
   * persists the already-produced asset. This function runs inside a Postgres
   * transaction (the `forWorkspace` callback), so any slow external round
   * trip (S3 GET, a CPU-bound `sharp` composite, S3 PUT) must happen in the
   * route handler BEFORE that transaction opens, never inside it — the same
   * rule already applied to the worker pipeline's own flatten step (see
   * `apps/worker/src/listing-pipeline.ts`, the `productShotOutcome` block).
   */
  precomputedFinalAsset?: {
    storageKey: string;
    /**
     * Ids of `product_shot_final` assets already on this listing from a
     * prior approval. Filtered out of the new version's `imageAssetIds` so
     * re-approving with a different background replaces the old composite
     * instead of accumulating every previously-superseded one alongside it.
     */
    priorFinalAssetIds: string[];
  };
};

export type ApproveOneResult = {
  listingId: string;
  versionId: string;
  status: "approved";
};

/**
 * Finds a listing's `product_shot_cutout` source asset (if any) and the ids
 * of any `product_shot_final` assets already attached to it from a prior
 * approval, from a single `listForListing` read. Called by the approve route
 * handler as a short, read-only lookup — before it decides whether to do the
 * (non-transactional) flatten I/O — so the result also feeds
 * `ApproveOneDeps.precomputedFinalAsset.priorFinalAssetIds` when a new
 * composite is produced.
 */
export async function findProductShotAssets(
  id: string,
  repositories: Pick<ApproveOneRepositories, "sourceAssets">,
): Promise<{
  cutout: { storageKey: string } | null;
  priorFinalAssetIds: string[];
}> {
  const assets = await repositories.sourceAssets.listForListing(id);
  const cutout =
    assets.find(
      (asset) =>
        asset.kind === "image/png" &&
        (asset.metadata as Record<string, unknown> | null)?.role ===
          "product_shot_cutout",
    ) ?? null;
  const priorFinalAssetIds = assets
    .filter(
      (asset) =>
        (asset.metadata as Record<string, unknown> | null)?.role ===
        "product_shot_final",
    )
    .map((asset) => asset.id);
  return { cutout, priorFinalAssetIds };
}

/** Validate the current imported row against the immutable source snapshot. */
export async function readApprovalSourceSnapshot(
  listingId: string,
  link: {
    sourceImportId: string | null;
    connectionId: string;
    remoteProductId: string;
    contentDigest: string | null;
    rawRow: Record<string, string | null> | null;
  },
  repositories: Pick<ApproveOneRepositories, "sourceRows">,
): Promise<SourceRowSnapshot | null> {
  if (
    !link.sourceImportId ||
    !link.contentDigest ||
    !link.rawRow ||
    !isBulkFormRawRow(link.rawRow)
  )
    return null;
  const row = await repositories.sourceRows.getForProduct({
    sourceImportId: link.sourceImportId,
    connectionId: link.connectionId,
    remoteProductId: link.remoteProductId,
  });
  if (
    !row ||
    row.listingId !== listingId ||
    row.sourceImportId !== link.sourceImportId ||
    row.connectionId !== link.connectionId ||
    row.remoteProductId !== link.remoteProductId ||
    row.sourceRowDigest !== link.contentDigest ||
    row.headerContractSha256 !== hashBulkFormHeaderContract() ||
    row.specVersion !== SHOPLINE_BULK_FORM_SPEC_VERSION ||
    !isBulkFormRawRow(row.rawRow) ||
    hashBulkFormRow(row.rawRow) !== row.sourceRowDigest ||
    hashBulkFormRow(link.rawRow) !== row.sourceRowDigest
  )
    return null;
  return row;
}

/**
 * Both approval routes validate the reviewer's observed version, checklist and
 * imported source here, inside their workspace transaction. The single route's
 * earlier checks only fail fast before optional product-shot I/O.
 *
 * A precomputed final asset is persisted as a new version carrying the reviewed
 * evidence and flags, then promoted through the existing approval repository.
 * Asset reads, compositing and object writes remain outside this transaction.
 *
 * The draft lock serializes flag, confirmation and source writes through the
 * database review-lock triggers. Imported approvals append an immutable receipt.
 */
export async function approveOne(
  id: string,
  auditContext: AuditContext,
  repositories: ApproveOneRepositories,
  deps: ApproveOneDeps,
): Promise<ApproveOneResult> {
  if (
    !deps?.expectedVersionId ||
    !Number.isInteger(deps.confirmationLedgerRevision) ||
    deps.confirmationLedgerRevision < 0
  ) {
    throw new ApiError(
      400,
      "review_context_required",
      "Open the listing and complete its review before approving.",
    );
  }
  await repositories.listings.lockReviewState(id);
  const snapshot = await repositories.listings.getReviewSnapshot(id);
  if (!snapshot) {
    throw new ApiError(404, "listing_not_found", "Listing not found.");
  }
  if (snapshot.listing.target !== "shopline" || !snapshot.activeVersion) {
    throw new ApiError(409, "approval_required", "可批准的版本不存在。");
  }
  if (
    snapshot.activeVersion.id !== deps.expectedVersionId ||
    snapshot.listing.activeVersionId !== snapshot.activeVersion.id
  ) {
    throw new ApiError(
      409,
      "version_conflict",
      "This listing has changed since you started reviewing it.",
    );
  }

  const confirmation = await repositories.reviewConfirmations.getByVersionId(
    snapshot.activeVersion.id,
  );
  if ((confirmation?.revision ?? -1) !== deps.confirmationLedgerRevision) {
    throw new ApiError(
      409,
      "confirmation_ledger_stale",
      "The confirmation checklist has changed since you loaded it.",
    );
  }
  if (
    !confirmation ||
    !allConfirmed(
      confirmation.fieldConfirmations,
      confirmation.negativeConfirmations,
    )
  ) {
    throw new ApiError(
      422,
      "confirmation_incomplete",
      "Complete the confirmation checklist before approving.",
    );
  }

  // Re-import can change origin/source without creating a listing version.
  // Re-derive applicability in the approval transaction for every caller.
  const link = await repositories.platformProducts.getByListingId(id);
  if (
    link?.origin !== "import" &&
    (deps.sourceImportId !== undefined ||
      deps.expectedRowDigest !== undefined ||
      confirmation.sourceImportId != null ||
      confirmation.rowDigest != null)
  ) {
    throw new ApiError(
      409,
      "source_origin_changed",
      "This listing's imported source link has changed. Review the listing again.",
    );
  }
  if (link !== null && link.origin === "import") {
    if (!deps.sourceImportId || !deps.expectedRowDigest) {
      throw new ApiError(
        400,
        "source_freshness_required",
        "This listing is linked to an imported product and requires freshness fields.",
      );
    }
    const result = await assertApprovalFreshness(
      {
        workspaceId: auditContext.workspaceId,
        listingId: id,
        expectedSourceImportId: deps.sourceImportId,
        expectedRowDigest: deps.expectedRowDigest,
        expectedVersionId: deps.expectedVersionId,
      },
      {
        async getPlatformProductLink() {
          return link;
        },
        async getActiveVersionId() {
          return snapshot.activeVersion?.id ?? null;
        },
      },
    );
    if (!result.ok) {
      throw new ApiError(
        409,
        result.reason,
        "This listing's source data no longer matches what was reviewed.",
      );
    }
    if (
      confirmation.sourceImportId !== deps.sourceImportId ||
      confirmation.rowDigest !== deps.expectedRowDigest
    ) {
      throw new ApiError(
        409,
        "confirmation_source_stale",
        "The confirmation checklist belongs to different source data. Review the listing again.",
      );
    }
  }

  const sourceRow =
    link?.origin === "import"
      ? await readApprovalSourceSnapshot(id, link, repositories)
      : null;
  if (link?.origin === "import" && !sourceRow) {
    throw new ApiError(
      409,
      "source_snapshot_required",
      "Reimport this product before approving; its source snapshot is unavailable or has changed.",
    );
  }

  let versionIdToApprove: string = snapshot.activeVersion.id;

  if (deps.precomputedFinalAsset) {
    const { storageKey, priorFinalAssetIds } = deps.precomputedFinalAsset;
    const finalAsset = await repositories.sourceAssets.create({
      storageKey,
      kind: "image/png",
      metadata: { role: "product_shot_final", listingId: id },
    });
    await repositories.sourceAssets.attachToListing(id, [finalAsset.id]);
    // Every domain mutation writes an audit event -- `sourceAssets.create`/
    // `attachToListing` don't write one themselves (mirrors the same
    // create+attach+audit sequence in `apps/worker/src/listing-pipeline.ts`
    // for the `product_shot_cutout` asset, and `asset.finalized` in
    // `apps/web/app/api/assets/finalize/route.ts`).
    await repositories.audit.write({
      ...auditContext,
      action: "asset.product_shot_final_created",
      metadata: { assetId: finalAsset.id, storageKey },
    });
    // getReviewSnapshot's content is only as complete as review has gotten
    // so far (see ReviewableListing) -- this cast preserves this function's
    // prior behavior of trusting it's publish-ready, not a new guarantee.
    // Nothing here re-validates completeness; requireForPublish still does,
    // at actual delivery time.
    const newContent = {
      ...snapshot.activeVersion.content,
      imageAssetIds: [
        ...snapshot.activeVersion.content.imageAssetIds.filter(
          (assetId: string) => !priorFinalAssetIds.includes(assetId),
        ),
        finalAsset.id,
      ],
    } as CanonicalListing;
    const newVersion = await repositories.listings.appendVersion(
      id,
      newContent,
      auditContext,
      repositories.audit,
    );
    await repositories.listings.replaceEvidence(
      newVersion.id,
      snapshot.evidence,
    );
    await repositories.listings.replaceFlags(newVersion.id, snapshot.flags);
    versionIdToApprove = newVersion.id;
  }

  try {
    const approved = await (deps.approve ?? domainApprove)(
      versionIdToApprove,
      snapshot.flags,
      auditContext,
      repositories.audit,
    );
    if (versionIdToApprove === snapshot.activeVersion.id) {
      if (typeof repositories.listings.approve !== "function")
        throw new Error("listing approval repository is unavailable");
      await repositories.listings.approve(
        id,
        approved.versionId,
        auditContext,
        repositories.audit,
      );
    } else {
      if (typeof repositories.listings.promoteAndApprove !== "function")
        throw new Error("listing approval repository is unavailable");
      await repositories.listings.promoteAndApprove(
        id,
        snapshot.activeVersion.id,
        approved.versionId,
        auditContext,
        repositories.audit,
      );
    }
    if (sourceRow) {
      const receipt = await repositories.approvalReceipts.record({
        listingId: id,
        versionId: approved.versionId,
        sourceSnapshotId: sourceRow.id,
        confirmationVersionId: snapshot.activeVersion.id,
        confirmationRevision: confirmation.revision,
        approvedBy: auditContext.actorId,
      });
      if (receipt.wasCreated)
        await repositories.audit.write({
          ...auditContext,
          action: "listing.bulk_update_approval_bound",
          metadata: {
            approvalReceiptId: receipt.id,
            sourceSnapshotId: sourceRow.id,
            versionId: approved.versionId,
            confirmationRevision: confirmation.revision,
          },
        });
    }
    return {
      listingId: id,
      versionId: approved.versionId,
      status: approved.status as "approved",
    };
  } catch (error) {
    if (
      error instanceof Error &&
      /blocking compliance flags/i.test(error.message)
    ) {
      throw new ApiError(
        422,
        "blocking_flags",
        "仍有未解決的合規標記，請先處理。",
      );
    }
    throw error;
  }
}
