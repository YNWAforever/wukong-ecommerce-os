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
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import type { CatalogPage, PlatformCatalogItem } from "../lib/catalog-contract";
import { useLatestRequest } from "../lib/use-latest-request";
import { SourceReadinessSummary } from "./source-readiness-summary";
import { SupportRequestId } from "./support-request-id";
import {
  CATALOG_FILTERS,
  type CatalogFilter,
  catalogStatusTone,
} from "./catalog-view-models";
import styles from "./catalog-control-center.module.css";
import { BulkExportPanel, NO_CONTENT_DIGEST } from "./bulk-export-panel";
import { CreateBatchForm } from "./create-batch-form";

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
  const [workspaceScope, setWorkspaceScope] = useState(false);
  const importId = workspaceScope ? null : exactQueryId(params.get("importId"));
  const invalidImport = !workspaceScope && params.has("importId") && !importId;
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
    setWorkspaceScope(false);
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
  const [maintenanceSelection, setMaintenanceSelection] = useState<
    ReadonlySet<string>
  >(new Set());
  const [selectionScope, setSelectionScope] = useState<string | null>(null);

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
  useEffect(() => {
    if (response.selectionScope && response.selectionScope !== selectionScope) {
      setSelectionScope(response.selectionScope);
      setSelectedListings(new Map());
      setMaintenanceSelection(new Set());
    }
  }, [response.selectionScope, selectionScope]);
  const canMaintain =
    response.capabilities.canMaintainProducts ??
    response.capabilities.canGenerateBulkUpdate;
  const visibleSelected = new Set(
    response.items.flatMap((item) =>
      item.sourceType === "platform" || item.sourceType === "draft"
        ? item.listingId
          ? [item.listingId]
          : []
        : [],
    ),
  );
  const offPageCount = [...maintenanceSelection].filter(
    (id) => !visibleSelected.has(id),
  ).length;
  useEffect(() => {
    const blocked = new Set(
      response.items
        .filter(
          (item) =>
            (item.sourceType === "platform" || item.sourceType === "draft") &&
            item.readState === "blocked",
        )
        .map((item) => (item as PlatformCatalogItem).listingId),
    );
    if (blocked.size)
      setMaintenanceSelection(
        (current) => new Set([...current].filter((id) => !blocked.has(id))),
      );
    if (blocked.size)
      setSelectedListings((current) => {
        const next = new Map([...current].filter(([id]) => !blocked.has(id)));
        return next.size === current.size ? current : next;
      });
  }, [response.items]);

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
      }).filter(
        (item) =>
          !response.items.some(
            (row) =>
              row.sourceType === "platform" &&
              row.listingId === item.listingId &&
              row.readState === "blocked",
          ),
      ),
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
  function handleMetricChange(value: CatalogFilter) {
    setWorkspaceScope(true);
    handleFilterChange(value);
    const url = new URL(window.location.href);
    url.searchParams.delete("importId");
    window.history.replaceState(null, "", url.pathname + url.search);
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
          value={response.summary.drafts}
          label={localized(locale, "商品草稿流程", "Listing workflows")}
          onClick={() => handleMetricChange("drafts")}
        />
        <Metric
          value={response.summary.workbook}
          label={localized(locale, "試算表商品", "Workbook products")}
          onClick={() => handleMetricChange("workbook")}
        />
        <Metric
          value={response.summary.website}
          label={localized(locale, "網站商品", "Website products")}
          onClick={() => handleMetricChange("website")}
        />
        <Metric
          value={response.summary.unlinked}
          label={localized(
            locale,
            "未連結的平台商品",
            "Unlinked platform products",
          )}
          onClick={() => handleMetricChange("unlinked")}
        />
        <Metric
          value={response.summary.total}
          label={localized(
            locale,
            "目錄紀錄（包含參考資料）",
            "Catalog records (including references)",
          )}
          onClick={() => handleMetricChange("all")}
        />
        <Metric
          value={response.summary.linked}
          label={localized(
            locale,
            "已綁定 SHOPLINE 商品",
            "Bound SHOPLINE products",
          )}
          onClick={() => handleMetricChange("bound")}
        />
        <Metric
          value={response.summary.needsReview}
          label={localized(locale, "待審核", "Needs review")}
          onClick={() => handleMetricChange("review")}
        />
        <Metric
          value={response.summary.needsAttention}
          label={localized(locale, "需處理", "Attention")}
          onClick={() => handleMetricChange("attention")}
        />
        <Metric
          value={response.summary.published}
          label={localized(locale, "已發佈", "Published")}
          onClick={() => handleMetricChange("published")}
        />
      </div>

      <div className={styles.controlPanel}>
        <div className={styles.selectionBar} aria-live="polite">
          <strong>
            {localized(
              locale,
              `已選取 ${maintenanceSelection.size} 個商品作批量更新`,
              `${maintenanceSelection.size} selected for Bulk Update`,
            )}
          </strong>
          <button
            type="button"
            className={styles.pageButton}
            disabled={maintenanceSelection.size === 0}
            onClick={() => {
              setSelectedListings(new Map());
              setMaintenanceSelection(new Set());
            }}
          >
            {localized(locale, "清除選取", "Clear selection")}
          </button>
        </div>
        {offPageCount > 0 ? (
          <p>
            {localized(
              locale,
              `另有 ${offPageCount} 項不在目前篩選`,
              `${offPageCount} selected products are outside this filter`,
            )}
          </p>
        ) : null}
        {canMaintain && maintenanceSelection.size > 0 ? (
          <CreateBatchForm listingIds={[...maintenanceSelection]} />
        ) : null}
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
              `顯示第 ${page} 頁 · 符合 ${response.totalMatching} / ${response.summary.total} 筆目錄紀錄；${response.summary.referenceRows ?? response.summary.website + response.summary.workbook} 筆為參考資料`,
              `Page ${page} · ${response.totalMatching} matching / ${response.summary.total} catalog records; ${response.summary.referenceRows ?? response.summary.website + response.summary.workbook} are references`,
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
                  if (item.sourceType === "draft")
                    return (
                      <tr key={`draft:${item.id}`}>
                        <td>
                          {canMaintain && item.readState !== "blocked" ? (
                            <input
                              type="checkbox"
                              aria-label={localized(
                                locale,
                                `選取 ${item.sku ?? item.id} 作批量更新`,
                                `Select ${item.sku ?? item.id} for Bulk Update`,
                              )}
                              checked={maintenanceSelection.has(item.listingId)}
                              onChange={(event) =>
                                setMaintenanceSelection((current) => {
                                  const next = new Set(current);
                                  if (event.target.checked)
                                    next.add(item.listingId);
                                  else next.delete(item.listingId);
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
                            {item.sku ??
                              localized(locale, "未有 SKU", "No SKU")}
                          </span>
                        </td>
                        <td>
                          {localized(locale, "獨立草稿", "Standalone draft")}
                        </td>
                        <td>{stateLabel(item.listingStatus, locale)}</td>
                        <td>
                          {item.readState === "blocked" ? (
                            <SupportRequestId value={item.supportRequestId} />
                          ) : (
                            <SourceReadinessSummary
                              readiness={item.sourceReadiness}
                              compact
                            />
                          )}
                        </td>
                        <td>{item.openBlockingFlagCount}</td>
                        <td>
                          <Link
                            href={withWorkbenchReturn(
                              `/listings/${item.listingId}`,
                              returnTo,
                            )}
                          >
                            {localized(locale, "開啟草稿", "Open draft")}
                          </Link>
                        </td>
                      </tr>
                    );
                  const tone = catalogStatusTone(item.listingStatus);
                  return (
                    <tr key={`platform:${item.id}`}>
                      <td>
                        {(item.origin === "import" ||
                          response.capabilities.canMaintainProducts === true) &&
                        item.listingId &&
                        item.readState !== "blocked" &&
                        canMaintain ? (
                          <input
                            type="checkbox"
                            aria-label={localized(
                              locale,
                              `選取 ${item.sku ?? item.remoteProductId} 作批量更新`,
                              `Select ${item.sku ?? item.remoteProductId} for Bulk Update`,
                            )}
                            checked={maintenanceSelection.has(item.listingId)}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setMaintenanceSelection((current) => {
                                const next = new Set(current);
                                if (checked) next.add(item.listingId!);
                                else next.delete(item.listingId!);
                                return next;
                              });
                              if (item.origin === "import")
                                setSelectedListings((current) => {
                                  const next = new Map(current);
                                  if (checked) {
                                    // Capture the digest as shown right now --
                                    // this is what the operator is attesting
                                    // to, not whatever a later page happens to
                                    // find under this id.
                                    next.set(
                                      item.listingId!,
                                      item.contentDigest,
                                    );
                                  } else {
                                    next.delete(item.listingId!);
                                  }
                                  return next;
                                });
                            }}
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
                        {item.readState === "blocked" ? (
                          <div>
                            {localized(
                              locale,
                              "此列暫不可用",
                              "This row is unavailable",
                            )}
                            <SupportRequestId value={item.supportRequestId} />
                          </div>
                        ) : (
                          <SourceReadinessSummary
                            readiness={item.sourceReadiness}
                            compact
                          />
                        )}
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

function Metric({
  value,
  label,
  onClick,
}: {
  value: number | undefined;
  label: string;
  onClick?: () => void;
}) {
  const locale = useLocale();
  const labelId = useId();
  const content = (
    <>
      <span className={styles.metricValue}>
        {value === undefined ? "—" : formatNumber(value, locale)}
      </span>
      <span className={styles.metricLabel} id={labelId}>
        {label}
      </span>
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={styles.metric}
      aria-labelledby={labelId}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className={styles.metric} role="group" aria-labelledby={labelId}>
      {content}
    </div>
  );
}
