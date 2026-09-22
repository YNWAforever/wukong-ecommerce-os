import { describe, expect, it } from "vitest";
import {
  CHECK_IDS,
  prepareVerification,
  verificationRecordSchema,
  verificationResultSchema,
} from "./listing-verification.js";
import { verificationFixture } from "./listing-verification-fixture.js";

const completedResult = {
  schemaVersion: 1,
  questionSetVersion: "jev-listing-v1",
  mode: "advisory",
  outcome: "completed",
  reason: null,
  requestedModel: "synthetic-model",
  actualModel: "synthetic-model",
  checkedAt: "2026-09-20T12:00:00.000Z",
  checks: CHECK_IDS.map((id) => ({
    id,
    fields: [id],
    assessment: "assessed" as const,
    probability: 0.25,
  })),
  numericDifferences: [],
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    estimatedCostUsd: 0.001,
    pricingVersion: "synthetic-v1",
    latencyMs: 10,
    requestAttempted: true,
  },
};

describe("verification contracts", () => {
  it("accepts a completed result containing all nine unique checks", () => {
    expect(verificationResultSchema.parse(completedResult)).toEqual(
      completedResult,
    );
  });

  it("rejects duplicate or missing completed check IDs", () => {
    const duplicate = structuredClone(completedResult);
    duplicate.checks[8] = { ...duplicate.checks[0]! };
    expect(() => verificationResultSchema.parse(duplicate)).toThrow();
    expect(() =>
      verificationResultSchema.parse({
        ...completedResult,
        checks: completedResult.checks.slice(0, -1),
      }),
    ).toThrow();
  });

  it("rejects checks on skipped and unavailable results", () => {
    for (const [outcome, reason] of [
      ["skipped", "invalid_input"],
      ["unavailable", "timeout"],
    ] as const) {
      expect(() =>
        verificationResultSchema.parse({ ...completedResult, outcome, reason }),
      ).toThrow();
    }
  });

  it("enforces outcome and reason consistency", () => {
    expect(() =>
      verificationResultSchema.parse({
        ...completedResult,
        outcome: "completed",
        reason: "timeout",
      }),
    ).toThrow();
    expect(() =>
      verificationResultSchema.parse({
        ...completedResult,
        outcome: "skipped",
        reason: "network",
        checks: [],
      }),
    ).toThrow();
    expect(() =>
      verificationResultSchema.parse({
        ...completedResult,
        outcome: "unavailable",
        reason: null,
        checks: [],
      }),
    ).toThrow();
  });

  it("requires finite assessed probabilities and omits them for insufficient evidence", () => {
    for (const probability of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0.1,
      1.1,
    ]) {
      expect(() =>
        verificationResultSchema.parse({
          ...completedResult,
          checks: completedResult.checks.map((check, index) =>
            index === 0 ? { ...check, probability } : check,
          ),
        }),
      ).toThrow();
    }
    expect(() =>
      verificationResultSchema.parse({
        ...completedResult,
        checks: completedResult.checks.map((check, index) =>
          index === 0
            ? {
                id: check.id,
                fields: check.fields,
                assessment: "insufficient_evidence",
                probability: 0,
              }
            : check,
        ),
      }),
    ).toThrow();
  });

  it("requires persisted digests and a nonempty version ID", () => {
    const record = {
      ...completedResult,
      listingVersionId: "symbolic-version",
      contentDigest: "a".repeat(64),
      evidenceDigest: "b".repeat(64),
    };
    expect(verificationRecordSchema.parse(record)).toEqual(record);
    expect(() =>
      verificationRecordSchema.parse({ ...record, listingVersionId: "" }),
    ).toThrow();
    expect(() =>
      verificationRecordSchema.parse({
        ...record,
        contentDigest: "A".repeat(64),
      }),
    ).toThrow();
  });
});

describe("prepareVerification", () => {
  it("does not send a missing-evidence vintage question", () => {
    const input = structuredClone(verificationFixture);
    input.note = null;
    input.evidence = [];
    input.facts.vintage = null;
    const prepared = prepareVerification(input);
    expect(prepared.reason).toBeNull();
    expect(prepared.questions).not.toHaveProperty("vintage");
    expect(prepared.questions).not.toHaveProperty("unsupported_en");
    expect(prepared.questions).toHaveProperty("translation");
  });

  it("bounds UTF-8 bytes rather than characters", () => {
    const input = structuredClone(verificationFixture);
    input.note = "酒".repeat(12_000);
    expect(prepareVerification(input).reason).toBe("input_too_large");
  });

  it("accepts exactly 32768 state bytes and rejects 32769", () => {
    const input = structuredClone(verificationFixture);
    input.note = "";
    const base = prepareVerification(input);
    expect(base.reason).toBeNull();
    if (base.reason !== null) return;
    const baseBytes = new TextEncoder().encode(
      JSON.stringify(base.state),
    ).byteLength;
    input.note = "a".repeat(32_768 - baseBytes);
    expect(prepareVerification(input).reason).toBeNull();
    input.note += "a";
    expect(prepareVerification(input).reason).toBe("input_too_large");
  });

  it("does not treat an image asset ID as textual evidence", () => {
    const input = structuredClone(verificationFixture);
    input.note = null;
    input.facts.vintage = null;
    input.listing.imageAssetIds = ["asset-1"];
    const prepared = prepareVerification(input);
    expect(prepared.questions).not.toHaveProperty("vintage");
    expect(JSON.stringify(prepared)).not.toContain("asset-1");
  });

  it("reports deterministic structured numeric disagreements", () => {
    const input = structuredClone(verificationFixture);
    input.listing.vintage = 2023;
    input.listing.volumeMl = 1_500;
    input.listing.abvPercent = 13;
    const prepared = prepareVerification(input);
    expect(prepared.reason).toBeNull();
    if (prepared.reason !== null) return;
    expect(prepared.numericDifferences).toEqual([
      "vintage",
      "volumeMl",
      "abvPercent",
    ]);
  });

  it("ignores extra runtime properties while selecting state", () => {
    const input = structuredClone(
      verificationFixture,
    ) as typeof verificationFixture & {
      secret?: string;
    };
    input.secret = "do-not-project";
    (input.listing as typeof input.listing & { readUrl?: string }).readUrl =
      "https://example.invalid/signed";
    const prepared = prepareVerification(input);
    expect(prepared.reason).toBeNull();
    expect(JSON.stringify(prepared)).not.toContain("do-not-project");
    expect(JSON.stringify(prepared)).not.toContain("example.invalid");
  });

  it("returns invalid_input for schema-invalid input", () => {
    const input = structuredClone(verificationFixture);
    input.listing.abvPercent = Number.NaN;
    expect(prepareVerification(input)).toEqual({
      reason: "invalid_input",
      questions: {},
    });
  });
});

describe("nonblank evidence eligibility", () => {
  it("does not treat a whitespace-only excerpt as evidence", () => {
    const input = structuredClone(verificationFixture);
    input.note = null;
    input.facts.vintage = null;
    input.evidence = [
      {
        field: "vintage",
        sourceAssetId: "asset-1",
        page: 1,
        excerpt: "   ",
        confidence: 1,
      },
    ];
    const prepared = prepareVerification(input);
    expect(prepared.reason).toBeNull();
    expect(prepared.questions).not.toHaveProperty("vintage");
    expect(prepared.questions).not.toHaveProperty("unsupported_en");
  });
});
