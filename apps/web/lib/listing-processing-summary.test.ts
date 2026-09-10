import { describe, expect, it } from "vitest";

import {
  readProcessingSummary,
  splitMissingFields,
  type PipelineRunStateLike,
} from "./listing-processing-summary.js";

const FACTS = {
  sku: null,
  producer: "Demo Estate",
  productType: "wine",
  country: "Germany",
  region: "Mosel",
  vintage: 2024,
  grapeVarieties: ["Riesling"],
  volumeMl: 750,
  abvPercent: 12.5,
  packQuantity: 1,
  priceHkd: null,
  stockQuantity: null,
  criticScores: [],
  awards: [],
};

function runState(
  overrides: Partial<PipelineRunStateLike> = {},
): PipelineRunStateLike {
  return {
    status: "succeeded",
    resultStatus: "needs_info",
    errorCode: null,
    steps: new Map([
      [
        "extracted",
        {
          state: "completed" as const,
          output: {
            facts: FACTS,
            evidence: [],
            missingFields: ["sku", "priceHkd", "stockQuantity"],
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              estimatedCostUsd: 0.001,
              latencyMs: 25,
              model: "gpt-5.6-terra",
              promptVersion: "1.1.0",
            },
          },
        },
      ],
    ]),
    ...overrides,
  };
}

describe("readProcessingSummary", () => {
  it("recovers the facts a needs_info run already extracted", () => {
    // The whole point: this run wrote no version, so without reading the step
    // output the screen has nothing to show but "more information needed".
    const summary = readProcessingSummary(runState());

    expect(summary?.resultStatus).toBe("needs_info");
    expect(summary?.extractedFacts?.producer).toBe("Demo Estate");
    expect(summary?.extractedFacts?.volumeMl).toBe(750);
    expect(summary?.missingFields).toEqual(["sku", "priceHkd", "stockQuantity"]);
  });

  it("never surfaces model, token or cost telemetry", () => {
    const summary = readProcessingSummary(runState());

    // usage sits in the same stored object; it belongs to the admin cost
    // ledger, not an operator's product page.
    expect(JSON.stringify(summary)).not.toContain("estimatedCostUsd");
    expect(JSON.stringify(summary)).not.toContain("gpt-5.6-terra");
    expect(JSON.stringify(summary)).not.toContain("promptVersion");
  });

  it("carries a failed run's stable error code", () => {
    const summary = readProcessingSummary(
      runState({
        status: "failed",
        resultStatus: null,
        errorCode: "provider_failure",
        steps: new Map(),
      }),
    );

    expect(summary?.runStatus).toBe("failed");
    expect(summary?.errorCode).toBe("provider_failure");
    expect(summary?.extractedFacts).toBeNull();
  });

  it("returns null when the listing has no run yet", () => {
    expect(readProcessingSummary(null)).toBeNull();
    expect(readProcessingSummary(undefined)).toBeNull();
  });

  it("ignores an extraction step that is still running", () => {
    const summary = readProcessingSummary(
      runState({
        status: "started",
        resultStatus: null,
        steps: new Map([
          ["extracted", { state: "running" as const, output: null }],
        ]),
      }),
    );

    // A running step's output column is null until recordStep commits, so
    // reading it would show an empty fact set as though nothing was found.
    expect(summary?.extractedFacts).toBeNull();
    expect(summary?.missingFields).toEqual([]);
  });

  it("degrades instead of throwing on a shape it does not recognize", () => {
    // listing_pipeline_steps.output is jsonb with no database-level schema, so
    // a historical row can hold anything. A listing page must still render.
    for (const output of [
      null,
      "not an object",
      { facts: { producer: 42 } },
      { facts: FACTS, missingFields: "sku" },
      {},
    ]) {
      const summary = readProcessingSummary(
        runState({
          steps: new Map([["extracted", { state: "completed", output }]]),
        }),
      );
      expect(summary).not.toBeNull();
      expect(Array.isArray(summary?.missingFields)).toBe(true);
    }
  });
});

describe("splitMissingFields", () => {
  it("separates what a person must supply from what a retry could find", () => {
    const { merchant, extractable } = splitMissingFields([
      "sku",
      "priceHkd",
      "stockQuantity",
      "vintage",
      "region",
    ]);

    // Re-running processing cannot discover a merchant's SKU or price, so
    // grouping them with vintage would imply a retry might help.
    expect(merchant).toEqual(["sku", "priceHkd", "stockQuantity"]);
    expect(extractable).toEqual(["vintage", "region"]);
  });

  it("handles an empty list", () => {
    expect(splitMissingFields([])).toEqual({ merchant: [], extractable: [] });
  });
});
