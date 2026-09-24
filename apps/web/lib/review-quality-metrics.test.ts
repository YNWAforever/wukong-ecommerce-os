import { describe, expect, it } from "vitest";
import { computeReviewMetrics } from "./review-quality-metrics";
const now = new Date("2026-09-05T00:00:00Z");
const evidence = {
  versions: 4,
  approved: 2,
  elapsedMs: 7200000,
  duplicateApprovals: 1,
  invalidApprovals: 1,
  edits: [],
};
const content = {
  title: { en: "protected", "zh-Hant": "甲" },
  description: { en: "a", "zh-Hant": "乙" },
  seo: {
    title: { en: "b", "zh-Hant": "丙" },
    description: { en: "c", "zh-Hant": "丁" },
  },
  tags: ["wine"],
};
function edit(overrides = {}) {
  return {
    id: "e1",
    listingId: "l1",
    baseVersionId: "v1",
    versionId: "v2",
    actorId: "u1",
    createdBy: "u1",
    baseSequence: 1,
    sequence: 2,
    baseCreatedAt: "2026-09-01T00:00:00Z",
    versionCreatedAt: "2026-09-02T00:00:00Z",
    createdAt: "2026-09-02T00:00:00Z",
    baseContent: content,
    content: { ...content, title: { ...content.title, "zh-Hant": "甲改" } },
    ...overrides,
  };
}
describe("retained review metrics", () => {
  it("keeps explicit empty and missing fields distinct but conservatively unqualified", () => {
    for (const description of [
      { en: "", "zh-Hant": "乙" },
      { en: "   ", "zh-Hant": "乙" },
      { "zh-Hant": "乙" },
    ]) {
      const m = computeReviewMetrics(
        {
          ...evidence,
          edits: [edit({ content: { ...content, description } })],
        },
        now,
      );
      expect(m.humanEditedFieldFraction).toMatchObject({
        value: null,
        denominator: 0,
        reason: "no_qualified_evidence",
      });
      expect(m.exclusions.invalidEdits).toBe(1);
      expect(m.editPopulation).toBe("complete_nonempty_eight_field_pairs");
    }
  });
  it("uses a version cohort and first approvals, not approval event counts", () => {
    const m = computeReviewMetrics(evidence, now);
    expect(m.approvalFraction).toMatchObject({
      value: 0.5,
      numerator: 2,
      denominator: 4,
    });
    expect(m.creationToApprovalMs.value).toBe(3600000);
    expect(m.window.end).toBe(now.toISOString());
    expect(m.window.start).toBe("2026-08-06T00:00:00.000Z");
  });
  it("keeps empty population unavailable", () => {
    const m = computeReviewMetrics(
      { ...evidence, versions: 0, approved: 0, elapsedMs: 0 },
      now,
    );
    expect(m.approvalFraction.value).toBeNull();
    expect(m.creationToApprovalMs.value).toBeNull();
    expect(m.humanEditedFieldFraction.value).toBeNull();
  });
  it("deduplicates explicit pairs and compares only eight Unicode NFC fields", () => {
    const row = edit();
    const m = computeReviewMetrics(
      { ...evidence, edits: [row, { ...row, id: "retry" }] },
      now,
    );
    expect(m.humanEditedFieldFraction).toMatchObject({
      value: 1 / 8,
      numerator: 1,
      denominator: 8,
    });
    expect(m.exclusions.duplicateEdits).toBe(1);
    const equivalent = edit({
      content: {
        ...content,
        title: { en: "changed protected", "zh-Hant": "甲" },
        description: { ...content.description, en: "e\u0301" },
      },
      baseContent: {
        ...content,
        description: { ...content.description, en: "é" },
      },
    });
    expect(
      computeReviewMetrics({ ...evidence, edits: [equivalent] }, now)
        .humanEditedFieldFraction.value,
    ).toBe(0);
  });
  it("excludes missing, empty, contradictory and future evidence", () => {
    const rows = [
      edit({ baseContent: null }),
      edit({ id: "e2", versionId: "v3", content: {} }),
      edit({ id: "e3", versionId: "v4", createdAt: "2027-01-01" }),
      edit({ id: "e4", versionId: "v5", content: { ...content, tags: [] } }),
    ];
    const m = computeReviewMetrics({ ...evidence, edits: rows }, now);
    expect(m.humanEditedFieldFraction.value).toBeNull();
    expect(m.exclusions.invalidEdits).toBe(4);
  });
  it("qualifies all eight projected fields while excluding protected fields", () => {
    const changed = {
      ...content,
      title: { en: "protected unchanged", "zh-Hant": "new" },
      description: { en: "new", "zh-Hant": "新" },
      seo: {
        title: { en: "new", "zh-Hant": "新" },
        description: { en: "new", "zh-Hant": "新" },
      },
      tags: ["new"],
    };
    expect(
      computeReviewMetrics(
        { ...evidence, edits: [edit({ content: changed })] },
        now,
      ).humanEditedFieldFraction,
    ).toMatchObject({ value: 1, numerator: 8, denominator: 8 });
    const protectedOnly = {
      ...content,
      priceHkd: 99,
      stockQuantity: 100,
      title: { ...content.title, en: "changed" },
    };
    expect(
      computeReviewMetrics(
        { ...evidence, edits: [edit({ content: protectedOnly })] },
        now,
      ).humanEditedFieldFraction.value,
    ).toBe(0);
  });
  it("excludes oversized, pipeline and invalid sequence evidence", () => {
    const rows = [
      edit({
        content: {
          ...content,
          description: { ...content.description, en: "x".repeat(16385) },
        },
      }),
      edit({ versionId: "v3", pipelineKey: "generated" }),
      edit({ versionId: "v4", sequence: 4 }),
      edit({ versionId: "v5", baseCreatedAt: "invalid" }),
    ];
    const m = computeReviewMetrics({ ...evidence, edits: rows }, now);
    expect(m.humanEditedFieldFraction.value).toBeNull();
    expect(m.exclusions.invalidEdits).toBe(4);
  });
  it("refuses a truncated population and conflicting retries", () => {
    expect(
      computeReviewMetrics(
        {
          ...evidence,
          edits: Array.from({ length: 1001 }, (_, i) =>
            edit({ id: String(i) }),
          ),
        },
        now,
      ).humanEditedFieldFraction.reason,
    ).toBe("evidence_limit");
    const m = computeReviewMetrics(
      { ...evidence, edits: [edit(), edit({ id: "e2", actorId: "other" })] },
      now,
    );
    expect(m.humanEditedFieldFraction.value).toBeNull();
  });
});
