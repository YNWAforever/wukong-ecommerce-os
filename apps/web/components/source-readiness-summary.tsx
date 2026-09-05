import type { SourceReadiness } from "../lib/source-readiness";
const REASONS: Record<string, string> = {
  not_attested: "Eligible after a fresh operator attestation",
  no_remote_link: "No imported SHOPLINE source is linked",
  header_contract_stale: "Imported workbook format is outdated",
  remote_link_changed: "The current SHOPLINE source link changed",
  version_mismatch: "No active version is available",
  approval_receipt_missing: "Approval evidence is missing",
  confirmation_missing: "Reviewed source binding is missing",
  source_changed: "Reviewed source differs from the current import",
};
export function SourceReadinessSummary({
  readiness,
  compact = false,
}: {
  readiness?: SourceReadiness;
  compact?: boolean;
}) {
  if (!readiness)
    return (
      <span className="source-readiness unknown">Source readiness unknown</span>
    );
  const reviewed = readiness.reviewedBinding;
  return (
    <div className={compact ? "source-readiness compact" : "source-readiness"}>
      <strong>
        {readiness.eligibleAfterAttestation
          ? "Source ready for eligibility check"
          : "Source action required"}
      </strong>
      <span>
        {REASONS[readiness.reason] ?? readiness.reason.replaceAll("_", " ")}
      </span>
      {!compact ? (
        <>
          <span>Import: {readiness.sourceImportId ?? "not available"}</span>
          <span>
            Merchant-attested export time:{" "}
            {readiness.merchantAttestedExportAt
              ? new Intl.DateTimeFormat("en-HK", {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: "Asia/Hong_Kong",
                }).format(new Date(readiness.merchantAttestedExportAt))
              : "not available"}
          </span>
          <span>
            Reviewed binding:{" "}
            {reviewed
              ? `revision ${reviewed.revision} · version ${reviewed.versionId}`
              : "not available"}
          </span>
        </>
      ) : null}
      <small>
        Advisory only. Freshness is not attested and SHOPLINE acceptance is
        unverified.
      </small>
    </div>
  );
}
