export type ReviewQualityEvidence = {
  versions: number;
  approved: number;
  elapsedMs: number;
  duplicateApprovals: number;
  invalidApprovals: number;
  edits: readonly unknown[];
};
export function reviewMetricWindow(now: Date) {
  return {
    start: new Date(now.getTime() - 30 * 86400000).toISOString(),
    end: now.toISOString(),
  };
}
function metric(
  numerator: number,
  denominator: number,
  reason: "no_qualified_evidence" | "evidence_limit" | null = null,
) {
  return {
    value: reason || !denominator ? null : numerator / denominator,
    numerator: reason ? null : numerator,
    denominator: reason ? null : denominator,
    reason: reason ?? (denominator ? null : "no_qualified_evidence"),
  };
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** NFC field Hamming distance, linear in bounded retained content. Protected English name is excluded. */
function fields(value: unknown): string[] | null {
  const c = record(value),
    title = record(c.title),
    description = record(c.description),
    seo = record(c.seo),
    st = record(seo.title),
    sd = record(seo.description);
  if (
    !Array.isArray(c.tags) ||
    c.tags.length > 16384 ||
    !c.tags.length ||
    c.tags.some((t) => typeof t !== "string" || t.length > 16384 || !t.trim())
  )
    return null;
  const values = [
    title["zh-Hant"],
    description.en,
    description["zh-Hant"],
    st.en,
    st["zh-Hant"],
    sd.en,
    sd["zh-Hant"],
    c.tags.join(", "),
  ];
  if (
    values.some((v) => typeof v !== "string" || !v.trim() || v.length > 16384)
  )
    return null;
  return (values as string[]).map((v) => v.normalize("NFC"));
}
export function computeReviewMetrics(
  evidence: ReviewQualityEvidence,
  now: Date,
) {
  const window = reviewMetricWindow(now),
    start = Date.parse(window.start),
    end = now.getTime();
  let numerator = 0,
    denominator = 0,
    invalidEdits = 0,
    duplicateEdits = 0;
  const groups = new Map<string, Record<string, unknown>[]>();
  if (evidence.edits.length <= 1000)
    for (const raw of evidence.edits) {
      const row = record(raw);
      if (
        typeof row.listingId !== "string" ||
        typeof row.baseVersionId !== "string" ||
        typeof row.versionId !== "string"
      ) {
        invalidEdits++;
        continue;
      }
      const key = JSON.stringify([
        row.listingId,
        row.baseVersionId,
        row.versionId,
      ]);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
  for (const group of groups.values()) {
    const row = group[0]!;
    // Retries may have new event IDs/times; all pair identity and actor evidence must agree.
    if (
      group.some(
        (r) => r.actorId !== row.actorId || r.createdBy !== row.createdBy,
      )
    ) {
      invalidEdits += group.length;
      continue;
    }
    const before = fields(row.baseContent),
      after = fields(row.content);
    const created = Date.parse(String(row.versionCreatedAt)),
      base = Date.parse(String(row.baseCreatedAt));
    const valid =
      before &&
      after &&
      typeof row.actorId === "string" &&
      row.actorId.length > 0 &&
      row.actorId === row.createdBy &&
      row.pipelineKey == null &&
      Number.isInteger(row.sequence) &&
      Number.isInteger(row.baseSequence) &&
      Number(row.sequence) === Number(row.baseSequence) + 1 &&
      Number.isFinite(base) &&
      base <= created &&
      group.every((r) => {
        const event = Date.parse(String(r.createdAt));
        return (
          Number.isFinite(event) &&
          event >= start &&
          event < end &&
          created <= event
        );
      });
    if (!valid) {
      invalidEdits += group.length;
      continue;
    }
    duplicateEdits += group.length - 1;
    denominator += 8;
    numerator += before!.filter((v, i) => v !== after![i]).length;
  }
  return {
    contractVersion: 1,
    editPopulation: "complete_nonempty_eight_field_pairs" as const,
    window,
    scope: "workspace_retained_evidence" as const,
    approvalFraction: metric(evidence.approved, evidence.versions),
    creationToApprovalMs: metric(evidence.elapsedMs, evidence.approved),
    humanEditedFieldFraction: metric(
      numerator,
      denominator,
      evidence.edits.length > 1000 ? "evidence_limit" : null,
    ),
    exclusions: {
      duplicateApprovals: evidence.duplicateApprovals,
      invalidOrOutsideCohortApprovals: evidence.invalidApprovals,
      invalidEdits: evidence.edits.length > 1000 ? null : invalidEdits,
      duplicateEdits: evidence.edits.length > 1000 ? null : duplicateEdits,
    },
    editEventsObserved: Math.min(evidence.edits.length, 1001),
    editEventLimit: 1000,
  };
}
export type ReviewQualityMetrics = ReturnType<typeof computeReviewMetrics>;
