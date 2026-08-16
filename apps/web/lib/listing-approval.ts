import {
  approveListing as domainApprove,
  type AuditContext,
} from "@wukong/core";

import { ApiError } from "./route-support";

export type ApproveOneDeps = {
  approve?: typeof domainApprove;
};

export type ApproveOneResult = {
  listingId: string;
  versionId: string;
  status: "approved";
};

/**
 * Approves one listing's active version. Extracted from the single-listing
 * approve route so the bulk-approve route can reuse the exact same checks —
 * `requireForPublish`, the target/activeVersion gate, the domain approval
 * call, the repository write, and the blocking-flags error mapping — without
 * duplicating them. Behavior for a single ID must stay identical to what
 * `POST /api/listings/[id]/approve` did before this extraction; that route's
 * own existing test file is the proof.
 */
export async function approveOne(
  id: string,
  auditContext: AuditContext,
  repositories: any,
  deps: ApproveOneDeps = {},
): Promise<ApproveOneResult> {
  let listing: any;
  try {
    listing = await repositories.listings.requireForPublish(id);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      throw new ApiError(404, "listing_not_found", "Listing not found.");
    }
    throw error;
  }
  if (listing.target !== "shopline" || !listing.activeVersion) {
    throw new ApiError(409, "approval_required", "可批准的版本不存在。");
  }
  try {
    const approved = await (deps.approve ?? domainApprove)(
      listing.activeVersion.id,
      listing.flags,
      auditContext,
      repositories.audit,
    );
    if (typeof repositories.listings.approve !== "function")
      throw new Error("listing approval repository is unavailable");
    await repositories.listings.approve(
      id,
      approved.versionId,
      auditContext,
      repositories.audit,
    );
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
