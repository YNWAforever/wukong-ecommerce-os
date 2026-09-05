import { localized } from "./ui-copy";
import { DEFAULT_LOCALE, type Locale } from "./locale";
import type { ListingStatus } from "@wukong/core";
import type { SourceReadiness } from "./source-readiness";

import type { QueueItem, QueueStatus } from "../components/listing-view-models";

export type ListingReviewContext = {
  expectedVersionId: string;
  confirmationLedgerRevision: number;
  expectedSourceImportId?: string;
  expectedRowDigest?: string;
};

export type ListingCollectionItem = {
  sourceReadiness?: SourceReadiness;
  id: string;
  status: ListingStatus;
  target: "shopline";
  title: string;
  sku: string | null;
  updatedAt: string;
  openBlockingFlagCount: number;
  reviewContext: ListingReviewContext | null;
};

function queueStatus(status: ListingStatus): QueueStatus {
  if (status === "reopened") return "in_review";
  if (status === "publish_failed") return "failed";
  return status;
}

const nextActions: Record<QueueStatus, string> = {
  received: "查看草稿",
  processing: "查看處理狀態",
  needs_info: "補充資料",
  in_review: "繼續審核",
  approved: "準備上架",
  publishing: "查看發布狀態",
  published: "查看商品",
  failed: "查看錯誤",
};

export function mapDashboardItems(
  items: ListingCollectionItem[],
  locale: Locale = DEFAULT_LOCALE,
): QueueItem[] {
  return items.map((item) => {
    const status = queueStatus(item.status);
    return {
      id: item.id,
      title: item.title,
      subtitle: `${item.sku ?? localized(locale, "未有 SKU", "No SKU")} · SHOPLINE`,
      status,
      updatedAt: item.updatedAt,
      nextAction:
        locale === "zh-Hant"
          ? nextActions[status]
          : {
              received: "View draft",
              processing: "View processing status",
              needs_info: "Add information",
              in_review: "Continue review",
              approved: "Prepare delivery",
              publishing: "View delivery status",
              published: "View product",
              failed: "View error",
            }[status],
      openBlockingFlagCount: item.openBlockingFlagCount,
    };
  });
}
