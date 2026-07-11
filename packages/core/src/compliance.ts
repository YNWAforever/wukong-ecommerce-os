export type ComplianceFlag = {
  id: string;
  field: string;
  rule:
    | "health_claim"
    | "guarantee"
    | "rating_without_evidence"
    | "superlative";
  severity: "blocking" | "warning";
  status: "open" | "resolved";
  resolutionReason: string | null;
};

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

export function resolveFlag(
  flag: ComplianceFlag,
  reason: string
): ComplianceFlag {
  if (reason.trim().length < 10) {
    throw new Error("A meaningful resolution reason is required");
  }
  return { ...flag, status: "resolved", resolutionReason: reason.trim() };
}
