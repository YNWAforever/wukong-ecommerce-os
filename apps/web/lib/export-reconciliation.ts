import type { ExportAttempt, ImportResult } from "@wukong/db";
export type ResultCapabilities = {
  canGenerateBulkUpdate: boolean;
  canRecordImportResult: boolean;
};
export function resultCapabilities(role: string): ResultCapabilities {
  return {
    canGenerateBulkUpdate: ["reviewer", "admin", "owner"].includes(role),
    canRecordImportResult: ["operator", "reviewer", "admin", "owner"].includes(
      role,
    ),
  };
}
export function buildExportReconciliation(
  attempt: ExportAttempt,
  results: readonly ImportResult[],
) {
  const members = attempt.manifest.map((member) => {
    const history =
      member.outcome === "included"
        ? results
            .filter(
              (r) =>
                r.mode === "export" &&
                r.exportAttemptId === attempt.id &&
                r.listingId === member.listingId &&
                r.versionId === member.versionId,
            )
            .sort((a, b) => b.revision - a.revision)
        : [];
    return { ...member, latestResult: history[0] ?? null, history };
  });
  const included = members.filter((m) => m.outcome === "included");
  const accepted = included.filter(
    (m) => m.latestResult?.outcome === "accepted",
  ).length;
  const rejected = included.filter(
    (m) => m.latestResult?.outcome === "rejected",
  ).length;
  const noOp = members.filter((m) => m.outcome === "excluded_no_op").length;
  return {
    counts: {
      requested: members.length,
      included: included.length,
      excluded: members.length - included.length - noOp,
      noOp,
      accepted,
      rejected,
      unreported: included.length - accepted - rejected,
    },
    members,
    verificationStatus: "unverified" as const,
  };
}
export type ExportReconciliation = ReturnType<typeof buildExportReconciliation>;
export type ExportReconciliationDetail = {
  attempt: ExportAttempt;
  reconciliation: ExportReconciliation;
};
