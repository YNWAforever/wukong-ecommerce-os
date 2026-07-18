"use client";

import type {
  CanonicalListing,
  ComplianceFlag,
  FieldEvidence,
  ListingStatus,
} from "@wukong/core";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ComplianceFlags } from "./compliance-flags";
import { DeliveryPanel } from "./delivery-panel";
import { EvidencePanel } from "./evidence-panel";
import { ListingFieldsForm } from "./listing-fields-form";
import { ListingProcessingPanel } from "./listing-processing-panel";
import type {
  BlockingFlag,
  DeliveryModel,
  Evidence,
  ListingField,
  ListingReviewModel,
} from "./listing-view-models";

type ListingPermissions = {
  canProcess: boolean;
  canEdit: boolean;
  canResolveFlags: boolean;
  canApprove: boolean;
  canDeliver: boolean;
};

export type ListingViewResponse = {
  listingId: string;
  status: ListingStatus;
  activeVersion: {
    id: string;
    sequence: number;
    content: CanonicalListing;
  } | null;
  evidence: FieldEvidence[];
  flags: ComplianceFlag[];
  connection: "connected" | "disconnected" | "error";
  delivery: {
    status: string;
    remoteProductId: string | null;
    error: string | null;
  } | null;
  queueStatus: string | null;
  permissions: ListingPermissions;
};

type MappedListingView = {
  model: ListingReviewModel;
  delivery: DeliveryModel;
  permissions: ListingPermissions;
  evidence: Array<Evidence & { field: string }>;
};

type ProcessingStatus = Extract<
  ListingStatus,
  "received" | "processing" | "needs_info" | "failed"
>;

const processingStatuses = new Set<ListingStatus>([
  "received",
  "processing",
  "needs_info",
  "failed",
]);

function isProcessingStatus(
  status: ListingStatus | null,
): status is ProcessingStatus {
  return status !== null && processingStatuses.has(status);
}

export type ListingViewRenderState =
  | { kind: "error"; message: string }
  | { kind: "loading" }
  | { kind: "processing"; status: ProcessingStatus }
  | { kind: "ready" };

export function resolveListingViewState(input: {
  snapshotStatus: ListingStatus | null;
  hasSnapshot: boolean;
  hasMappedView: boolean;
  loadError: string | null;
  mappingError: string | null;
}): ListingViewRenderState {
  if (input.loadError && !input.hasSnapshot) {
    return { kind: "error", message: input.loadError };
  }
  if (input.mappingError) {
    return { kind: "error", message: input.mappingError };
  }
  if (
    input.hasSnapshot &&
    !input.hasMappedView &&
    isProcessingStatus(input.snapshotStatus)
  ) {
    return { kind: "processing", status: input.snapshotStatus };
  }
  if (!input.hasSnapshot || !input.hasMappedView) {
    return { kind: "loading" };
  }
  return { kind: "ready" };
}

const labels: Record<
  ComplianceFlag["rule"],
  { label: string; description: string }
> = {
  health_claim: {
    label: "健康功效聲稱",
    description: "移除未有來源支持的健康功效描述，或記錄審核理由。",
  },
  guarantee: {
    label: "保證式聲稱",
    description: "移除無法證實的保證式描述，或記錄審核理由。",
  },
  rating_without_evidence: {
    label: "評分欠缺來源",
    description: "補充評分來源，或記錄移除／保留理由。",
  },
  superlative: {
    label: "最高級聲稱",
    description: "核對最高級聲稱的來源，或記錄處理理由。",
  },
};

function reviewStatus(status: ListingStatus): ListingReviewModel["status"] {
  if (status === "reopened") return "in_review";
  if (status === "publishing") return "approved";
  if (status === "publish_failed") return "failed";
  return status;
}

function evidenceFor(
  evidence: FieldEvidence[],
  field: string,
): { confidence: number | null; evidence: Evidence | null } {
  const match = evidence.find((entry) => entry.field === field);
  if (!match) return { confidence: null, evidence: null };
  return {
    confidence: match.confidence,
    evidence: {
      excerpt: match.excerpt,
      source: match.sourceAssetId,
      page: match.page,
    },
  };
}

function field(
  evidence: FieldEvidence[],
  input: Omit<ListingField, "confidence" | "evidence"> & {
    evidenceKey?: string;
  },
): ListingField {
  const { evidenceKey = input.key, ...definition } = input;
  return { ...definition, ...evidenceFor(evidence, evidenceKey) };
}

export function mapListingView(
  response: ListingViewResponse,
): MappedListingView {
  const version = response.activeVersion;
  if (!version) throw new Error("Listing is not ready for review");
  const content = version.content;
  const fields: ListingField[] = [
    field(response.evidence, {
      key: "sku",
      label: "SKU",
      englishLabel: "SKU",
      value: content.sku,
    }),
    field(response.evidence, {
      key: "producer",
      label: "生產者",
      englishLabel: "Producer",
      value: content.producer,
    }),
    field(response.evidence, {
      key: "productType",
      label: "商品類型",
      englishLabel: "Product type",
      value: content.productType,
    }),
    field(response.evidence, {
      key: "country",
      label: "國家",
      englishLabel: "Country",
      value: content.country,
    }),
    field(response.evidence, {
      key: "region",
      label: "地區",
      englishLabel: "Region",
      value: content.region,
    }),
    field(response.evidence, {
      key: "vintage",
      label: "年份",
      englishLabel: "Vintage",
      value: content.vintage,
      kind: "number",
    }),
    field(response.evidence, {
      key: "grapeVarieties",
      label: "葡萄品種",
      englishLabel: "Grape varieties",
      value: content.grapeVarieties.join(", "),
    }),
    field(response.evidence, {
      key: "volumeMl",
      label: "容量（毫升）",
      englishLabel: "Volume (ml)",
      value: content.volumeMl,
      kind: "number",
    }),
    field(response.evidence, {
      key: "abvPercent",
      label: "酒精濃度（%）",
      englishLabel: "ABV (%)",
      value: content.abvPercent,
      kind: "number",
    }),
    field(response.evidence, {
      key: "packQuantity",
      label: "每套數量",
      englishLabel: "Pack quantity",
      value: content.packQuantity,
      kind: "number",
    }),
    field(response.evidence, {
      key: "priceHkd",
      label: "售價（HKD）",
      englishLabel: "Price (HKD)",
      value: content.priceHkd,
      kind: "number",
    }),
    field(response.evidence, {
      key: "stockQuantity",
      label: "庫存數量",
      englishLabel: "Stock quantity",
      value: content.stockQuantity,
      kind: "number",
    }),
    field(response.evidence, {
      key: "titleZhHant",
      label: "商品名稱（繁中）",
      englishLabel: "Title (Traditional Chinese)",
      value: content.title["zh-Hant"],
      evidenceKey: "title.zh-Hant",
    }),
    field(response.evidence, {
      key: "titleEn",
      label: "商品名稱（英文）",
      englishLabel: "Title (English)",
      value: content.title.en,
      evidenceKey: "title.en",
    }),
    field(response.evidence, {
      key: "descriptionZhHant",
      label: "商品描述（繁中）",
      englishLabel: "Description (Traditional Chinese)",
      value: content.description["zh-Hant"],
      evidenceKey: "description.zh-Hant",
      kind: "textarea",
    }),
    field(response.evidence, {
      key: "descriptionEn",
      label: "商品描述（英文）",
      englishLabel: "Description (English)",
      value: content.description.en,
      evidenceKey: "description.en",
      kind: "textarea",
    }),
  ];
  const blockingFlags: BlockingFlag[] = response.flags.map((flag) => ({
    id: flag.id,
    code: flag.rule,
    field: flag.field,
    label: labels[flag.rule]?.label ?? flag.rule,
    description: labels[flag.rule]?.description ?? flag.field,
    status: flag.status,
    resolutionReason: flag.resolutionReason,
  }));
  const status = reviewStatus(response.status);
  return {
    model: {
      id: response.listingId,
      versionId: version.id,
      status,
      title: content.title["zh-Hant"] || content.title.en,
      fields,
      blockingFlags,
    },
    delivery: {
      connection: response.connection,
      status,
      canReview: response.permissions.canDeliver,
      remoteProductUrl: null,
    },
    permissions: response.permissions,
    evidence: response.evidence.map((entry) => ({
      field: entry.field,
      excerpt: entry.excerpt,
      source: entry.sourceAssetId,
      page: entry.page,
    })),
  };
}

function valueOf(fields: ListingField[], key: string): string {
  const value = fields.find((entry) => entry.key === key)?.value;
  return value === null || value === undefined ? "" : String(value).trim();
}

function requiredNumber(fields: ListingField[], key: string): number {
  const raw = valueOf(fields, key);
  const value = Number(raw);
  if (!raw || !Number.isFinite(value))
    throw new Error(`${key} must be a valid number`);
  return value;
}

function optionalNumber(fields: ListingField[], key: string): number | null {
  const raw = valueOf(fields, key);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a valid number`);
  return value;
}

export function applyListingFields(
  current: CanonicalListing,
  fields: ListingField[],
): CanonicalListing {
  return {
    ...current,
    sku: valueOf(fields, "sku"),
    producer: valueOf(fields, "producer"),
    productType: valueOf(
      fields,
      "productType",
    ) as CanonicalListing["productType"],
    country: valueOf(fields, "country"),
    region: valueOf(fields, "region") || null,
    vintage: optionalNumber(fields, "vintage"),
    grapeVarieties: valueOf(fields, "grapeVarieties")
      .split(/[,，]/)
      .map((value) => value.trim())
      .filter(Boolean),
    volumeMl: requiredNumber(fields, "volumeMl"),
    abvPercent: requiredNumber(fields, "abvPercent"),
    packQuantity: requiredNumber(fields, "packQuantity"),
    priceHkd: requiredNumber(fields, "priceHkd"),
    stockQuantity: optionalNumber(fields, "stockQuantity"),
    title: {
      en: valueOf(fields, "titleEn"),
      "zh-Hant": valueOf(fields, "titleZhHant"),
    },
    description: {
      en: valueOf(fields, "descriptionEn"),
      "zh-Hant": valueOf(fields, "descriptionZhHant"),
    },
  };
}

async function responseError(response: Response): Promise<Error> {
  const fallback = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { message?: string };
    return new Error(body.message || fallback);
  } catch {
    return new Error(fallback);
  }
}

export function ListingReviewClient({
  listingId,
  initialProcessing,
}: {
  listingId: string;
  initialProcessing?: "queued" | "retry_required";
}) {
  const [snapshot, setSnapshot] = useState<ListingViewResponse | null>(null);
  const [processingState, setProcessingState] = useState(initialProcessing);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(`/api/listings/${listingId}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw await responseError(response);
      const next = (await response.json()) as ListingViewResponse;
      setSnapshot(next);
      if (
        next.status === "processing" ||
        next.status === "needs_info" ||
        next.status === "in_review" ||
        next.status === "failed"
      ) {
        setProcessingState(undefined);
      }
    },
    [listingId],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((loadError: unknown) => {
      if (loadError instanceof DOMException && loadError.name === "AbortError")
        return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load listing.",
      );
    });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (snapshot?.status !== "received" && snapshot?.status !== "processing")
      return;
    const timer = window.setInterval(() => {
      load().catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : "Unable to refresh listing.",
        );
      });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [load, snapshot?.status]);

  let mapped: MappedListingView | null = null;
  let mappingError: string | null = null;
  if (
    snapshot &&
    !(snapshot.activeVersion === null && isProcessingStatus(snapshot.status))
  ) {
    try {
      mapped = mapListingView(snapshot);
    } catch (cause) {
      mappingError =
        cause instanceof Error ? cause.message : "Unable to load listing.";
    }
  }

  const run = useCallback(
    async (work: () => Promise<void>, success: string) => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        await work();
        setMessage(success);
      } catch (runError) {
        setError(
          runError instanceof Error
            ? runError.message
            : "Unable to complete request.",
        );
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  async function startProcessing() {
    await run(async () => {
      const response = await fetch(`/api/listings/${listingId}/process`, {
        method: "POST",
      });
      if (!response.ok) throw await responseError(response);
      setProcessingState("queued");
      await load();
    }, "已加入處理佇列 · Processing queued");
  }

  const viewState = resolveListingViewState({
    snapshotStatus: snapshot?.status ?? null,
    hasSnapshot: Boolean(snapshot),
    hasMappedView: Boolean(mapped),
    loadError: error,
    mappingError,
  });

  if (viewState.kind === "error")
    return (
      <div className="page-wrap">
        <p className="inline-warning" role="alert">
          {viewState.message}
        </p>
      </div>
    );
  if (viewState.kind === "processing" && snapshot)
    return (
      <div className="page-wrap review-page" aria-busy={busy}>
        {error ? (
          <p className="inline-warning" role="alert">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="success-note" role="status">
            {message}
          </p>
        ) : null}
        <ListingProcessingPanel
          status={viewState.status}
          enqueueState={processingState}
          canProcess={snapshot.permissions.canProcess}
          onProcess={startProcessing}
          busy={busy}
        />
      </div>
    );
  if (viewState.kind === "loading" || !snapshot || !mapped)
    return (
      <div className="page-wrap">
        <p className="helper-copy" role="status">
          正在載入商品資料… Loading listing…
        </p>
      </div>
    );

  const { model, delivery, permissions, evidence } = mapped;
  const content = snapshot.activeVersion?.content;

  async function save(fields: ListingField[], baseVersionId: string) {
    if (!content) throw new Error("Listing is not ready for review");
    await run(async () => {
      const response = await fetch(`/api/listings/${listingId}/review`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseVersionId,
          listing: applyListingFields(content, fields),
        }),
      });
      if (!response.ok) throw await responseError(response);
      await load();
    }, "草稿已儲存 · Draft saved");
  }

  async function approve() {
    await run(async () => {
      const response = await fetch(`/api/listings/${listingId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw await responseError(response);
      await load();
    }, "商品已批准 · Listing approved");
  }

  async function resolveFlag(flagId: string, reason: string) {
    await run(async () => {
      const response = await fetch(`/api/listings/${listingId}/flags/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionId: model.versionId, flagId, reason }),
      });
      if (!response.ok) throw await responseError(response);
      await load();
    }, "合規提示已處理 · Compliance flag resolved");
  }

  async function exportCsv() {
    await run(async () => {
      const response = await fetch(`/api/listings/${listingId}/deliver`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "csv" }),
      });
      if (!response.ok) throw await responseError(response);
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename =
        disposition.match(/filename="([^"]+)"/)?.[1] ?? `${listingId}.csv`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    }, "CSV 已下載 · CSV downloaded");
  }

  async function publish() {
    await run(async () => {
      const response = await fetch(`/api/listings/${listingId}/deliver`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "shopline_api" }),
      });
      if (!response.ok) throw await responseError(response);
      await load();
    }, "已加入 SHOPLINE 發布佇列 · Publish queued");
  }

  return (
    <div className="page-wrap review-page" aria-busy={busy}>
      <div className="breadcrumb">
        <Link href="/dashboard">工作台</Link>
        <span aria-hidden="true">/</span>
        <span>{model.title}</span>
      </div>
      <div className="review-header">
        <div>
          <p className="eyebrow">
            商品審核 <span>LISTING REVIEW · {model.id}</span>
          </p>
          <h1>{model.title}</h1>
          <p className="lede">確認 AI 建議、核對來源，然後交由審核員批准。</p>
        </div>
        <span className={`review-status status-${model.status}`}>
          <span aria-hidden="true" />
          {model.status}
          <small>Current status</small>
        </span>
      </div>
      {error ? (
        <p className="inline-warning" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="success-note" role="status">
          {message}
        </p>
      ) : null}
      <div className="review-layout">
        <EvidencePanel evidence={evidence} />
        <div className="review-content">
          <ListingFieldsForm
            key={model.versionId}
            model={model}
            canApprove={permissions.canApprove && !busy}
            canEdit={permissions.canEdit && !busy}
            onApprove={approve}
            onSave={save}
          />
          <ComplianceFlags
            flags={model.blockingFlags}
            canResolve={permissions.canResolveFlags && !busy}
            onResolve={resolveFlag}
          />
          <DeliveryPanel
            model={{ ...delivery, canReview: delivery.canReview && !busy }}
            onCsv={exportCsv}
            onPublish={publish}
          />
        </div>
      </div>
    </div>
  );
}
