import { describe, expect, it } from "vitest";

import { evaluateExtraction, type EvaluationFixture } from "./eval.js";

const expected: EvaluationFixture = {
  facts: {
    sku: "OPAK-DEMO-001",
    producer: "Opak Cellar",
    productType: "wine",
    country: "Germany",
    region: "Mosel",
    vintage: 2024,
    grapeVarieties: ["Riesling"],
    volumeMl: 750,
    abvPercent: 12.5,
    packQuantity: 1,
    priceHkd: 288,
    stockQuantity: null,
    criticScores: [],
    awards: [],
  },
  requiredFacts: [
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
  ],
  usage: { latencyMs: 420, inputTokens: 120, outputTokens: 80 },
};

describe("evaluateExtraction", () => {
  it("reports recall, numeric agreement, latency, and token usage for grounded facts", () => {
    const report = evaluateExtraction(expected, {
      facts: { ...expected.facts, abvPercent: 12.5 },
      usage: { latencyMs: 420, inputTokens: 120, outputTokens: 80 },
    });

    expect(report.requiredFactRecall).toBe(1);
    expect(report.numericAgreement).toMatchObject({ exact: 5, normalized: 5, total: 5 });
    expect(report.unsupportedCriticalFacts).toEqual([]);
    expect(report.latencyMs).toBe(420);
    expect(report.tokenUsage).toEqual({ inputTokens: 120, outputTokens: 80, totalTokens: 200 });
    expect(report.passed).toBe(true);
  });

  it("fails a hallucinated unsupported protected fact even when recall is high", () => {
    const report = evaluateExtraction(expected, {
      facts: { ...expected.facts, stockQuantity: 12 },
      usage: { latencyMs: 100, inputTokens: 1, outputTokens: 2 },
    });

    expect(report.requiredFactRecall).toBe(1);
    expect(report.unsupportedCriticalFacts).toEqual(["stockQuantity"]);
    expect(report.passed).toBe(false);
    expect(report.failures).toContain("unsupported protected fact: stockQuantity");
  });

  it("normalizes numeric strings while retaining exact agreement separately", () => {
    const report = evaluateExtraction(expected, {
      facts: { ...expected.facts, abvPercent: 12.50 },
      usage: { latencyMs: 1, inputTokens: 0, outputTokens: 0 },
    });

    expect(report.numericAgreement).toMatchObject({ exact: 5, normalized: 5 });
  });
});
