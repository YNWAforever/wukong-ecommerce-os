import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  copyProposalPayloadSchema,
  StudioReviewCard,
} from "./studio-review-card";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    listingId: "listing-1",
    activeVersionId: "version-1",
    activeVersionSequence: 7,
    fields: [
      {
        field: "title.en",
        current: "Synthetic old title",
        proposed: "Synthetic proposed title",
        evidenceRefs: ["listing:listing-1:v7"],
      },
      {
        field: "description.zh-Hant",
        current: null,
        proposed: "合成建議描述",
        evidenceRefs: ["listing:listing-1:v7", "quality:v1"],
      },
    ],
    limitations: ["Synthetic proposal limitation"],
    asOf: "2026-11-08T00:00:00.000Z",
    ...overrides,
  };
}

function render(locale: "zh-Hant" | "en", value: unknown = payload()) {
  return renderToStaticMarkup(
    <StudioReviewCard locale={locale} payload={value} />,
  );
}

describe("StudioReviewCard", () => {
  it("renders the current -> proposed table with raw field ids in monospace", () => {
    const html = render("en");

    expect(html).toContain("Proposed content · human approval required");
    expect(html).toContain("<table");
    expect(html).toContain("Field");
    expect(html).toContain("Current");
    expect(html).toContain("Proposed");
    expect(html).toContain("Evidence");
    expect(html).toContain("Synthetic old title");
    expect(html).toContain("Synthetic proposed title");
    // Field ids are stored ids, not prettified labels.
    expect(html).toContain("title.en");
    expect(html).toContain("description.zh-Hant");
    expect(html).toContain('<code class="');
  });

  it("renders evidence refs as non-interactive chips, never links", () => {
    const html = render("en");

    expect(html).toContain("listing:listing-1:v7");
    expect(html).toContain("quality:v1");
    // A ref is not a URL and must not be an anchor.
    expect(html).not.toMatch(/<a[^>]*>listing:listing-1:v7/);
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("renders the human-approval gate and the no-canonical-write note", () => {
    const html = render("en");

    expect(html).toContain(
      "Requires human review; Studio never approves or publishes.",
    );
    expect(html).toContain(
      "The proposal never writes canonical listing data.",
    );
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Apply");
  });

  it("links to the existing listing review screen and shows version/as-of", () => {
    const html = render("en");

    expect(html).toContain('href="/listings/listing-1"');
    expect(html).toContain("Open in the review workspace");
    expect(html).toContain("Active version 7");
    expect(html).toContain("Active version");
    expect(html).toContain("As of");
  });

  it("renders a not-provided marker for an empty current value", () => {
    const html = render("en");
    expect(html).toContain("Not provided");
    expect(html).toContain("合成建議描述");
  });

  it("renders limitations and an explicit empty-fields state", () => {
    const withLimitations = render("en");
    expect(withLimitations).toContain("Limitations");
    expect(withLimitations).toContain("Synthetic proposal limitation");

    const empty = render("en", payload({ fields: [] }));
    expect(empty).toContain("No proposed fields.");
  });

  it("renders an honest unavailable state for an invalid payload instead of crashing", () => {
    for (const invalid of [
      null,
      {},
      { ...payload(), fields: "not-an-array" },
      { ...payload(), listingId: "" },
      { ...payload(), fields: [{ field: "title.en" }] },
    ]) {
      const html = render("en", invalid);
      expect(html).toContain(
        "This proposal could not be displayed; nothing is invented.",
      );
      expect(html).not.toContain("<table");
    }
  });

  it("parses the reviewed payload contract", () => {
    expect(copyProposalPayloadSchema.safeParse(payload()).success).toBe(true);
    expect(
      copyProposalPayloadSchema.safeParse({
        ...payload(),
        activeVersionSequence: 7.5,
      }).success,
    ).toBe(false);
    expect(
      copyProposalPayloadSchema.safeParse({ ...payload(), asOf: "" }).success,
    ).toBe(false);
  });

  it("escapes proposed text as text, not markup", () => {
    const html = render(
      "en",
      payload({
        fields: [
          {
            field: "title.en",
            current: "old",
            proposed: "<img src=x onerror=alert(1)>",
            evidenceRefs: ["listing:listing-1:v7"],
          },
        ],
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("renders zh-Hant copy for the zh-Hant locale", () => {
    const html = render("zh-Hant");

    expect(html).toContain("建議內容 · 須人工審核");
    expect(html).toContain("欄位");
    expect(html).toContain("目前");
    expect(html).toContain("建議");
    expect(html).toContain("須由人員審核；工作室不會批准或發佈。");
    expect(html).toContain("建議內容不會寫入正式商品資料。");
    expect(html).toContain("在審核畫面開啟");
  });
});
