export type WorkbenchKind =
  | "listing"
  | "export"
  | "website_scan"
  | "workbook_import";

export type WorkbenchState =
  | "attention"
  | "progress"
  | "completed"
  | "unclassified";

export type WorkbenchQuery = {
  state: WorkbenchState;
  kind?: WorkbenchKind;
  page: number;
  pageSize: number;
};

export type WorkbenchReason =
  | "failed"
  | "needs_info"
  | "review"
  | "delivery"
  | "result_needed"
  | "processing"
  | "published"
  | "result_reported"
  | "preview_ready"
  | "preview_partial"
  | "imported"
  | "unknown";

export type WorkbenchItem = {
  key: string;
  id: string;
  kind: WorkbenchKind;
  state: WorkbenchState;
  reason: WorkbenchReason;
  title: string | null;
  sourceLabel: string | null;
  productCount: number | null;
  occurredAt: string;
  timestampKind: "updated" | "recorded";
};

export type WorkbenchPage = {
  items: WorkbenchItem[];
  counts: Record<WorkbenchState, number>;
  totalMatching: number;
  observedAt: string;
  page: number;
  pageSize: number;
};

export function classifyListing(status: string): WorkbenchReason {
  switch (status) {
    case "failed":
    case "publish_failed":
      return "failed";
    case "needs_info":
      return "needs_info";
    case "in_review":
    case "reopened":
      return "review";
    case "approved":
      return "delivery";
    case "received":
    case "processing":
    case "publishing":
      return "processing";
    case "published":
      return "published";
    default:
      return "unknown";
  }
}
