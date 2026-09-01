import {
  approveListing as domainApprove,
  assertApprovalFreshness,
  type AuditContext,
  type CanonicalListing,
} from "@wukong/core";
import type {
  AuditWriter,
  ListingRepository,
  PlatformProductRepository,
  ReviewConfirmationRepository,
  SourceAssetRepository,
} from "@wukong/db";

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
  /**
   * When supplied, `approveOne` re-asserts that the version it is about to
   * approve is still the one the caller validated (confirmation checklist,
   * source-freshness check, etc.) — not just whatever happens to be active
   * by the time this function's own `getReviewSnapshot` read runs.
   *
   * `POST /api/listings/[id]/approve` reads and validates a snapshot in its
   * own earlier, separate `forWorkspace` call (its "phase 0"), then this
   * function reads a second, fresh snapshot in its own transaction. Without
   * this check, a concurrent edit landing between those two reads (e.g. a
   * `PUT /api/listings/[id]/review` promoting a new version) would make
   * `approveOne` silently approve that new version instead — one with no
   * confirmation-ledger row and no freshness check against it. Optional
   * because bulk-approve (`POST /api/listings/bulk-approve`) has no
   * client-held "version I reviewed" to pin against; it intentionally
   * approves whatever is currently active.
   */
  expectedVersionId?: string;
  /**
   * When supplied, `approveOne` re-reads `reviewConfirmations.getByVersionId`
   * inside its own transaction and re-verifies both that the revision still
   * matches and that the checklist is still fully confirmed -- not just that
   * phase 0 (the route's separate, earlier `forWorkspace` call) saw a
   * matching, complete checklist. `expectedVersionId` staying the same does
   * NOT imply this is still true: `PATCH
   * /api/listings/[id]/review-confirmations` bumps the ledger's revision for
   * the *same* version without ever calling `appendVersion`, so a second
   * reviewer can edit the checklist for the version being approved without
   * the active version changing at all. Optional for the same reason as
   * `expectedVersionId` -- bulk-approve has no client-held ledger revision to
   * pin against.
   */
  confirmationLedgerRevision?: number;
  /**
   * When `expectedVersionId` is supplied (bulk-approve never supplies it;
   * see that field's doc), `approveOne` re-reads `platformProducts
   * .getByListingId` inside its own transaction and re-derives whether the
   * freshness gate applies at all (`link !== null && link.origin ===
   * "import"`) -- it does NOT gate that re-derivation on whether this or
   * `expectedRowDigest` were supplied. That matters because gate
   * *applicability* itself can go stale, not just the values it checks once
   * it applies: a create-origin listing's `platform_products` row can flip
   * to `origin: "import"` via a concurrent catalog re-import matching the
   * same connection/remote-product id (`bulk-form-import.ts`'s "existing
   * link" refresh branch), without ever calling `appendVersion` -- so phase 0
   * (the route's earlier, separate `forWorkspace` call) correctly saw no
   * gate and the client never sent these fields, yet the gate now applies by
   * commit time. If the freshly re-read link says the gate applies but
   * this/`expectedRowDigest` are `undefined`, `approveOne` throws the same
   * `400 source_freshness_required` phase 0 would have. If the gate applies
   * and both are supplied, it re-runs `assertApprovalFreshness` against the
   * freshly-read link -- not just trusting phase 0's earlier read of
   * *values*, either: a concurrent re-import can also just update
   * `contentDigest`/`sourceImportId` on a link that was already `origin:
   * "import"` (`upsertMany`'s `onConflictDoUpdate`), again without calling
   * `appendVersion`. Per the design doc, "the content freshness check still
   * runs at approval time regardless of when the confirmation itself was
   * recorded" -- this is what makes that true in full, not just for the
   * values but for the gate itself.
   */
  sourceImportId?: string;
  /** Paired with `sourceImportId`; see that field's doc. */
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

/**
 * Approves one listing's active version. Extracted from the single-listing
 * approve route so the bulk-approve route can reuse the exact same checks —
 * `getReviewSnapshot`, the target/activeVersion gate, the domain approval
 * call, the repository write, and the blocking-flags error mapping — without
 * duplicating them. Behavior for a single ID must stay identical to what
 * `POST /api/listings/[id]/approve` did before this extraction; that route's
 * own existing test file is the proof.
 *
 * When `deps.precomputedFinalAsset` is supplied, the route handler has
 * already flattened a chosen background onto a cutout asset (outside any
 * transaction) and stored the result. This function persists that asset,
 * appends it as a new listing version carrying the prior version's
 * evidence/flags, and promotes+approves that new version via
 * `promoteAndApprove` instead of the existing active version. Bulk approve
 * never supplies this, and today no real listing has a cutout asset, so this
 * branch is presently a no-op for every real approval.
 *
 * When `deps.expectedVersionId`/`confirmationLedgerRevision`/
 * `sourceImportId`+`expectedRowDigest` are supplied, this function re-checks
 * each of them against a fresh read taken inside its own transaction, rather
 * than trusting whatever an earlier, separate read (the approve route's own
 * "phase 0" pre-check) already validated. This is what actually closes the
 * race window between that earlier read and this function's write: the
 * active version, the confirmation ledger, and the linked product's content
 * digest can each go stale independently of one another, since a checklist
 * edit or a catalog re-import updates its own row without ever calling
 * `appendVersion`. The earlier, separate read exists only to fail fast
 * before the (potentially expensive) product-shot I/O above runs -- this
 * function's own re-checks are the actual source of truth.
 */
export async function approveOne(
  id: string,
  auditContext: AuditContext,
  repositories: ApproveOneRepositories,
  deps: ApproveOneDeps = {},
): Promise<ApproveOneResult> {
  const snapshot = await repositories.listings.getReviewSnapshot(id);
  if (!snapshot) {
    throw new ApiError(404, "listing_not_found", "Listing not found.");
  }
  if (snapshot.listing.target !== "shopline" || !snapshot.activeVersion) {
    throw new ApiError(409, "approval_required", "可批准的版本不存在。");
  }
  if (
    deps.expectedVersionId !== undefined &&
    snapshot.activeVersion.id !== deps.expectedVersionId
  ) {
    throw new ApiError(
      409,
      "version_conflict",
      "This listing has changed since you started reviewing it.",
    );
  }

  if (deps.confirmationLedgerRevision !== undefined) {
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
  }

  // Re-derive whether the freshness gate applies at all from a fresh read --
  // NOT gated on `deps.sourceImportId`/`expectedRowDigest` being supplied.
  // Those two only reflect what the CLIENT saw when phase 0 (the route's
  // earlier, separate `forWorkspace` call) ran, which can itself be stale by
  // commit time: a create-origin listing's `platform_products` row can flip
  // to `origin: "import"` via a concurrent catalog re-import matching the
  // same connection/remote-product id (`bulk-form-import.ts`'s "existing
  // link" refresh branch), without ever calling `appendVersion` -- so the
  // client never had freshness fields to send, yet the gate now applies.
  // Trusting `deps.sourceImportId !== undefined` here would silently skip
  // the check for exactly that listing.
  //
  // Gated on `deps.expectedVersionId !== undefined` instead -- the same
  // signal the version-conflict check above uses -- because that is the
  // caller's actual, stable opt-in for "run full phase-3 re-validation",
  // supplied by the route handler itself rather than derived from anything
  // that can go stale. Bulk approve never supplies `expectedVersionId` (it
  // has no client-held review state to pin against at all, the same
  // reasoning documented on `confirmationLedgerRevision` above) and so never
  // re-derives this gate -- re-deriving it unconditionally for every
  // `approveOne` caller would make bulk approve start 400-ing on every
  // import-origin listing, which is out of this task's scope and would be a
  // new regression, not a fix.
  if (deps.expectedVersionId !== undefined) {
    const link = await repositories.platformProducts.getByListingId(id);
    if (link !== null && link.origin === "import") {
      if (
        deps.sourceImportId === undefined ||
        deps.expectedRowDigest === undefined
      ) {
        throw new ApiError(
          400,
          "source_freshness_required",
          "This listing is linked to an imported product and requires freshness fields.",
        );
      }
      const activeVersionId = snapshot.activeVersion.id;
      const result = await assertApprovalFreshness(
        {
          workspaceId: auditContext.workspaceId,
          listingId: id,
          expectedSourceImportId: deps.sourceImportId,
          expectedRowDigest: deps.expectedRowDigest,
          expectedVersionId: activeVersionId,
        },
        {
          async getPlatformProductLink() {
            return link;
          },
          async getActiveVersionId() {
            return activeVersionId;
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
    }
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
