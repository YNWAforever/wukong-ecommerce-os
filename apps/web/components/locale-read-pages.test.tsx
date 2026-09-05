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
