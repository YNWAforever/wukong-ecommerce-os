import { queueLabels } from "./queue-labels";

export type QueueStatus =
  | "received"
  | "processing"
  | "needs_info"
  | "in_review"
  | "approved"
  | "publishing"
  | "published"
  | "failed";

export type QueueItem = {
  id: string;
  title: string;
  subtitle: string;
  status: QueueStatus;
  updatedAt: string;
  nextAction: string;
  /** 0 means eligible for bulk approval when status is "in_review". */
  openBlockingFlagCount: number;
};

export type Evidence = {
  excerpt: string;
  source: string;
  page: number | null;
};

export type ListingField = {
  key: string;
  label: string;
  englishLabel: string;
  value: string | number | null;
  confidence: number | null;
  evidence: Evidence | null;
  kind?: "text" | "number" | "textarea";
};

export type BlockingFlag = {
  id: string;
  code: string;
  field: string;
  label: string;
  description: string;
  status: "open" | "resolved";
  resolutionReason: string | null;
};

export type ListingReviewModel = {
  id: string;
  versionId: string;
  status:
    | "received"
    | "processing"
    | "needs_info"
    | "in_review"
    | "approved"
    | "published"
    | "failed";
  title?: string;
  fields: ListingField[];
  blockingFlags: BlockingFlag[];
};

export type DeliveryModel = {
  connection: "disconnected" | "error" | "connected";
  status: ListingReviewModel["status"];
  canReview: boolean;
  remoteProductUrl: string | null;
  remoteProductId: string | null;
  shoplineLink: {
    remoteProductId: string;
    origin?: "import" | "created";
  } | null;
  listingId?: string;
  versionId?: string;
  canRecordImportResult?: boolean;
  historicalImportResults?: Array<{
    id: string;
    outcome: "accepted" | "rejected";
    rejectReason: string | null;
    correctionReason: string | null;
    revision: number;
    createdAt: string;
  }>;
};

export const queueGroups: ReadonlyArray<{
  status: QueueStatus;
  label: string;
  englishLabel: string;
}> = [
  { status: "received", label: queueLabels.received, englishLabel: "Received" },
  {
    status: "processing",
    label: queueLabels.processing,
    englishLabel: "Processing",
  },
  {
    status: "needs_info",
    label: "需要資料",
    englishLabel: "Needs information",
  },
  { status: "in_review", label: "待審核", englishLabel: "In review" },
  { status: "approved", label: "已批准", englishLabel: "Approved" },
  { status: "published", label: "已上架", englishLabel: "Published" },
  {
    status: "publishing",
    label: queueLabels.publishing,
    englishLabel: "Publishing",
  },
  { status: "failed", label: "失敗", englishLabel: "Failed" },
];

export const fallbackQueue: QueueItem[] = [
  {
    id: "opak-demo-001",
    title: "Mosel Riesling Kabinett 2024",
    subtitle: "OPAK-DEMO-001 · 德國摩澤爾 · HK$288",
    status: "in_review",
    updatedAt: "剛剛更新",
    nextAction: "繼續審核",
    openBlockingFlagCount: 0,
  },
  {
    id: "opak-demo-002",
    title: "Domaine de la Rivière",
    subtitle: "OPAK-DEMO-002 · 法國隆河 · HK$398",
    status: "needs_info",
    updatedAt: "12 分鐘前",
    nextAction: "補充資料",
    openBlockingFlagCount: 0,
  },
  {
    id: "opak-demo-003",
    title: "Kita no Hikari Junmai",
    subtitle: "OPAK-DEMO-003 · 日本北海道 · HK$268",
    status: "approved",
    updatedAt: "昨天",
    nextAction: "準備上架",
    openBlockingFlagCount: 0,
  },
  {
    id: "opak-demo-004",
    title: "Barolo Riserva 2018",
    subtitle: "OPAK-ARCHIVE-004 · 意大利皮埃蒙特 · HK$880",
    status: "published",
    updatedAt: "3 天前",
    nextAction: "查看商品",
    openBlockingFlagCount: 0,
  },
  {
    id: "opak-demo-005",
    title: "Estate Rosé 2023",
    subtitle: "OPAK-DEMO-005 · 澳洲南澳 · HK$228",
    status: "failed",
    updatedAt: "4 天前",
    nextAction: "查看錯誤",
    openBlockingFlagCount: 0,
  },
];

export const fallbackReviewModel: ListingReviewModel = {
  id: "opak-demo-001",
  versionId: "version-opak-demo-001",
  status: "in_review",
  title: "Mosel Riesling Kabinett 2024",
  fields: [
    {
      key: "producer",
      label: "生產者",
      englishLabel: "Producer",
      value: "Weingut Opak",
      confidence: 0.96,
      evidence: {
        excerpt: "Producer: Weingut Opak",
        source: "supplier-sheet.txt",
        page: null,
      },
    },
    {
      key: "productType",
      label: "商品類型",
      englishLabel: "Product type",
      value: "wine",
      confidence: 0.99,
      evidence: {
        excerpt: "White wine · Riesling",
        source: "bottle-label.svg",
        page: null,
      },
    },
    {
      key: "country",
      label: "國家／地區",
      englishLabel: "Country / region",
      value: "德國 · 摩澤爾",
      confidence: 0.94,
      evidence: {
        excerpt: "Germany · Mosel",
        source: "supplier-sheet.txt",
        page: 1,
      },
    },
    {
      key: "vintage",
      label: "年份",
      englishLabel: "Vintage",
      value: 2024,
      confidence: 0.98,
      evidence: {
        excerpt: "Vintage: 2024",
        source: "bottle-label.svg",
        page: null,
      },
      kind: "number",
    },
    {
      key: "volumeMl",
      label: "容量（毫升）",
      englishLabel: "Volume (ml)",
      value: 750,
      confidence: 0.99,
      evidence: { excerpt: "750 ml", source: "bottle-label.svg", page: null },
      kind: "number",
    },
    {
      key: "abvPercent",
      label: "酒精濃度（%）",
      englishLabel: "ABV (%)",
      value: 12.5,
      confidence: 0.98,
      evidence: {
        excerpt: "Alcohol: 12.5% vol",
        source: "supplier-sheet.txt",
        page: 1,
      },
      kind: "number",
    },
    {
      key: "priceHkd",
      label: "售價（HKD）",
      englishLabel: "Price (HKD)",
      value: 288,
      confidence: 0.99,
      evidence: {
        excerpt: "Retail price: HK$288",
        source: "supplier-sheet.txt",
        page: 1,
      },
      kind: "number",
    },
    {
      key: "stockQuantity",
      label: "庫存數量",
      englishLabel: "Stock quantity",
      value: null,
      confidence: null,
      evidence: null,
      kind: "number",
    },
    {
      key: "description",
      label: "商品描述",
      englishLabel: "Description",
      value: "以清晰、克制的方式描述酒款風格與來源。",
      confidence: 0.88,
      evidence: {
        excerpt: "Dry Riesling from the Mosel valley.",
        source: "supplier-sheet.txt",
        page: 1,
      },
      kind: "textarea",
    },
  ],
  blockingFlags: [
    {
      id: "description:health_claim:0",
      code: "health_claim",
      field: "description",
      label: "健康功效聲稱",
      description: "移除未有來源支持的健康功效描述，或由審核員記錄處理理由。",
      status: "open",
      resolutionReason: null,
    },
  ],
};
