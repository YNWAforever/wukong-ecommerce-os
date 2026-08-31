import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ListingFieldsForm,
  type ListingReviewModel,
} from "./listing-fields-form";

const model: ListingReviewModel = {
  id: "listing-1",
  versionId: "version-1",
  status: "in_review",
  fields: [
    {
      key: "producer",
      label: "生產者",
      englishLabel: "Producer",
      value: "Opak Cellar",
      confidence: 0.96,
      evidence: {
        excerpt: "Opak Cellar",
        source: "supplier-sheet.txt",
        page: null,
      },
    },
    {
      key: "stockQuantity",
      label: "庫存數量",
      englishLabel: "Stock quantity",
      value: null,
      confidence: null,
      evidence: null,
    },
  ],
  blockingFlags: [
    {
      id: "description:health_claim:0",
      code: "health_claim",
      field: "description",
      label: "健康功效聲稱",
      description: "移除未有來源支持的健康功效描述，或交由審核員記錄理由。",
      status: "open",
      resolutionReason: null,
    },
  ],
};

describe("ListingFieldsForm", () => {
  it("shows provenance and disables approval for unresolved blocking flags", () => {
    const markup = renderToStaticMarkup(<ListingFieldsForm model={model} />);

    expect(markup).toContain("生產者");
    expect(markup).toContain("Opak Cellar");
    expect(markup).toContain("來源：supplier-sheet.txt");
    expect(markup).toContain("信心度 96%");
    expect(markup).toContain("需要資料");
    expect(markup).toContain("健康功效聲稱");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("批准上架");
  });

  it("renders the SEO & tags field group when SEO keys are present", () => {
    const seoModel: ListingReviewModel = {
      ...model,
      fields: [
        ...model.fields,
        {
          key: "seoTitleEn",
          label: "SEO 標題（英文）",
          englishLabel: "SEO title (English)",
          value: "Opak Riesling",
          confidence: null,
          evidence: null,
        },
        {
          key: "seoTitleZh",
          label: "SEO 標題（繁中）",
          englishLabel: "SEO title (Traditional Chinese)",
          value: "Opak 雷司令",
          confidence: null,
          evidence: null,
        },
        {
          key: "seoDescriptionEn",
          label: "SEO 描述（英文）",
          englishLabel: "SEO description (English)",
          value: "Dry Mosel Riesling.",
          confidence: null,
          evidence: null,
          kind: "textarea",
        },
        {
          key: "seoDescriptionZh",
          label: "SEO 描述（繁中）",
          englishLabel: "SEO description (Traditional Chinese)",
          value: "摩澤爾乾型雷司令。",
          confidence: null,
          evidence: null,
          kind: "textarea",
        },
        {
          key: "seoKeywords",
          label: "SEO 關鍵字",
          englishLabel: "SEO keywords",
          value: "wine, riesling",
          confidence: null,
          evidence: null,
        },
      ],
    };

    const markup = renderToStaticMarkup(<ListingFieldsForm model={seoModel} />);

    expect(markup).toContain("SEO 與標籤");
    expect(markup).toContain("SEO &amp; tags");
    expect(markup).toContain("SEO 標題（英文）");
    expect(markup).toContain("SEO 標題（繁中）");
    expect(markup).toContain("SEO 描述（英文）");
    expect(markup).toContain("SEO 描述（繁中）");
    expect(markup).toContain("SEO 關鍵字");
    expect(markup).toContain("wine, riesling");
  });
});
