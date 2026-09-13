import { createHash } from "node:crypto";

import type { FieldEvidence, ReviewableListing } from "@wukong/core";
import { describe, expect, it } from "vitest";

import { CONFIRMATION_FIELD_KEYS } from "./review-confirmation-keys";
import { buildReviewFieldRecords } from "./review-field-records";

const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const content: ReviewableListing = {
  sku: null,
  producer: null,
  productType: null,
  country: null,
  region: null,
  vintage: null,
  grapeVarieties: [],
  volumeMl: null,
  abvPercent: null,
  packQuantity: 1,
  priceHkd: null,
  stockQuantity: null,
  criticScores: [],
  awards: [],
  title: { en: "title-en", "zh-Hant": "title-zh" },
  description: { en: "description-en", "zh-Hant": "description-zh" },
  seo: {
    title: { en: "seo-title-en", "zh-Hant": "seo-title-zh" },
    description: { en: "seo-description-en", "zh-Hant": "seo-description-zh" },
  },
  tags: ["keyword-b", "keyword-a"],
  imageAssetIds: [],
};

const evidence = (field: string, excerpt: string): FieldEvidence => ({
  field,
  sourceAssetId: "note",
  page: null,
  excerpt,
  confidence: 0.9,
});

describe("buildReviewFieldRecords", () => {
  it("records every confirmation field, and nothing else", () => {
    const records = buildReviewFieldRecords({
      content,
      evidence: [],
      rawRow: null,
    });
    expect(Object.keys(records)).toEqual(CONFIRMATION_FIELD_KEYS);
  });

  it("pins the confirmed value as a digest of the value as stored", () => {
    const records = buildReviewFieldRecords({
      content,
      evidence: [],
      rawRow: null,
    });
    expect(records.nameZh?.afterDigest).toBe(sha("title-zh"));
    expect(records.seoKeywords?.afterDigest).toBe(
      sha(["keyword-b", "keyword-a"]),
    );
  });

  it("does not confuse one keyword containing a comma with two keywords", () => {
    // Both display as "keyword-b, keyword-a". Only the stored array tells them
    // apart, which is why the display string is never digested.
    const single = buildReviewFieldRecords({
      content: { ...content, tags: ["keyword-b, keyword-a"] },
      evidence: [],
      rawRow: null,
    });
    const pair = buildReviewFieldRecords({
      content,
      evidence: [],
      rawRow: null,
    });
    expect(single.seoKeywords?.afterDigest).not.toBe(
      pair.seoKeywords?.afterDigest,
    );
  });

  it("records the merchant's cell as before, and null where the cell is blank", () => {
    const records = buildReviewFieldRecords({
      content,
      evidence: [],
      rawRow: {
        productId: "remote-1",
        nameZh: "merchant-name",
        summaryEn: "",
        summaryZh: "   ",
        seoTitleEn: null,
      },
    });
    expect(records.nameZh?.before).toEqual({
      column: "nameZh",
      digest: sha("merchant-name"),
    });
    expect(records.summaryEn?.before).toBeNull();
    expect(records.summaryZh?.before).toBeNull();
    expect(records.seoTitleEn?.before).toBeNull();
    expect(records.seoKeywords?.before).toBeNull();
  });

  it("lets a reader see that the confirmed value is the merchant's own, unchanged", () => {
    const records = buildReviewFieldRecords({
      content,
      evidence: [],
      rawRow: { nameZh: "title-zh", summaryEn: "merchant-summary" },
    });
    expect(records.nameZh?.before?.digest).toBe(records.nameZh?.afterDigest);
    expect(records.summaryEn?.before?.digest).not.toBe(
      records.summaryEn?.afterDigest,
    );
  });

  it("records no before at all for a listing that was never imported", () => {
    const records = buildReviewFieldRecords({
      content,
      evidence: [],
      rawRow: null,
    });
    expect(
      Object.values(records).every((record) => record.before === null),
    ).toBe(true);
  });

  it("pins the grounding offered for a field, and null where there was none", () => {
    const records = buildReviewFieldRecords({
      content,
      rawRow: null,
      evidence: [
        evidence("title.zh-Hant", "excerpt-name"),
        evidence("tags", "excerpt-tags"),
      ],
    });
    expect(records.nameZh?.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(records.seoKeywords?.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(records.summaryEn?.evidenceDigest).toBeNull();
  });

  it("gives the same grounding the same digest whatever order the rows arrive in", () => {
    // getReviewSnapshot reads evidence with no ORDER BY.
    const first = evidence("title.zh-Hant", "excerpt-one");
    const second = evidence("title.zh-Hant", "excerpt-two");
    const forward = buildReviewFieldRecords({
      content,
      rawRow: null,
      evidence: [first, second],
    });
    const backward = buildReviewFieldRecords({
      content,
      rawRow: null,
      evidence: [second, first],
    });
    expect(forward.nameZh?.evidenceDigest).toBe(
      backward.nameZh?.evidenceDigest,
    );
  });

  it("changes the evidence digest when the grounding changes", () => {
    const original = buildReviewFieldRecords({
      content,
      rawRow: null,
      evidence: [evidence("title.zh-Hant", "excerpt-one")],
    });
    const changed = buildReviewFieldRecords({
      content,
      rawRow: null,
      evidence: [evidence("title.zh-Hant", "excerpt-changed")],
    });
    expect(changed.nameZh?.evidenceDigest).not.toBe(
      original.nameZh?.evidenceDigest,
    );
  });
});
