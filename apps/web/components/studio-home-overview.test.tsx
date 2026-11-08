import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { StudioOverviewResult } from "../lib/studio/contracts";
import { StudioHomeOverview } from "./studio-home-overview";

function overview(
  overrides: Partial<StudioOverviewResult> = {},
): StudioOverviewResult {
  return {
    listingCounts: {
      byStatus: { approved: 3, in_review: 2 },
      total: 5,
      deepLink: "/dashboard",
    },
    quality: {
      assessmentVersion: "v1",
      totalListings: 12,
      totalAssessed: 9,
      cleanCount: 7,
      hasGapsCount: 2,
      noActiveVersion: 1,
      unassessableActiveVersion: 0,
      projectionState: "ready",
      asOf: "2026-11-08T00:00:00.000Z",
      deepLink: "/quality",
    },
    recentJobs: {
      items: [
        {
          jobId: "job-1",
          state: "failed",
          createdAt: "2026-11-08T00:00:00.000Z",
          deepLink: "/jobs",
        },
        {
          jobId: "job-2",
          state: "succeeded",
          createdAt: "2026-11-08T00:00:00.000Z",
          deepLink: "/jobs",
        },
      ],
      deepLink: "/jobs",
    },
    ...overrides,
  };
}

describe("StudioHomeOverview", () => {
  it("renders the exact records-only rule and never fetches", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      const html = renderToStaticMarkup(
        <StudioHomeOverview locale="en" overview={overview()} />,
      );
      expect(html).toContain("From workspace records; no AI call.");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders record counts from props with deep links", () => {
    const html = renderToStaticMarkup(
      <StudioHomeOverview locale="en" overview={overview()} />,
    );

    expect(html).toContain("5 in total");
    expect(html).toContain("By status:");
    expect(html).toContain("9 of 12 assessed");
    expect(html).toContain("7 clean");
    expect(html).toContain("2 with gaps");
    expect(html).toContain("Projection: ready");
    expect(html).toContain("As of");
    expect(html).toContain("1 failed within the 2 most recent jobs");
    for (const href of ["/dashboard", "/quality", "/jobs"]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("uses 'Not yet available' only for the reads that are unimplemented", () => {
    const html = renderToStaticMarkup(
      <StudioHomeOverview locale="en" overview={overview()} />,
    );

    // Four unimplemented tiles (blocking flags, unapproved drafts, last import,
    // last export) say so honestly; the three record-backed tiles show numbers.
    expect((html.match(/>Not yet available</g) ?? []).length).toBe(4);
    expect(html).toContain("Open blocking flags");
    expect(html).toContain("This record read is not available yet.");
  });

  it("renders the honest failure line and no fabricated numbers when the read fails", () => {
    const html = renderToStaticMarkup(
      <StudioHomeOverview locale="en" overview={null} />,
    );

    expect(html).toContain(
      "The workspace overview could not be read; no estimated or invented numbers are shown.",
    );
    // The four tiles whose reads do not exist are shown, and none is "0".
    expect((html.match(/>Not yet available</g) ?? []).length).toBe(4);
    expect(html).not.toMatch(/>\s*0\s*</);
  });

  it("renders zh-Hant copy and formatted record statuses", () => {
    const html = renderToStaticMarkup(
      <StudioHomeOverview locale="zh-Hant" overview={overview()} />,
    );

    expect(html).toContain("來自工作區記錄；不會呼叫 AI。");
    expect(html).toContain("已批准 3");
    expect(html).toContain("待審核 2");
    expect(html).toContain("尚未提供");
  });
});
