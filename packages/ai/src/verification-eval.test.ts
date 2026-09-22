import { describe, expect, it, vi } from "vitest";
import {
  CHECK_IDS,
  prepareVerification,
  type VerificationResult,
} from "./listing-verification.js";
import { buildVerificationFixtures } from "./verification-eval-fixtures.js";
import { confusion, evaluateVerificationCases } from "./verification-eval.js";
import { runEvaluationCli } from "../scripts/eval-listing-verification.js";

function result(
  probability: number,
  overrides: Partial<VerificationResult> = {},
): VerificationResult {
  return {
    schemaVersion: 1,
    questionSetVersion: "jev-listing-v1",
    mode: "advisory",
    outcome: "completed",
    reason: null,
    requestedModel: "jev-1.13.0",
    actualModel: "jev-1.13.0",
    checkedAt: "2026-09-22T00:00:00Z",
    checks: CHECK_IDS.map((id) => ({
      id,
      fields: [],
      assessment: "assessed",
      probability,
    })),
    numericDifferences: [],
    usage: {
      inputTokens: 1,
      outputTokens: 0,
      estimatedCostUsd: 0.01,
      pricingVersion: "test-price",
      latencyMs: 10,
      requestAttempted: true,
    },
    ...overrides,
  };
}
describe("synthetic evaluation", () => {
  it("has forty schema-valid distinct fixed examples, half holdout", () => {
    const cases = buildVerificationFixtures();
    expect(cases).toHaveLength(40);
    expect(cases.filter((c) => c.split === "holdout")).toHaveLength(20);
    expect(new Set(cases.map((c) => c.id)).size).toBe(40);
    expect(new Set(cases.map((c) => JSON.stringify(c.input))).size).toBe(40);
    for (const category of [
      "valid",
      "unsupported",
      "contradiction",
      "translation",
    ]) {
      expect(cases.filter((c) => c.category === category)).toHaveLength(10);
      expect(
        cases.filter(
          (c) => c.category === category && c.split === "development",
        ),
      ).toHaveLength(5);
    }
    for (const c of cases)
      expect(prepareVerification(c.input).reason, c.id).toBeNull();
    expect(cases.map((c) => c.id)).toEqual(
      buildVerificationFixtures().map((c) => c.id),
    );
    const missing = cases.find((c) => c.id === "translation-no-source")!;
    expect(missing.labels).toEqual({ translation: true });
    const prepared = prepareVerification(missing.input);
    expect(prepared.reason === null && prepared.insufficient).toContain(
      "unsupported_en",
    );
    expect(prepared.reason === null && prepared.insufficient).toContain(
      "unsupported_zh",
    );
    expect(
      cases.find((c) => c.id === "contradiction-conflicting-source")!.labels,
    ).toEqual({ vintage: true, translation: false });
  });
  it("uses exact labelled assessed denominators, never counts missing results as negatives", async () => {
    const cases = buildVerificationFixtures()
      .slice(0, 5)
      .map((c, i) => ({
        ...c,
        labels: { translation: i !== 0 },
        split: "development" as const,
      }));
    const outputs = [
      result(0.8),
      result(0.2),
      result(0, { outcome: "unavailable", reason: "network", checks: [] }),
      result(0, {
        checks: CHECK_IDS.map((id) => ({
          id,
          fields: [],
          assessment: "insufficient_evidence",
        })),
      }),
      result(0.9, {
        usage: { ...result(0).usage, estimatedCostUsd: null, latencyMs: 50 },
      }),
    ];
    const verify = vi.fn(async () => outputs.shift()!);
    const report = await evaluateVerificationCases(
      cases,
      { verify },
      { maxRequests: 10, budgetUsd: 1 },
    );
    expect(report.requests).toBe(5);
    expect(report.unavailable).toBe(1);
    expect(report.unknownAttemptedCostCount).toBe(1);
    expect(report.knownEstimatedCostUsd).toBeCloseTo(0.04);
    expect(report.latencyMs).toEqual({ p50: 10, p95: 50 });
    const group = report.groups.find(
      (g) => g.split === "development" && g.check === "translation",
    )!;
    expect(group).toMatchObject({
      labelled: 5,
      assessed: 3,
      insufficient: 1,
      unavailable: 1,
      coverage: 0.6,
    });
    expect(group.thresholds.exploratory_0_5).toEqual({
      tp: 1,
      fp: 1,
      tn: 0,
      fn: 1,
      falseAlarmRate: 1,
      missedErrorRate: 0.5,
    });
    expect(report.rows).toHaveLength(3);
    expect(
      report.groups.find(
        (g) => g.split === "holdout" && g.check === "translation",
      )!.coverage,
    ).toBeNull();
    expect(confusion([], 0.5)).toEqual({
      tp: 0,
      fp: 0,
      tn: 0,
      fn: 0,
      falseAlarmRate: null,
      missedErrorRate: null,
    });
    expect(JSON.stringify(report)).not.toContain(cases[0]!.input.note);
  });
  it("stops sequentially at request, observed spend, and unknown cost caps", async () => {
    const cases = buildVerificationFixtures();
    for (const [options, output, calls, stopReason] of [
      [{ maxRequests: 2, budgetUsd: 1 }, result(0), 2, "request_cap"],
      [
        { maxRequests: 40, budgetUsd: 0.005 },
        result(0),
        1,
        "observed_spend_cap",
      ],
      [
        { maxRequests: 40, budgetUsd: 1 },
        result(0, { usage: { ...result(0).usage, estimatedCostUsd: null } }),
        1,
        "unknown_cost",
      ],
    ] as const) {
      const verify = vi.fn(async () => output);
      const report = await evaluateVerificationCases(
        cases,
        { verify },
        options,
      );
      expect(verify).toHaveBeenCalledTimes(calls);
      expect(report.stopReason).toBe(stopReason);
      expect(report.notRun).toBe(40 - calls);
    }
  });
  it("dry-run never constructs a client; live requires every explicit gate", async () => {
    const factory = vi.fn(() => ({ verify: vi.fn(async () => result(0)) }));
    const env = {
      TYPESAFE_API_KEY: "fake-test-key",
      TYPESAFE_MODEL: "jev-1.13.0",
    };
    expect(await runEvaluationCli([], env, factory)).toMatchObject({
      dryRun: true,
      cases: 40,
      holdout: 20,
      requests: 0,
    });
    expect(factory).not.toHaveBeenCalled();
    const flags = [
      "--live",
      "--confirm-synthetic",
      "--max-requests",
      "1",
      "--budget-usd",
      "0.1",
    ];
    for (const args of [
      ["--live"],
      ["--live", "--confirm-synthetic"],
      [...flags, "--dry-run"],
      [...flags, "--bad"],
    ]) {
      await expect(runEvaluationCli(args, env, factory)).rejects.toThrow();
    }
    await expect(runEvaluationCli(flags, {}, factory)).rejects.toThrow();
    await expect(
      runEvaluationCli(
        flags,
        { ...env, TYPESAFE_MODEL: "jev-latest" },
        factory,
      ),
    ).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    expect(await runEvaluationCli(flags, env, factory)).toMatchObject({
      requests: 1,
    });
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

it("fixes all category variations and labels in the evaluation contract", () => {
  const cases = buildVerificationFixtures();
  const ids = {
    valid:
      "literal paraphrase units percentage non-vintage transliteration reordered omitted-detail note-only excerpts-only",
    unsupported:
      "medal critic organic biodynamic aging vineyard medical scarcity history injection",
    contradiction:
      "producer vintage country region grape volume abv two-numbers conflicting-source non-vintage",
    translation:
      "vintage producer country region grape volume abv award age no-source",
  };
  expect(cases.map((c) => c.id)).toEqual(
    Object.entries(ids).flatMap(([category, variations]) =>
      variations.split(" ").map((id) => `${category}-${id}`),
    ),
  );
  const trueLabels: Record<string, string[]> = {
    "contradiction-producer": ["unsupported_en", "unsupported_zh", "producer"],
    "contradiction-vintage": ["unsupported_en", "unsupported_zh", "vintage"],
    "contradiction-country": ["unsupported_en", "unsupported_zh", "origin"],
    "contradiction-region": ["unsupported_en", "unsupported_zh", "origin"],
    "contradiction-grape": ["unsupported_en", "unsupported_zh", "grapes"],
    "contradiction-volume": ["unsupported_en", "unsupported_zh", "volume"],
    "contradiction-abv": ["unsupported_en", "unsupported_zh", "abv"],
    "contradiction-two-numbers": [
      "unsupported_en",
      "unsupported_zh",
      "volume",
      "abv",
    ],
    "contradiction-conflicting-source": ["vintage"],
    "contradiction-non-vintage": [
      "unsupported_en",
      "unsupported_zh",
      "vintage",
    ],
    "translation-vintage": ["unsupported_zh", "vintage", "translation"],
    "translation-producer": ["unsupported_zh", "producer", "translation"],
    "translation-country": ["unsupported_zh", "origin", "translation"],
    "translation-region": ["unsupported_zh", "origin", "translation"],
    "translation-grape": ["unsupported_zh", "grapes", "translation"],
    "translation-volume": ["unsupported_zh", "volume", "translation"],
    "translation-abv": ["unsupported_zh", "abv", "translation"],
    "translation-award": ["unsupported_zh", "translation"],
    "translation-age": ["unsupported_en", "translation"],
    "translation-no-source": ["translation"],
  };
  for (const c of cases) {
    const expected =
      c.category === "valid"
        ? []
        : c.category === "unsupported"
          ? ["unsupported_en", "unsupported_zh"]
          : trueLabels[c.id]!;
    expect(
      Object.keys(c.labels)
        .filter((id) => c.labels[id as keyof typeof c.labels])
        .sort(),
      c.id,
    ).toEqual([...expected].sort());
    expect(Object.keys(c.labels)).toHaveLength(
      c.id === "translation-no-source"
        ? 1
        : c.id === "contradiction-conflicting-source"
          ? 2
          : 9,
    );
  }
  const get = (id: string) => cases.find((c) => c.id === id)!.input;
  expect(get("valid-units").listing.description.en).toContain("0.75 L");
  expect(get("valid-units").facts.volumeMl).toBe(750);
  expect(get("valid-percentage").listing.description.en).toContain("12.50%");
  expect(get("valid-percentage").facts.abvPercent).toBe(12.5);
  expect(get("valid-note-only").evidence).toEqual([]);
  expect(get("valid-excerpts-only").note).toBeNull();
  expect(get("valid-excerpts-only").evidence).toHaveLength(1);
  expect(get("valid-non-vintage").facts.vintage).toBeNull();
  expect(get("contradiction-non-vintage").facts.vintage).toBeNull();
  expect(get("contradiction-non-vintage").listing.vintage).toBe(2015);
});

it("reports skipped and unrun labelled cases separately and uses inclusive thresholds", async () => {
  const cases = buildVerificationFixtures().slice(0, 3);
  const outputs = [
    result(0, {
      outcome: "skipped",
      reason: "invalid_input",
      checks: [],
      usage: {
        ...result(0).usage,
        requestAttempted: false,
        estimatedCostUsd: 0,
      },
    }),
    result(0.5),
  ];
  const report = await evaluateVerificationCases(
    cases,
    { verify: async () => outputs.shift()! },
    { maxRequests: 1, budgetUsd: 1 },
  );
  expect(report).toMatchObject({
    requests: 1,
    evaluated: 2,
    skipped: 1,
    notRun: 1,
    stopReason: "request_cap",
  });
  const group = report.groups.find(
    (g) => g.split === "development" && g.check === "translation",
  )!;
  expect(group).toMatchObject({
    labelled: 3,
    assessed: 1,
    skipped: 1,
    notRun: 1,
    coverage: 1 / 3,
  });
  expect(group.thresholds.exploratory_0_5).toMatchObject({
    fp: 1,
    tn: 0,
    missedErrorRate: null,
  });
  expect(group.thresholds.exploratory_0_75).toMatchObject({ fp: 0, tn: 1 });
});

it("rejects each missing live gate and invalid cap before client construction", async () => {
  const factory = vi.fn(() => ({ verify: vi.fn(async () => result(0)) }));
  const env = { TYPESAFE_API_KEY: "fake", TYPESAFE_MODEL: "jev-1.13.0" };
  for (const args of [
    ["--live", "--max-requests", "1", "--budget-usd", "1"],
    ["--live", "--confirm-synthetic", "--budget-usd", "1"],
    ["--live", "--confirm-synthetic", "--max-requests", "1"],
    ...["0", "-1", "NaN", "Infinity", "1.5"].map((n) => [
      "--live",
      "--confirm-synthetic",
      "--max-requests",
      n,
      "--budget-usd",
      "1",
    ]),
    ...["0", "-1", "NaN", "Infinity"].map((n) => [
      "--live",
      "--confirm-synthetic",
      "--max-requests",
      "1",
      "--budget-usd",
      n,
    ]),
  ])
    await expect(runEvaluationCli(args, env, factory)).rejects.toThrow();
  const noRead = new Proxy(
    {},
    {
      get() {
        throw new Error("Environment read in dry-run");
      },
    },
  );
  expect(await runEvaluationCli(["--dry-run"], noRead, factory)).toMatchObject({
    requests: 0,
  });
  expect(factory).not.toHaveBeenCalled();
});
