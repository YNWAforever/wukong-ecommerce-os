import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudioGapReportCard } from "./studio-gap-report-card";
const id = "11111111-1111-4111-8111-111111111111";
function report(gaps: Array<{ code: string; blocking: boolean }> | null) {
  return {
    schemaVersion: "wukong-gap-report/v1",
    asOf: "2026-11-14T08:00:00Z",
    scope: { mode: "selected", listingIds: [id], truncated: false },
    listings: [
      {
        listingId: id,
        title: "Synthetic listing",
        status: "needs_review",
        activeVersion: null,
        gaps,
      },
    ],
    quality: null,
    checks: [],
    evidenceTruncated: false,
    coverage: {},
    limitations: [],
  };
}
describe("gap report preview", () => {
  it.each(["en", "zh-Hant"] as const)(
    "renders bounded recorded evidence in %s",
    (locale) => {
      const html = renderToStaticMarkup(
        <StudioGapReportCard
          locale={locale}
          payload={report([{ code: "missing_description", blocking: false }])}
        />,
      );
      expect(html).toContain("missing_description");
      expect(html).toContain(`/listings/${id}`);
      expect(html).toContain('data-kind="gap_report"');
    },
  );
  it("keeps missing quality unknown rather than claiming zero gaps", () => {
    const html = renderToStaticMarkup(
      <StudioGapReportCard locale="en" payload={report(null)} />,
    );
    expect(html).toContain("Not available");
    expect(html).not.toContain("No gaps reported");
    expect(
      renderToStaticMarkup(
        <StudioGapReportCard locale="en" payload={report([])} />,
      ),
    ).toContain("No gaps reported by these checks");
  });
  it("rejects a future schema rather than rendering it as current evidence", () => {
    const html = renderToStaticMarkup(
      <StudioGapReportCard
        locale="en"
        payload={{ ...report([]), schemaVersion: "future" }}
      />,
    );
    expect(html).not.toContain('data-kind="gap_report"');
  });
});
