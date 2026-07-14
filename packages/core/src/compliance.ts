import type { AuditContext, AuditWriter } from "./audit.js";

type ComplianceFlagFields = {
  id: string;
  field: string;
  rule:
    | "health_claim"
    | "guarantee"
    | "rating_without_evidence"
    | "superlative";
  severity: "blocking" | "warning";
};

export type ComplianceFlag = ComplianceFlagFields &
  (
    | { status: "open"; resolutionReason: null }
    | { status: "resolved"; resolutionReason: string }
  );

const blockingPatterns = [
  { rule: "health_claim" as const, pattern: /health benefit|治療|保健功效/i },
  { rule: "guarantee" as const, pattern: /guaranteed|保證/i }
];

export function scanCompliance(
  fields: Record<string, string>
): ComplianceFlag[] {
  return Object.entries(fields).flatMap(([field, value]) =>
    blockingPatterns
      .filter(({ pattern }) => pattern.test(value))
      .map(({ rule }, index) => ({
        id: `${field}:${rule}:${index}`,
        field,
        rule,
        severity: "blocking" as const,
        status: "open" as const,
        resolutionReason: null
      }))
  );
}

export async function resolveFlag(
  flag: ComplianceFlag,
  reason: string,
  auditContext: AuditContext,
  auditWriter: AuditWriter
): Promise<ComplianceFlag> {
  const resolutionReason = reason.trim();
  if (resolutionReason.length < 10) {
    throw new Error("A meaningful resolution reason is required");
  }
  const resolved: ComplianceFlag = {
    ...flag,
    status: "resolved",
    resolutionReason
  };
  await auditWriter.write({
    ...auditContext,
    action: "compliance.flag_resolved",
    metadata: {
      flagId: flag.id,
      field: flag.field,
      rule: flag.rule,
      resolutionReason
    }
  });
  return resolved;
}
