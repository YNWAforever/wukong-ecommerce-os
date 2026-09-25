import {
  CHECK_IDS,
  prepareVerification,
  verificationResultSchema,
  type CheckId,
  type ListingVerifier,
  type VerificationInput,
} from "./listing-verification.js";

export type EvaluationCase = {
  id: string;
  split: "development" | "holdout";
  category: "valid" | "unsupported" | "contradiction" | "translation";
  input: VerificationInput;
  labels: Partial<Record<CheckId, boolean>>;
};
export type EvaluationOptions = { maxRequests: number; budgetUsd: number };
export function confusion(
  rows: Array<{ label: boolean; probability: number }>,
  threshold: number,
) {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  for (const row of rows) {
    const predicted = row.probability >= threshold;
    if (predicted && row.label) tp++;
    else if (predicted) fp++;
    else if (row.label) fn++;
    else tn++;
  }
  return {
    tp,
    fp,
    tn,
    fn,
    falseAlarmRate: fp + tn ? fp / (fp + tn) : null,
    missedErrorRate: fn + tp ? fn / (fn + tp) : null,
  };
}
export function validateEvaluationOptions(options: EvaluationOptions) {
  if (
    !Number.isSafeInteger(options.maxRequests) ||
    options.maxRequests <= 0 ||
    !Number.isFinite(options.budgetUsd) ||
    options.budgetUsd <= 0
  )
    throw new Error("Evaluation requires positive request and budget limits.");
}
function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[
    Math.ceil(values.length * fraction) - 1
  ]!;
}
// These are provider metadata identifiers, never arbitrary provider strings.
function safeIdentifier(value: string | null) {
  return value !== null && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value)
    ? value
    : null;
}
export async function evaluateVerificationCases(
  cases: EvaluationCase[],
  verifier: ListingVerifier,
  options: EvaluationOptions,
) {
  validateEvaluationOptions(options);
  if (
    new Set(cases.map((c) => c.id)).size !== cases.length ||
    cases.some((c) => prepareVerification(c.input).reason !== null)
  )
    throw new Error("Evaluation fixtures must be unique and valid.");
  const rows: Array<{
    id: string;
    split: EvaluationCase["split"];
    check: CheckId;
    language: string;
    label: boolean;
    probability: number;
  }> = [];
  const results: Array<{
    id: string;
    outcome: "completed" | "skipped" | "unavailable";
    reason: string | null;
    requestedModel: string | null;
    actualModel: string | null;
    pricingVersion: string | null;
    estimatedCostUsd: number | null;
    latencyMs: number;
    requestAttempted: boolean;
  }> = [];
  const counts = new Map<
    string,
    { insufficient: number; unavailable: number; skipped: number }
  >();
  const language = (check: CheckId) =>
    check === "unsupported_en"
      ? "en"
      : check === "unsupported_zh"
        ? "zh-Hant"
        : "bilingual";
  let requests = 0,
    knownEstimatedCostUsd = 0,
    unknownAttemptedCostCount = 0;
  let stopReason:
    "complete" | "request_cap" | "observed_spend_cap" | "unknown_cost" =
    "complete";
  for (const fixture of cases) {
    if (requests >= options.maxRequests) {
      stopReason = "request_cap";
      break;
    }
    if (knownEstimatedCostUsd >= options.budgetUsd) {
      stopReason = "observed_spend_cap";
      break;
    }
    const result = verificationResultSchema.parse(
      await verifier.verify(fixture.input),
    );
    const { usage } = result;
    if (usage.requestAttempted) requests++;
    if (usage.estimatedCostUsd !== null)
      knownEstimatedCostUsd += usage.estimatedCostUsd;
    else if (usage.requestAttempted) unknownAttemptedCostCount++;
    results.push({
      id: fixture.id,
      outcome: result.outcome,
      reason: result.reason,
      requestedModel: safeIdentifier(result.requestedModel),
      actualModel: safeIdentifier(result.actualModel),
      pricingVersion: safeIdentifier(usage.pricingVersion),
      estimatedCostUsd: usage.estimatedCostUsd,
      latencyMs: usage.latencyMs,
      requestAttempted: usage.requestAttempted,
    });
    for (const check of CHECK_IDS) {
      const label = fixture.labels[check];
      if (label === undefined) continue;
      const key = `${fixture.split}:${check}`;
      const count = counts.get(key) ?? {
        insufficient: 0,
        unavailable: 0,
        skipped: 0,
      };
      counts.set(key, count);
      if (result.outcome === "unavailable") count.unavailable++;
      else if (result.outcome === "skipped") count.skipped++;
      else {
        const assessment = result.checks.find((c) => c.id === check)!;
        if (assessment.assessment === "insufficient_evidence")
          count.insufficient++;
        else
          rows.push({
            id: fixture.id,
            split: fixture.split,
            check,
            language: language(check),
            label,
            probability: assessment.probability,
          });
      }
    }
    if (usage.requestAttempted && usage.estimatedCostUsd === null) {
      stopReason = "unknown_cost";
      break;
    }
  }
  const groups = (["development", "holdout"] as const).flatMap((split) =>
    CHECK_IDS.map((check) => {
      const labelled = cases.filter(
        (c) => c.split === split && c.labels[check] !== undefined,
      ).length;
      const values = rows.filter(
        (row) => row.split === split && row.check === check,
      );
      const count = counts.get(`${split}:${check}`) ?? {
        insufficient: 0,
        unavailable: 0,
        skipped: 0,
      };
      return {
        split,
        check,
        language: language(check),
        labelled,
        assessed: values.length,
        coverage: labelled ? values.length / labelled : null,
        ...count,
        notRun:
          labelled -
          values.length -
          count.insufficient -
          count.unavailable -
          count.skipped,
        thresholds: {
          exploratory_0_25: confusion(values, 0.25),
          exploratory_0_5: confusion(values, 0.5),
          exploratory_0_75: confusion(values, 0.75),
        },
      };
    }),
  );
  const unique = (values: Array<string | null>) => [
    ...new Set(values.filter((v): v is string => v !== null)),
  ];
  return {
    dryRun: false,
    cases: cases.length,
    holdout: cases.filter((c) => c.split === "holdout").length,
    requests,
    evaluated: results.length,
    notRun: cases.length - results.length,
    stopReason,
    unavailable: results.filter((r) => r.outcome === "unavailable").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    knownEstimatedCostUsd,
    unknownAttemptedCostCount,
    latencyMs: {
      p50: percentile(
        results.map((r) => r.latencyMs),
        0.5,
      ),
      p95: percentile(
        results.map((r) => r.latencyMs),
        0.95,
      ),
    },
    requestedModels: unique(results.map((r) => r.requestedModel)),
    actualModels: unique(results.map((r) => r.actualModel)),
    pricingVersions: unique(results.map((r) => r.pricingVersion)),
    billingNotice:
      "Observed spend is not a strict billing cap: the last or in-flight call can exceed it.",
    languageNotice:
      "Only unsupported checks are language-specific; identity and translation checks combine both languages and cannot be attributed to one language.",
    thresholdNotice:
      "Exploratory thresholds only; no production threshold is selected.",
    fixtures: cases.map(({ id, split, category, labels }) => ({
      id,
      split,
      category,
      labels,
    })),
    rows,
    groups,
    results,
  };
}
