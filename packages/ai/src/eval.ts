import type { ListingFacts } from "@wukong/core";

import type { AIUsage } from "./contracts.js";

export const PROTECTED_FACT_FIELDS = [
  "sku",
  "producer",
  "productType",
  "country",
  "region",
  "vintage",
  "grapeVarieties",
  "volumeMl",
  "abvPercent",
  "priceHkd",
  "stockQuantity",
  "criticScores",
  "awards",
] as const satisfies readonly (keyof ListingFacts)[];

export type ProtectedFactField = (typeof PROTECTED_FACT_FIELDS)[number];
export type NumericFactField = Extract<
  keyof ListingFacts,
  "vintage" | "volumeMl" | "abvPercent" | "packQuantity" | "priceHkd" | "stockQuantity"
>;

export type EvaluationFixture = {
  facts: Partial<ListingFacts>;
  /** Facts that the provider must recover; omitted values are not scored for recall. */
  requiredFacts?: readonly (keyof ListingFacts)[];
  usage?: Partial<Pick<AIUsage, "latencyMs" | "inputTokens" | "outputTokens">>;
};

export type NumericAgreement = {
  exact: number;
  normalized: number;
  total: number;
  exactMismatches: NumericFactField[];
  normalizedMismatches: NumericFactField[];
};

export type ExtractionEvaluation = {
  passed: boolean;
  requiredFactRecall: number;
  matchedRequiredFacts: number;
  requiredFactCount: number;
  numericAgreement: NumericAgreement;
  unsupportedCriticalFacts: ProtectedFactField[];
  latencyMs: number;
  tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
  failures: string[];
};

const NUMERIC_FACT_FIELDS: readonly NumericFactField[] = [
  "vintage",
  "volumeMl",
  "abvPercent",
  "packQuantity",
  "priceHkd",
  "stockQuantity",
];

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function normalized(value: unknown): unknown {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  if (typeof value === "number") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalized(entry))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalized(entry)]),
    );
  }
  return value;
}

function normalizedNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function defaultRequiredFacts(expected: EvaluationFixture): readonly (keyof ListingFacts)[] {
  return PROTECTED_FACT_FIELDS.filter((field) => isPresent(expected.facts[field]));
}

/**
 * Compare a provider extraction with a synthetic expected fixture.
 *
 * Missing optional facts are intentionally not scored as recall failures, but a
 * provider is never allowed to invent a protected fact that the fixture leaves
 * unsupported (for example stock or a critic score).
 */
export function evaluateExtraction(
  expected: EvaluationFixture,
  actual: EvaluationFixture,
): ExtractionEvaluation {
  const requiredFacts = expected.requiredFacts ?? defaultRequiredFacts(expected);
  const matchedRequiredFacts = requiredFacts.filter((field) => {
    const expectedValue = expected.facts[field];
    const actualValue = actual.facts[field];
    return isPresent(expectedValue) && isPresent(actualValue) &&
      JSON.stringify(normalized(expectedValue)) === JSON.stringify(normalized(actualValue));
  }).length;
  const requiredFactCount = requiredFacts.length;
  const requiredFactRecall = requiredFactCount === 0 ? 1 : matchedRequiredFacts / requiredFactCount;

  const unsupportedCriticalFacts = PROTECTED_FACT_FIELDS.filter((field) => {
    return !isPresent(expected.facts[field]) && isPresent(actual.facts[field]);
  });

  const numericFields = NUMERIC_FACT_FIELDS.filter((field) => {
    return isPresent(expected.facts[field]) && isPresent(actual.facts[field]);
  });
  const exactMismatches = numericFields.filter((field) => expected.facts[field] !== actual.facts[field]);
  const normalizedMismatches = numericFields.filter((field) => {
    const expectedNumber = normalizedNumeric(expected.facts[field]);
    const actualNumber = normalizedNumeric(actual.facts[field]);
    return expectedNumber === null || actualNumber === null || Math.abs(expectedNumber - actualNumber) > 1e-9;
  });
  const numericAgreement: NumericAgreement = {
    exact: numericFields.length - exactMismatches.length,
    normalized: numericFields.length - normalizedMismatches.length,
    total: numericFields.length,
    exactMismatches,
    normalizedMismatches,
  };

  const inputTokens = actual.usage?.inputTokens ?? 0;
  const outputTokens = actual.usage?.outputTokens ?? 0;
  const latencyMs = actual.usage?.latencyMs ?? 0;
  const failures: string[] = [];
  if (requiredFactRecall < 0.9) failures.push(`required fact recall below 0.90: ${requiredFactRecall.toFixed(3)}`);
  for (const field of unsupportedCriticalFacts) failures.push(`unsupported protected fact: ${field}`);

  return {
    passed: failures.length === 0,
    requiredFactRecall,
    matchedRequiredFacts,
    requiredFactCount,
    numericAgreement,
    unsupportedCriticalFacts,
    latencyMs,
    tokenUsage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    failures,
  };
}

export function assertEvaluation(report: ExtractionEvaluation): void {
  if (!report.passed) throw new Error(`extraction evaluation failed: ${report.failures.join("; ")}`);
}
