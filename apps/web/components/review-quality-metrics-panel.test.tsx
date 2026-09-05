// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
import { LocaleProvider } from "../lib/locale-context";
import { computeReviewMetrics } from "../lib/review-quality-metrics";
import { ReviewQualityMetricsPanel } from "./review-quality-metrics-panel";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const now = new Date("2026-09-05T00:00:00Z");
describe("localized review evidence", () => {
  it.each(["en", "zh-Hant"] as const)(
    "shows empty denominators and unavailability without an error alert in %s",
    async (locale) => {
      const el = document.createElement("div"),
        root = createRoot(el);
      const metrics = computeReviewMetrics(
        {
          versions: 0,
          approved: 0,
          elapsedMs: 0,
          duplicateApprovals: 0,
          invalidApprovals: 0,
          edits: [],
        },
        now,
      );
      await act(async () =>
        root.render(
          <LocaleProvider locale={locale}>
            <ReviewQualityMetricsPanel metrics={metrics} />
          </LocaleProvider>,
        ),
      );
      expect(el.textContent).toContain(
        locale === "en"
          ? "Observed version approval fraction"
          : "版本觀察批准比例",
      );
      expect(el.textContent).toContain(
        locale === "en"
          ? "No complete qualifying evidence"
          : "沒有完整合資格證據",
      );
      expect(el.textContent).toContain("0 / 0");
      expect(el.querySelector('[role="alert"]')).toBeNull();
      await act(async () => root.unmount());
    },
  );
  it("shows observed values with cohort and elapsed-time scope", async () => {
    const el = document.createElement("div"),
      root = createRoot(el);
    const metrics = computeReviewMetrics(
      {
        versions: 4,
        approved: 2,
        elapsedMs: 7200000,
        duplicateApprovals: 1,
        invalidApprovals: 1,
        edits: [],
      },
      now,
    );
    await act(async () =>
      root.render(
        <LocaleProvider locale="en">
          <ReviewQualityMetricsPanel metrics={metrics} />
        </LocaleProvider>,
      ),
    );
    expect(el.textContent).toContain("0.5");
    expect(el.textContent).toContain("2 / 4 versions");
    expect(el.textContent).toContain("not reviewer work");
    expect(el.textContent).toContain(
      "changed fields / eight per qualified pair",
    );
    await act(async () => root.unmount());
  });
});
