"use client";
import {
  exactQueryId,
  initialDestinationSearch,
  withWorkbenchReturn,
} from "../lib/workbench-navigation";
import { WorkbenchReturnLink } from "./workbench-return-link";
import { useLocale } from "../lib/locale-context";
import {
  localized,
  commonCopy,
  safeUiError,
  formatNumber,
  formatHkDate,
  stateLabel,
} from "../lib/ui-copy";

import Link from "next/link";
import { WorkbookProductDetail } from "./workbook-product-detail";
import { WebsiteProductDetail } from "./website-product-detail";
import { useCallback, useId, useMemo, useState } from "react";

import type { CatalogPage, PlatformCatalogItem } from "../lib/catalog-contract";
import { useLatestRequest } from "../lib/use-latest-request";
import { SourceReadinessSummary } from "./source-readiness-summary";
import {
  CATALOG_FILTERS,
  type CatalogFilter,
  catalogStatusTone,
} from "./catalog-view-models";
import styles from "./catalog-control-center.module.css";
import { BulkExportPanel, NO_CONTENT_DIGEST } from "./bulk-export-panel";

const STATUS_TONE_CLASSES = {
  neutral: styles.statusNeutral,
  warning: styles.statusWarning,
  success: styles.statusSuccess,
  danger: styles.statusDanger,
} as const;

const PAGE_SIZE = 25;

const EMPTY_RESPONSE: CatalogPage = {
  items: [],
  capabilities: { canGenerateBulkUpdate: false, canRecordImportResult: false },
  summary: {
    total: 0,
    website: 0,
    workbook: 0,
    linked: 0,
    unlinked: 0,
    needsReview: 0,
    needsAttention: 0,
    published: 0,
  },
  page: 1,
  pageSize: PAGE_SIZE,
  totalMatching: 0,
};

export function CatalogControlCenter({
  initialSearch,
}: { initialSearch?: string } = {}) {
  const params = useMemo(
    () => initialDestinationSearch(initialSearch),
    [initialSearch],
  );
  const importId = exactQueryId(params.get("importId"));
  const invalidImport = params.has("importId") && !importId;
  const returnTo = params.get("returnTo");
  const locale = useLocale();
  const c = commonCopy[locale];
  const [workbookDetailId, setWorkbookDetailId] = useState<string | null>(null);
  const [websiteDetailId, setWebsiteDetailId] = useState<string | null>(null);
  const destinationQuery = params.get("q") ?? "";
  const destinationFilter =
    CATALOG_FILTERS.find((option) => option.value === params.get("filter"))
      ?.value ?? "all";
  const pageValue = params.get("page");
  const destinationPage =
    pageValue &&
    /^[1-9][0-9]*$/.test(pageValue) &&
    Number(pageValue) <= 21474836
      ? Number(pageValue)
      : 1;
  const destination = JSON.stringify([
    params.get("importId"),
    destinationQuery,
    destinationFilter,
    destinationPage,
  ]);
  const [previousDestination, setPreviousDestination] = useState(destination);
  const [query, setQuery] = useState(destinationQuery);
  const [filter, setFilter] = useState<CatalogFilter>(destinationFilter);
  const [page, setPage] = useState(destinationPage);
  // Synchronize URL-owned controls without remounting detail or export forms.
  if (previousDestination !== destination) {
    setPreviousDestination(destination);
    setQuery(destinationQuery);
    setFilter(destinationFilter);
    setPage(destinationPage);
  }
  // Keyed by listingId, valued by the `contentDigest` the operator was
  // actually shown at the moment they ticked the row -- not re-derived later
  // from whichever page happens to be loaded. `selectedListings` deliberately
  // survives page and filter changes (see the "keeps selected platform
  // listings..." and "hides rows from another import..." tests), so a
  // selected row is very often no longer present in `response.items` by the
  // time the export panel needs its digest.
  const [selectedListings, setSelectedListings] = useState<
    ReadonlyMap<string, string | null>
  >(new Map());

  const loadCatalog = useCallback(
    async (signal: AbortSignal) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        q: query,
        filter,
      });
      if (invalidImport) throw new Error("Invalid import link");
      if (importId) params.set("importId", importId);
      const response = await fetch(`/api/catalog?${params.toString()}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok)
        throw new Error(`Unable to load catalog (${response.status})`);
      return { importId, page: (await response.json()) as CatalogPage };
    },
    [page, query, filter, importId, invalidImport],
  );
  const { data, error, loading, stale, reload } = useLatestRequest(
    loadCatalog,
    "Unable to load catalog",
  );

  // Retain same-import refresh results, but never relabel another import's rows.
  // Keep the surrounding detail/export forms mounted during scope changes.
  const response =
    data && !invalidImport && data.importId === importId
      ? data.page
      : EMPTY_RESPONSE;

  // What actually gets attested: prefer the digest on the row as it appears
  // on the current page, and only fall back to the digest captured at the
  // moment of selection when the row is not on this page at all. A
  // still-visible row whose content moved on must not be attestable at its
  // old value -- feeding the fresh digest through here changes the identity
  // `BulkExportPanel` compares against, which is what drops an existing
  // attestation on its own (see that component's `selectionIdentity`).
  // `NO_CONTENT_DIGEST` only stands in when neither the current page nor the
  // selection-time capture has ever produced a real digest for this row; it
  // never overrides a real one, so an off-page row keeps the value the
  // operator actually saw instead of losing it to this sentinel.
  const exportListings = useMemo(
    () =>
      Array.from(selectedListings, ([listingId, capturedDigest]) => {
        const visibleRow = response.items.find(
          (item): item is PlatformCatalogItem =>
            item.sourceType === "platform" && item.listingId === listingId,
        );
        const digest = visibleRow ? visibleRow.contentDigest : capturedDigest;
        return { listingId, contentDigest: digest ?? NO_CONTENT_DIGEST };
      }),
    [selectedListings, response.items],
  );

  function handleQueryChange(value: string) {
    setQuery(value);
    setPage(1);
  }

  function handleFilterChange(value: CatalogFilter) {
    setFilter(value);
    setPage(1);
  }

  const returnLink = returnTo ? (
    <WorkbenchReturnLink returnTo={returnTo} />
  ) : null;
  if (!data && error) {
    return (
      <div className="load-error" role="alert">
        {returnLink}
        <p>{safeUiError(error, locale)}</p>
        <button type="button" onClick={reload}>
          {c.retry}
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <p className="helper-copy" role="status">
        {returnLink}
        {localized(
          locale,
          "正在載入商品控制中心…",
          "Loading catalog control center…",
        )}
      </p>
    );
  }

  return (
    <section
      aria-label={localized(locale, "商品控制中心", "Catalog control center")}
      aria-busy={loading}
    >
      {returnLink}
      {importId ? (
        <p className="helper-copy">
          {localized(
            locale,
            "此匯入的商品。摘要數字涵蓋整個工作區。",
            "This import. Summary counts cover the entire workspace.",
          )}
        </p>
      ) : null}
      {error ? (
        <div className="load-error" role="alert">
          <span>{safeUiError(error, locale)}</span>
          <button type="button" onClick={reload}>
            {c.retry}
          </button>
        </div>
      ) : null}
      {stale ? (
        <p className="refresh-status" role="status">
          {localized(locale, "正在更新結果…", "Refreshing results…")}
        </p>
      ) : null}
      {websiteDetailId ? (
        <div>
          <button type="button" onClick={() => setWebsiteDetailId(null)}>
            {localized(locale, "關閉資料", "Close details")}
          </button>
          <WebsiteProductDetail key={websiteDetailId} id={websiteDetailId} />
        </div>
      ) : null}
      {workbookDetailId ? (
        <div>
          <button type="button" onClick={() => setWorkbookDetailId(null)}>
            {localized(locale, "關閉資料", "Close details")}
          </button>
          <WorkbookProductDetail key={workbookDetailId} id={workbookDetailId} />
        </div>
      ) : null}
      <div className={styles.metrics}>
        <Metric
          value={response.summary.workbook}
          label={localized(locale, "試算表商品", "Workbook products")}
        />
        <Metric
          value={response.summary.website}
          label={localized(locale, "網站商品", "Website products")}
        />
        <Metric
          value={response.summary.unlinked}
          label={localized(
            locale,
            "未連結的平台商品",
            "Unlinked platform products",
          )}
        />
        <Metric
          value={response.summary.total}
          label={localized(locale, "商品", "Products")}
        />
        <Metric
          value={response.summary.linked}
          label={localized(locale, "已連結", "Linked")}
        />
        <Metric
          value={response.summary.needsReview}
          label={localized(locale, "待審核", "Needs review")}
        />
        <Metric
          value={response.summary.needsAttention}
          label={localized(locale, "需處理", "Attention")}
        />
        <Metric
          value={response.summary.published}
          label={localized(locale, "已發佈", "Published")}
        />
      </div>

      <div className={styles.controlPanel}>
        <div className={styles.selectionBar} aria-live="polite">
          <strong>
            {localized(
              locale,
              `已選取 ${selectedListings.size} 個商品作批量更新`,
              `${selectedListings.size} selected for Bulk Update`,
            )}
          </strong>
          <button
            type="button"
            className={styles.pageButton}
            disabled={selectedListings.size === 0}
            onClick={() => setSelectedListings(new Map())}
          >
            {localized(locale, "清除選取", "Clear selection")}
          </button>
        </div>
        <BulkExportPanel
          listings={exportListings}
          canGenerate={response.capabilities.canGenerateBulkUpdate}
        />
        <div className={styles.toolbar}>
          <label className={styles.searchField}>
            <span>{localized(locale, "搜尋商品", "Search catalog")}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              placeholder={localized(
                locale,
                "SKU、商品名稱、SHOPLINE 商品 ID",
                "SKU, product name, SHOPLINE Product ID",
              )}
            />
          </label>
          <p className={styles.resultCount} aria-live="polite">
            {localized(
              locale,
              `顯示第 ${page} 頁 · 符合 ${response.totalMatching} / ${response.summary.total} 個商品`,
              `Page ${page} · ${response.totalMatching} matching / ${response.summary.total} products`,
            )}
          </p>
        </div>

        <div
          className={styles.filters}
          aria-label={localized(locale, "商品篩選", "Catalog filters")}
        >
          {CATALOG_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={
                option.value === filter
                  ? `${styles.filterButton} ${styles.filterButtonActive}`
                  : styles.filterButton
              }
              aria-pressed={option.value === filter}
              onClick={() => handleFilterChange(option.value)}
            >
              {localized(locale, option.labelZh, option.labelEn)}
            </button>
          ))}
        </div>

        {response.items.length === 0 ? (
          <div className={styles.emptyState}>
            <h2>
              {localized(
                locale,
                "找不到符合條件的商品",
                "No matching products",
              )}
            </h2>
            <p>
              {localized(
                locale,
                "調整搜尋字詞或篩選條件，查看其他商品。",
                "Adjust the search or filters to see other products.",
              )}
            </p>
          </div>
        ) : (
          <div
            className={styles.tableWrap}
            role="region"
            aria-label={localized(
              locale,
              "商品列表，可水平捲動",
              "Product list, horizontally scrollable",
            )}
            tabIndex={0}
          >
            <table
              className={styles.table}
              aria-label={localized(locale, "商品列表", "Product list")}
            >
              <thead>
                <tr>
                  <th scope="col">
                    <span className={styles.visuallyHidden}>
                      {localized(locale, "選取", "Select")}
                    </span>
                  </th>
                  <th scope="col">{localized(locale, "商品", "Product")}</th>
                  <th scope="col">{localized(locale, "來源", "Source")}</th>
                  <th scope="col">
                    {localized(locale, "工作流程", "Workflow")}
                  </th>
                  <th scope="col">
                    {localized(locale, "來源準備狀態", "Source readiness")}
                  </th>
                  <th scope="col">{localized(locale, "阻塞", "Blockers")}</th>
                  <th scope="col">
                    <span className={styles.visuallyHidden}>
                      {localized(locale, "操作", "Action")}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {response.items.map((item) => {
                  if (item.sourceType === "workbook")
                    return (
                      <tr key={`workbook:${item.id}`}>
                        <td />
                        <td>
                          <strong className={styles.productTitle}>
                            {item.title}
                          </strong>
                          <span className={styles.productMeta}>
                            {item.sku} · {item.sourceProductId}
                          </span>
                        </td>
                        <td>
                          <span className={styles.originBadge}>
                            {localized(locale, "試算表", "Workbook")}
                          </span>
                        </td>
                        <td>{localized(locale, "僅供參考", "Read only")}</td>
                        <td>
                          {localized(locale, "不能匯出", "Cannot export")}
                        </td>
                        <td>—</td>
                        <td>
                          <button
                            type="button"
                            className={styles.pageButton}
                            onClick={() => {
                              setWebsiteDetailId(null);
                              setWorkbookDetailId(item.id);
                            }}
                          >
                            {localized(locale, "查看資料", "View details")}
                          </button>
                        </td>
                      </tr>
                    );
                  if (item.sourceType === "website")
                    return (
                      <tr key={`website:${item.id}`}>
                        <td />
                        <td>
                          <strong className={styles.productTitle}>
                            {item.title}
                          </strong>
                          <span className={styles.productMeta}>
                            {item.sourceUrl}
                          </span>
                        </td>
                        <td>{localized(locale, "網站", "Website")}</td>
                        <td>{localized(locale, "僅供參考", "Read only")}</td>
                        <td>
                          {localized(locale, "不能匯出", "Cannot export")}
                        </td>
                        <td>—</td>
                        <td>
                          <button
                            type="button"
                            className={styles.pageButton}
                            onClick={() => {
                              setWorkbookDetailId(null);
                              setWebsiteDetailId(item.id);
                            }}
                          >
                            {localized(locale, "查看資料", "View details")}
                          </button>
                        </td>
                      </tr>
                    );
                  const tone = catalogStatusTone(item.listingStatus);
                  return (
                    <tr key={`platform:${item.id}`}>
                      <td>
                        {item.origin === "import" &&
                        item.listingId &&
                        response.capabilities.canGenerateBulkUpdate ? (
                          <input
                            type="checkbox"
                            aria-label={localized(
                              locale,
                              `選取 ${item.sku ?? item.remoteProductId} 作批量更新`,
                              `Select ${item.sku ?? item.remoteProductId} for Bulk Update`,
                            )}
                            checked={selectedListings.has(item.listingId)}
                            onChange={(event) =>
                              setSelectedListings((current) => {
                                const next = new Map(current);
                                if (event.target.checked) {
                                  // Capture the digest as shown right now --
                                  // this is what the operator is attesting
                                  // to, not whatever a later page happens to
                                  // find under this id.
                                  next.set(item.listingId!, item.contentDigest);
                                } else {
                                  next.delete(item.listingId!);
                                }
                                return next;
                              })
                            }
                          />
                        ) : null}
                      </td>
                      <td>
                        <strong className={styles.productTitle}>
                          {item.title}
                        </strong>
                        <span className={styles.productMeta}>
                          {item.sku ?? localized(locale, "未有 SKU", "No SKU")}{" "}
                          · {item.remoteProductId}
                        </span>
                      </td>
                      <td>
                        <span className={styles.originBadge}>
                          {item.origin === "import"
                            ? localized(locale, "匯入", "Import")
                            : localized(locale, "建立", "Created")}
                        </span>
                        <span className={styles.specVersion}>
                          {item.specVersion ?? "API"}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`${styles.statusBadge} ${STATUS_TONE_CLASSES[tone]}`}
                        >
                          {stateLabel(item.listingStatus, locale)}
                        </span>
                      </td>
                      <td>
                        <SourceReadinessSummary
                          readiness={item.sourceReadiness}
                          compact
                        />
                      </td>
                      <td>
                        {item.openBlockingFlagCount === null ? (
                          <span className={styles.mutedValue}>—</span>
                        ) : item.openBlockingFlagCount > 0 ? (
                          <span className={styles.blockerCount}>
                            {localized(
                              locale,
                              `${item.openBlockingFlagCount} 個阻塞`,
                              `${item.openBlockingFlagCount} blocking`,
                            )}
                          </span>
                        ) : (
                          <span className={styles.clearValue}>
                            {localized(locale, "0 無阻塞", "0 clear")}
                          </span>
                        )}
                      </td>
                      <td className={styles.actionCell}>
                        {item.listingId ? (
                          <Link
                            className={styles.actionLink}
                            href={withWorkbenchReturn(
                              `/listings/${item.listingId}`,
                              returnTo,
                            )}
                          >
                            {localized(locale, "開啟流程", "Open")}
                          </Link>
                        ) : (
                          <Link
                            className={styles.actionLink}
                            href="/listings/new"
                          >
                            {localized(locale, "建立草稿", "Start draft")}
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div
          className={styles.paginationControls}
          aria-label={localized(locale, "分頁", "Pagination")}
        >
          <button
            type="button"
            className={styles.pageButton}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={loading || page === 1}
          >
            {localized(locale, "上一頁", "Previous")}
          </button>
          <span className={styles.pageIndicator}>
            {localized(locale, `第 ${page} 頁`, `Page ${page}`)}
          </span>
          <button
            type="button"
            className={styles.pageButton}
            onClick={() => setPage((current) => current + 1)}
            disabled={loading || response.totalMatching <= page * PAGE_SIZE}
          >
            {localized(locale, "下一頁", "Next")}
          </button>
        </div>
      </div>
    </section>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  const locale = useLocale();
  const labelId = useId();
  return (
    <div className={styles.metric} role="group" aria-labelledby={labelId}>
      <span className={styles.metricValue}>{formatNumber(value, locale)}</span>
      <span className={styles.metricLabel} id={labelId}>
        {label}
      </span>
    </div>
  );
}
