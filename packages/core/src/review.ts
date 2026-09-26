import type { AuditContext, AuditWriter } from "./audit.js";
import type { ComplianceFlag } from "./compliance.js";
import { transitionListing } from "./workflow.js";
import type { ListingStatus } from "./workflow.js";

export function validateListingApproval(
  versionId: string,
  flags: ComplianceFlag[],
) {
  if (
    flags.some((flag) => flag.severity === "blocking" && flag.status === "open")
  ) {
    throw new Error(
      "Blocking compliance flags must be resolved before approval",
    );
  }
  if (
    flags.some(
      (flag) =>
        flag.severity === "blocking" &&
        flag.status === "resolved" &&
        (typeof flag.resolutionReason !== "string" ||
          flag.resolutionReason.trim().length < 10),
    )
  ) {
    throw new Error(
      "Blocking compliance flags require a meaningful resolution reason before approval",
    );
  }
  return { versionId, status: "approved" as const };
}

export async function approveListing(
  versionId: string,
  flags: ComplianceFlag[],
  auditContext: AuditContext,
  auditWriter: AuditWriter,
) {
  const approved = validateListingApproval(versionId, flags);
  await auditWriter.write({
    ...auditContext,
    action: "listing.approved",
    metadata: { versionId },
  });
  return approved;
}

export async function reopenListing(
  status: ListingStatus,
  auditContext: AuditContext,
  auditWriter: AuditWriter,
): Promise<ListingStatus> {
  return transitionListing(status, "reopen", auditContext, auditWriter);
}
