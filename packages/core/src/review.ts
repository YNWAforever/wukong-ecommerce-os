import type { ComplianceFlag } from "./compliance.js";
import { transitionListing } from "./workflow.js";
import type { ListingStatus } from "./workflow.js";

export function approveListing(versionId: string, flags: ComplianceFlag[]) {
  if (
    flags.some(
      (flag) => flag.severity === "blocking" && flag.status === "open"
    )
  ) {
    throw new Error(
      "Blocking compliance flags must be resolved before approval"
    );
  }
  return { versionId, status: "approved" as const };
}

export function reopenListing(status: ListingStatus): ListingStatus {
  return transitionListing(status, "reopen");
}
