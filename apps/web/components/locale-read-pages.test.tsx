// @vitest-environment happy-dom
import { act } from "react";
import { LocaleProvider } from "../lib/locale-context";
import { AppShellNav } from "./app-shell-nav";
import { CapabilityRegistryPanel } from "./capability-registry-panel";
import { QueueClient } from "./queue-client";
import { JobsLedgerClient } from "./jobs-ledger-client";
import { DashboardListingsClient } from "./dashboard-listings-client";
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => "/catalog",
}));
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
import { CatalogControlCenter } from "./catalog-control-center";
import { QualitySummaryClient } from "./quality-summary-client";
import { SourceReadinessSummary } from "./source-readiness-summary";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
describe("resolved default locale", () => {
  it("uses Chinese-only loading copy for catalog and quality", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const el = document.createElement("div");
    const root = createRoot(el);
    await act(async () =>
      root.render(
        <>
          <CatalogControlCenter />
          <QualitySummaryClient />
        </>,
      ),
    );
    expect(el.textContent).toContain("正在載入");
    expect(el.textContent).not.toContain("Loading");
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
  it("explains unknown source readiness in Chinese", async () => {
    const el = document.createElement("div");
    const root = createRoot(el);
    await act(async () => root.render(<SourceReadinessSummary />));
    expect(el.textContent).toBe("來源準備狀態不明");
    await act(async () => root.unmount());
  });
});

it("propagates a real shell toggle to sibling chrome and cookie without losing selection", async () => {
  const merchantTitle = "商戶原文 Merchant product";
  const payload = {
    items: [
      {
        id: "p1",
        listingId: "l1",
        origin: "import",
        sku: "SKU1",
        remoteProductId: "remote1",
        title: merchantTitle,
        listingStatus: "in_review",
        openBlockingFlagCount: 0,
        specVersion: "v1",
      },
    ],
    capabilities: { canGenerateBulkUpdate: true, canRecordImportResult: false },
    summary: {
      total: 1,
      linked: 1,
      unlinked: 0,
      needsReview: 1,
      needsAttention: 0,
      published: 0,
    },
    page: 1,
    pageSize: 25,
    totalMatching: 1,
  };
  const fetcher = vi.fn().mockResolvedValue(Response.json(payload));
  vi.stubGlobal("fetch", fetcher);
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <LocaleProvider locale="zh-Hant">
        <AppShellNav
          navItems={[
            { href: "/catalog", labelZh: "商品中心", labelEn: "Catalog" },
          ]}
          isAdmin={false}
          workspaceName="Synthetic workspace"
          roleLabelZh="審核員"
          roleLabelEn="Reviewer"
          initialLocale="zh-Hant"
        />
        <CatalogControlCenter />
        <SourceReadinessSummary />
        <CapabilityRegistryPanel />
      </LocaleProvider>,
    ),
  );
  expect(el.querySelector("table")?.getAttribute("aria-label")).toBe(
    "商品列表",
  );
  const scrollRegion = el.querySelector("table")!.parentElement!;
  expect(scrollRegion.getAttribute("role")).toBe("region");
  expect(scrollRegion.tabIndex).toBe(0);
  expect(scrollRegion.getAttribute("aria-label")).toBe("商品列表，可水平捲動");
  await act(async () =>
    el
      .querySelector<HTMLInputElement>(
        'input[aria-label="選取 SKU1 作批量更新"]',
      )!
      .click(),
  );
  const requestCount = fetcher.mock.calls.length;
  await act(async () =>
    el
      .querySelector<HTMLButtonElement>('[data-testid="locale-toggle-en"]')!
      .click(),
  );
  expect(document.cookie).toContain("locale=en");
  expect(document.documentElement.lang).toBe("en");
  expect(refresh).toHaveBeenCalled();
  expect(el.querySelector("table")?.getAttribute("aria-label")).toBe(
    "Product list",
  );
  expect(
    el.querySelector<HTMLInputElement>(
      'input[aria-label="Select SKU1 for Bulk Update"]',
    )?.checked,
  ).toBe(true);
  expect(scrollRegion.getAttribute("aria-label")).toBe(
    "Product list, horizontally scrollable",
  );
  expect(el.textContent).toContain("1 selected for Bulk Update");
  expect(el.textContent).toContain(merchantTitle);
  expect(el.textContent).toContain("Source readiness unknown");
  expect(el.textContent).toContain("not verified production availability");
  expect(fetcher.mock.calls.length).toBe(requestCount);
  await act(async () =>
    el
      .querySelector<HTMLButtonElement>('[data-testid="drawer-trigger"]')!
      .click(),
  );
  expect(el.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
    "Full mobile navigation",
  );
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
  document.cookie = "locale=; path=/; max-age=0";
});
it.each(["zh-Hant", "en"] as const)(
  "localizes all five read clients while loading and on safe failure in %s",
  async (locale) => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const el = document.createElement("div");
    const root = createRoot(el);
    await act(async () =>
      root.render(
        <LocaleProvider locale={locale}>
          <CatalogControlCenter />
          <DashboardListingsClient />
          <QueueClient />
          <JobsLedgerClient />
          <QualitySummaryClient />
        </LocaleProvider>,
      ),
    );
    expect(el.querySelectorAll('[role="status"]')).toHaveLength(5);
    expect(el.textContent).not.toContain(
      locale === "en" ? "正在載入" : "Loading",
    );
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  },
);

it("renders populated English dashboard, queue, job filters and all six quality signals", async () => {
  const counts = {
    received: 1234,
    processing: 0,
    needs_info: 0,
    in_review: 0,
    reopened: 0,
    approved: 0,
    publishing: 0,
    published: 0,
    failed: 0,
    publish_failed: 0,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      Response.json(
        input.startsWith("/api/quality")
          ? {
              totalAssessed: 1234,
              totalListings: 1234,
              noActiveVersion: 0,
              unassessableActiveVersion: 0,
              cleanCount: 1200,
              hasGapsCount: 34,
              totalCostUsd: 2.5,
              gapCounts: {
                untranslatedName: 1,
                untranslatedSeoTitle: 2,
                seoTitleMirrorsName: 3,
                seoDescriptionMirrorsSeoTitle: 4,
                keywordsMirrorName: 5,
                summaryMissing: 6,
              },
            }
          : input.startsWith("/api/jobs")
            ? {
                entries: [],
                metrics: {
                  publishRetries: 0,
                  versionConflicts: 0,
                  staleSourceRejections: 0,
                  importedRows: 1234,
                },
                page: 1,
                pageSize: 50,
                totalMatching: 0,
                total: 0,
              }
            : {
                items: [],
                counts,
                totalMatching: 1234,
                page: 1,
                pageSize: 100,
              },
      ),
    ),
  );
  const el = document.createElement("div");
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <LocaleProvider locale="en">
        <DashboardListingsClient />
        <QueueClient />
        <JobsLedgerClient />
        <QualitySummaryClient />
      </LocaleProvider>,
    ),
  );
  expect(el.textContent).toContain("Latest five listings");
  expect(el.textContent).toContain("Workspace listings: 1234 matching");
  expect(el.textContent).toContain("Import result");
  expect(el.textContent).toContain("SEO description mirrors SEO title");
  expect(el.textContent).toContain("1,234");
  expect(el.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  expect(el.querySelectorAll("tbody tr")).toHaveLength(6);
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it.each(["zh-Hant", "en"] as const)(
  "renders a Hong Kong job timestamp with ISO datetime in %s",
  async (locale) => {
    const timestamp = "2026-09-04T16:30:00.000Z";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          entries: [
            {
              kind: "publish_job",
              id: "job-midnight",
              listingId: null,
              normalizedStatus: "failed",
              rawStatus: "failed",
              createdAt: timestamp,
              summary: "Synthetic job",
            },
          ],
          metrics: {
            publishRetries: 0,
            versionConflicts: 0,
            staleSourceRejections: 0,
            importedRows: 0,
          },
          page: 1,
          pageSize: 50,
          totalMatching: 1,
          total: 1,
        }),
      ),
    );
    const el = document.createElement("div");
    const root = createRoot(el);
    try {
      await act(async () =>
        root.render(
          <LocaleProvider locale={locale}>
            <JobsLedgerClient />
          </LocaleProvider>,
        ),
      );
      const time = el.querySelector("time")!;
      expect(time).not.toBeNull();
      expect(time.getAttribute("datetime")).toBe(timestamp);
      const expected = new Intl.DateTimeFormat(
        locale === "en" ? "en-HK" : "zh-HK",
        { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Hong_Kong" },
      ).format(new Date(timestamp));
      expect(time.textContent).toBe(expected);
      expect(time.textContent).not.toContain("2026-09-04T");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it.each(["zh-Hant", "en"] as const)(
  "renders approval-specific queue remedies in %s",
  async (locale) => {
    const failures = [
      ["source_snapshot_required", "重新匯入此商品", "Reimport this product"],
      [
        "approval_required",
        "沒有可批准的 SHOPLINE 版本",
        "No approvable SHOPLINE version is available",
      ],
      [
        "confirmation_incomplete",
        "完成確認清單",
        "complete the confirmation checklist",
      ],
      [
        "confirmation_ledger_stale",
        "確認清單已變更",
        "The confirmation checklist changed",
      ],
      ["version_conflict", "版本已變更", "The listing version changed"],
      ["listing_not_found", "商品已不存在", "The listing no longer exists"],
      [
        "unknown_backend_code",
        "重新載入佇列並檢查商品",
        "Reload the queue and inspect the listing",
      ],
    ];
    const items = failures.map(([code]) => ({
      id: code,
      status: "in_review",
      target: "shopline",
      title: code,
      sku: code,
      updatedAt: "2026-09-04T00:00:00Z",
      openBlockingFlagCount: 0,
      reviewContext: {
        expectedVersionId: "version-1",
        confirmationLedgerRevision: 1,
      },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url === "/api/listings/bulk-approve"
            ? {
                results: failures.map(([code]) => ({
                  listingId: code,
                  ok: false,
                  code,
                  message: "UNSAFE SERVER DETAIL",
                })),
                approved: 0,
                failed: failures.length,
              }
            : { items, page: 1, pageSize: 100, totalMatching: items.length },
        ),
      ),
    );
    const el = document.createElement("div");
    const root = createRoot(el);
    try {
      await act(async () =>
        root.render(
          <LocaleProvider locale={locale}>
            <QueueClient />
          </LocaleProvider>,
        ),
      );
      await act(async () => {
        for (const checkbox of el.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]',
        ))
          checkbox.click();
      });
      const approve = [...el.querySelectorAll("button")].find((button) =>
        button.textContent?.startsWith(locale === "en" ? "Approve " : "批准 "),
      )!;
      expect(approve).toBeDefined();
      await act(async () => approve.click());
      const results = el.querySelector(".bulk-result-list")!;
      expect(results).not.toBeNull();
      for (const [, zh, en] of failures)
        expect(results.textContent).toContain(locale === "en" ? en : zh);
      expect(results.textContent).not.toContain("UNSAFE SERVER DETAIL");
      expect(results.textContent).not.toContain(
        locale === "en"
          ? "Approve the active version first"
          : "需要先批准目前版本",
      );
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
