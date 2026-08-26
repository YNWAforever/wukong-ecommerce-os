"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type { CatalogResponse } from "../lib/catalog-contract";
import {
  CATALOG_FILTERS,
  type CatalogFilter,
  catalogStatusLabel,
  catalogStatusTone,
  filterCatalogItems,
} from "./catalog-view-models";
import styles from "./catalog-control-center.module.css";

const STATUS_TONE_CLASSES = {
  neutral: styles.statusNeutral,
  warning: styles.statusWarning,
  success: styles.statusSuccess,
  danger: styles.statusDanger,
} as const;

const EMPTY_RESPONSE: CatalogResponse = {
  items: [],
  summary: {
    total: 0,
    linked: 0,
    unlinked: 0,
    needsReview: 0,
    needsAttention: 0,
    published: 0,
  },
};

export function CatalogControlCenter() {
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CatalogFilter>("all");

  useEffect(() => {
    const controller = new AbortController();

    async function loadCatalog() {
      try {
        const response = await fetch("/api/catalog", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Unable to load catalog (${response.status})`);
        }
        setData((await response.json()) as CatalogResponse);
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
  }, []);

  const response = data ?? EMPTY_RESPONSE;
  const visibleItems = useMemo(
    () => filterCatalogItems(response.items, query, filter),
    [response.items, query, filter],
  );

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
              onChange={(event) => setQuery(event.target.value)}
              placeholder="SKU、商品名稱、SHOPLINE Product ID"
            />
          </label>
          <p className={styles.resultCount} aria-live="polite">
            顯示 {visibleItems.length} / {response.summary.total} 個商品
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
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {visibleItems.length === 0 ? (
          <div className={styles.emptyState}>
            <h2>找不到符合條件的商品</h2>
            <p>調整搜尋字詞或篩選條件，查看其他商品。</p>
          </div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
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
                {visibleItems.map((item) => {
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
      </div>

      <p className={styles.scopeNote}>
        此控制中心顯示最近 100
        個平台商品。下一階段會加入分頁、平台差異偵測、批量修正及庫存／價格同步。
      </p>
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
