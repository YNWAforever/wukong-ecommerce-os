import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StudioReportCard } from "./studio-report-card";

const AS_OF = "2026-11-08T10:00:00.000Z";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "wukong-merchant-audit/v1",
    generatedAt: AS_OF,
    asOf: AS_OF,
    period: { from: null, to: null },
    scope: { workspaceScoped: true },
    listings: [
      { status: "approved", count: 3 },
      { status: "in_review", count: 2 },
    ],
    quality: {
      assessmentVersion: "opak-current-content-v1",
      totalListings: 5,
      totalAssessed: 4,
      cleanCount: 3,
      hasGapsCount: 1,
      projectionState: "ready",
      asOf: AS_OF,
    },
    exports: [
      {
        attemptId: "attempt-1",
        state: "ready",
        rowCount: 2,
        createdAt: AS_OF,
      },
    ],
    checks: [
      {
        key: "studio.check.audit_listing_counts",
        values: { total: 5 },
        state: "ok",
      },
    ],
    coverage: {
      catalog: "present",
      quality: "present",
      export_attempt: "present",
    },
    limitations: [{ key: "studio.limit.audit_period_unset", values: {} }],
    ...overrides,
  };
}

function render(
  locale: "zh-Hant" | "en",
  options: { payload?: unknown; exportHref?: string | null } = {},
) {
  return renderToStaticMarkup(
    <StudioReportCard
      locale={locale}
      payload={options.payload ?? payload()}
      exportHref={options.exportHref ?? null}
    />,
  );
}

describe("StudioReportCard", () => {
  it("renders the listing counts, quality summary and export attempts from the artifact", () => {
    const html = render("en");

    expect(html).toContain("Merchant audit report");
    expect(html).toContain("Listing status");
    expect(html).toContain("approved");
    expect(html).toContain("in_review");
    expect(html).toContain("Quality summary");
    expect(html).toContain("5 listings");
    expect(html).toContain("3 clean");
    expect(html).toContain("1 with gaps");
    expect(html).toContain("Recent export attempts");
    expect(html).toContain("attempt-1");
    // Evidence table and its coverage chips come from the artifact too.
    expect(html).toContain("Workspace listings: 5.");
    expect(html).toContain("Present");
  });

  it("uses the real current-total scope line and the report's limitations", () => {
    const html = render("en");
    expect(html).toContain("Not specified (current totals)");
    expect(html).toContain(
      "No audit period was specified; the numbers are current totals at read time.",
    );
    expect(html).toContain(
      "The report reflects records at read time only; it never writes listing data.",
    );
  });

  it("renders an unread section as unavailable instead of zero", () => {
    const html = render("en", {
      payload: payload({ listings: null, quality: null, exports: null }),
    });
    expect((html.match(/This section could not be read/g) ?? []).length).toBe(
      3,
    );
    expect(html).not.toContain("0 listings");
  });

  it("distinguishes a counted zero export ledger from an unread one", () => {
    const html = render("en", { payload: payload({ exports: [] }) });
    expect(html).toContain("No export attempts recorded.");
    expect(html).not.toContain("This section could not be read");
  });

  it("offers the canonical JSON export only when a digest link is supplied", () => {
    const withoutLink = render("en");
    expect(withoutLink).toContain(
      "Save or sign off the artifact before exporting.",
    );
    expect(withoutLink).not.toMatch(/href="\/api\/studio\/outputs\//);

    const withLink = render("en", {
      exportHref:
        "/api/studio/outputs/output-1/export?digest=" + "a".repeat(64),
    });
    expect(withLink).toContain("Download JSON export");
    expect(withLink).toContain('href="/api/studio/outputs/output-1/export');
    expect(withLink).toContain("download");
  });

  it("renders an honest unavailable state for an invalid payload", () => {
    const html = render("en", { payload: { not: "a report" } });
    expect(html).toContain(
      "This report could not be displayed; nothing is invented.",
    );
    expect(html).not.toContain("<table");
  });

  it("escapes artifact text as text, not markup", () => {
    const html = render("en", {
      payload: payload({
        listings: [{ status: "<img src=x onerror=alert(1)>", count: 1 }],
      }),
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("renders zh-Hant copy for the zh-Hant locale", () => {
    const html = render("zh-Hant");
    expect(html).toContain("商戶稽核報告");
    expect(html).toContain("商品狀態");
    expect(html).toContain("品質概況");
    expect(html).toContain("最近匯出紀錄");
    expect(html).toContain("期間：未指定（目前總計）");
  });
});
