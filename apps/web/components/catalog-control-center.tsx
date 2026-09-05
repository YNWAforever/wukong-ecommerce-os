"use client";
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
import { useCallback, useId, useState } from "react";

import type { CatalogPage } from "../lib/catalog-contract";
import { useLatestRequest } from "../lib/use-latest-request";
import { SourceReadinessSummary } from "./source-readiness-summary";
import {
  CATALOG_FILTERS,
  type CatalogFilter,
  catalogStatusTone,
} from "./catalog-view-models";
import styles from "./catalog-control-center.module.css";
import { BulkExportPanel } from "./bulk-export-panel";

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

export function CatalogControlCenter() {
  const locale = useLocale();
  const c = commonCopy[locale];
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CatalogFilter>("all");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const loadCatalog = useCallback(
    async (signal: AbortSignal) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        q: query,
        filter,
      });
      const response = await fetch(`/api/catalog?${params.toString()}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok)
        throw new Error(`Unable to load catalog (${response.status})`);
      return (await response.json()) as CatalogPage;
    },
    [page, query, filter],
  );
  const { data, error, loading, stale, reload } = useLatestRequest(
    loadCatalog,
    "Unable to load catalog",
  );

  const response = data ?? EMPTY_RESPONSE;

  function handleQueryChange(value: string) {
    setQuery(value);
    setPage(1);
  }

  function handleFilterChange(value: CatalogFilter) {
    setFilter(value);
    setPage(1);
  }

  if (!data && error) {
    return (
      <div className="load-error" role="alert">
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
      <div className={styles.metrics}>
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
              `已選取 ${selectedIds.length} 個商品作批量更新`,
              `${selectedIds.length} selected for Bulk Update`,
            )}
          </strong>
          <button
            type="button"
            className={styles.pageButton}
            disabled={selectedIds.length === 0}
            onClick={() => setSelectedIds([])}
          >
            {localized(locale, "清除選取", "Clear selection")}
          </button>
        </div>
        <BulkExportPanel
          listingIds={selectedIds}
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
          <div className={styles.tableWrap}>
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
                  const tone = catalogStatusTone(item.listingStatus);
                  return (
                    <tr key={item.id}>
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
                            checked={selectedIds.includes(item.listingId)}
                            onChange={(event) =>
                              setSelectedIds((current) =>
                                event.target.checked
                                  ? current.includes(item.listingId!)
                                    ? current
                                    : [...current, item.listingId!]
                                  : current.filter(
                                      (id) => id !== item.listingId,
                                    ),
                              )
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
                            href={`/listings/${item.listingId}`}
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
