import type { AuditContext, AuditWriter } from "./audit.js";

export type ListingStatus =
  | "received"
  | "processing"
  | "needs_info"
  | "in_review"
  | "approved"
  | "reopened"
  | "publishing"
  | "published"
  | "publish_failed"
  | "failed";

export type ListingAction =
  | "start_processing"
  | "request_info"
  | "submit_review"
  | "approve"
  | "reopen"
  | "begin_publish"
  | "publish_succeeded"
  | "publish_failed"
  | "fail"
  | "retry";

const transitions: Record<
  ListingStatus,
  Partial<Record<ListingAction, ListingStatus>>
> = {
  received: { start_processing: "processing" },
  processing: {
    request_info: "needs_info",
    submit_review: "in_review",
    fail: "failed"
  },
  needs_info: { start_processing: "processing" },
  in_review: { approve: "approved" },
  approved: { reopen: "reopened", begin_publish: "publishing" },
  reopened: { submit_review: "in_review" },
  publishing: {
    publish_succeeded: "published",
    publish_failed: "publish_failed"
  },
  published: { reopen: "reopened" },
  publish_failed: { retry: "publishing", reopen: "reopened" },
  failed: { retry: "processing" }
};

function getNextListingStatus(
  status: ListingStatus,
  action: ListingAction
): ListingStatus {
  const next = transitions[status][action];
  if (!next) throw new Error(`Illegal transition: ${status} -> ${action}`);
  return next;
}

export async function transitionListing(
  status: ListingStatus,
  action: ListingAction,
  auditContext: AuditContext,
  auditWriter: AuditWriter
): Promise<ListingStatus> {
  const next = getNextListingStatus(status, action);
  await auditWriter.write({
    ...auditContext,
    action: "listing.transition",
    metadata: { fromStatus: status, action, toStatus: next }
  });
  return next;
}
