"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { CatalogPage } from "../lib/catalog-contract";
import {
  CATALOG_FILTERS,
  type CatalogFilter,
  catalogStatusLabel,
  catalogStatusTone,
} from "./catalog-view-models";
import styles from "./catalog-control-center.module.css";

const STATUS_TONE_CLASSES = {
  neutral: styles.statusNeutral,
  warning: styles.statusWarning,
  success: styles.statusSuccess,
  danger: styles.statusDanger,
} as const;

const PAGE_SIZE = 25;

const EMPTY_RESPONSE: CatalogPage = {
  items: [],
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
  const [data, setData] = useState<CatalogPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CatalogFilter>("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const controller = new AbortController();

    async function loadCatalog() {
      try {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
          q: query,
          filter,
        });
        const response = await fetch(`/api/catalog?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Unable to load catalog (${response.status})`);
        }
        setData((await response.json()) as CatalogPage);
      } catch (loadError) {
        if (
          loadError instanceof DOMException &&
          loadError.name === "AbortError"
        ) {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load catalog",
        );
      }
    }

    void loadCatalog();
    return () => controller.abort();
  }, [page, query, filter]);

  const response = data ?? EMPTY_RESPONSE;

  function handleQueryChange(value: string) {
    setQuery(value);
    setPage(1);
  }

  function handleFilterChange(value: CatalogFilter) {
    setFilter(value);
    setPage(1);
  }

  if (error) {
    return (
      <p className="inline-warning" role="alert">
        {error}
      </p>
    );
  }

  if (!data) {
    return (
      <p className="helper-copy" role="status">
        正在載入商品控制中心… Loading catalog control center…
      </p>
    );
  }

  return (
    <section aria-label="商品控制中心">
      <div className={styles.metrics}>
        <Metric value={response.summary.total} label="商品 Products" />
        <Metric value={response.summary.linked} label="已連結 Linked" />
        <Metric
          value={response.summary.needsReview}
          label="待審核 Needs review"
        />
        <Metric
          value={response.summary.needsAttention}
          label="需處理 Attention"
        />
        <Metric value={response.summary.published} label="已發佈 Published" />
      </div>

      <div className={styles.controlPanel}>
        <div className={styles.toolbar}>
          <label className={styles.searchField}>
            <span>搜尋商品 Search catalog</span>
            <input
              type="search"
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              placeholder="SKU、商品名稱、SHOPLINE Product ID"
            />
          </label>
          <p className={styles.resultCount} aria-live="polite">
            顯示第 {page} 頁 · 符合 {response.totalMatching} /{" "}
            {response.summary.total} 個商品
          </p>
        </div>

        <div className={styles.filters} aria-label="商品篩選">
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
              {option.label}
            </button>
          ))}
        </div>

        {response.items.length === 0 ? (
          <div className={styles.emptyState}>
            <h2>找不到符合條件的商品</h2>
            <p>調整搜尋字詞或篩選條件，查看其他商品。</p>
          </div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table} aria-label="商品控制中心">
              <thead>
                <tr>
                  <th scope="col">商品 Product</th>
                  <th scope="col">來源 Source</th>
                  <th scope="col">工作流程 Workflow</th>
                  <th scope="col">阻塞 Blockers</th>
                  <th scope="col">
                    <span className={styles.visuallyHidden}>操作 Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {response.items.map((item) => {
                  const tone = catalogStatusTone(item.listingStatus);
                  return (
                    <tr key={item.id}>
                      <td>
                        <strong className={styles.productTitle}>
                          {item.title}
                        </strong>
                        <span className={styles.productMeta}>
                          {item.sku ?? "未有 SKU"} · {item.remoteProductId}
                        </span>
                      </td>
                      <td>
                        <span className={styles.originBadge}>
                          {item.origin === "import"
                            ? "匯入 Import"
                            : "建立 Created"}
                        </span>
                        <span className={styles.specVersion}>
                          {item.specVersion ?? "API"}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`${styles.statusBadge} ${STATUS_TONE_CLASSES[tone]}`}
                        >
                          {catalogStatusLabel(item.listingStatus)}
                        </span>
                      </td>
                      <td>
                        {item.openBlockingFlagCount === null ? (
                          <span className={styles.mutedValue}>—</span>
                        ) : item.openBlockingFlagCount > 0 ? (
                          <span className={styles.blockerCount}>
                            {item.openBlockingFlagCount} blocking
                          </span>
                        ) : (
                          <span className={styles.clearValue}>0 clear</span>
                        )}
                      </td>
                      <td className={styles.actionCell}>
                        {item.listingId ? (
                          <Link
                            className={styles.actionLink}
                            href={`/listings/${item.listingId}`}
                          >
                            開啟流程 Open
                          </Link>
                        ) : (
                          <Link
                            className={styles.actionLink}
                            href="/listings/new"
                          >
                            建立草稿 Start draft
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

        <div className={styles.paginationControls} aria-label="分頁">
          <button
            type="button"
            className={styles.pageButton}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page === 1}
          >
            上一頁 Previous
          </button>
          <span className={styles.pageIndicator}>第 {page} 頁</span>
          <button
            type="button"
            className={styles.pageButton}
            onClick={() => setPage((current) => current + 1)}
            disabled={response.totalMatching <= page * PAGE_SIZE}
          >
            下一頁 Next
          </button>
        </div>
      </div>
    </section>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className={styles.metric}>
      <span className={styles.metricValue}>{value}</span>
      <span className={styles.metricLabel}>{label}</span>
    </div>
  );
}
