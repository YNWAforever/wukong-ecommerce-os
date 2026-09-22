"use client";
import { WineEnrichmentWorkspace } from "./wine-enrichment-workspace";
import type { WineProgress } from "../lib/wine-progress";
import { ListingWorkingCopy } from "./listing-working-copy";
import type {
  WorkingListing,
  WorkingFieldStates,
  ResolvedSourceSelection,
} from "@wukong/core";
import { reviewErrorLabel } from "../lib/approval-ui-copy";
import { useLocale } from "../lib/locale-context";
import { REVIEW_FIELD_BINDINGS } from "../lib/review-field-bindings";
import { localized, commonCopy, stateLabel, safeUiError } from "../lib/ui-copy";

import type {
  CanonicalListing,
  ComplianceFlag,
  FieldEvidence,
  ListingStatus,
  ReviewableListing,
} from "@wukong/core";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { ActivityPanel } from "./activity-panel";
import { ComplianceFlags } from "./compliance-flags";
import { ConfirmationChecklist } from "./confirmation-checklist";
import { DeliveryPanel } from "./delivery-panel";
import { EvidencePanel } from "./evidence-panel";
import { ListingFieldsForm } from "./listing-fields-form";
import { ListingExtractedFacts } from "./listing-extracted-facts";
import { ListingProcessingPanel } from "./listing-processing-panel";
import type { ListingProcessingSummary } from "../lib/listing-processing-summary";
import type {
  BlockingFlag,
  DeliveryModel,
  Evidence,
  ListingField,
  ListingReviewModel,
} from "./listing-view-models";
import { ProductShotReview } from "./product-shot-review";
import { ProductShotPanel, type BackgroundChoice } from "./product-shot-panel";
import { SourceReadinessSummary } from "./source-readiness-summary";
import type { SourceReadiness } from "../lib/source-readiness";

type ListingPermissions = {
  canProcess: boolean;
  canEdit: boolean;
  canResolveFlags: boolean;
  canApprove: boolean;
  canDeliver: boolean;
  canRecordImportResult?: boolean;
};

// The wire shape of `ListingActivityEntry` (see lib/listing-activity-service.ts):
// `createdAt` is a real `Date` server-side, but `jsonResponse` runs it through
// `JSON.stringify`, so it arrives here as an ISO string, not a `Date`
// instance -- `new Date(entry.createdAt)` is required before any formatting,
// not optional convenience. Mirrors jobs-ledger-client.tsx's own
// `WireLedgerEntry` pattern for the same reason.
type WireListingActivityEntry =
  | {
      kind: "audit";
      id: string;
      action: string;
      metadata: unknown;
      createdAt: string;
    }
  | {
      kind: "batch";
      id: string;
      label: string;
      status: string;
      createdAt: string;
    }
  | {
      kind: "export";
      id: string;
      outcome: string;
      reason?: string;
      createdAt: string;
    };

export type ListingViewResponse = {
  wineProgress?: WineProgress | null;
  inputRevision?: number;
  workingInput?: {
    revision: number;
    baseVersionId: string | null;
    note: string | null;
    workingContent: WorkingListing;
    fieldStates: WorkingFieldStates;
    sources: ResolvedSourceSelection[];
  };
  sources?: {
    assetId: string;
    mimeType: string;
    name: string;
    previewUrl: string;
  }[];
  currentRun?: {
    runId: string;
    state: string;
    attempt: number;
    retryOfRunId: string | null;
    acceptedAt: string;
    errorCode: string | null;
    inputRevision: number;
    baseVersionId: string | null;
  } | null;
  sourceReadiness?: SourceReadiness;
  listingId: string;
  status: ListingStatus;
  activeVersion: {
    id: string;
    sequence: number;
    content: ReviewableListing;
  } | null;
  evidence: FieldEvidence[];
  flags: ComplianceFlag[];
  connection: "connected" | "disconnected" | "error";
  productShotWorkflow?: boolean;
  productShot: {
    previewUrl: string;
    brandBackgroundColor: string | null;
  } | null;
  delivery: {
    status: string;
    remoteProductId: string | null;
    error: string | null;
  } | null;
  queueStatus: string | null;
  shoplineLink: {
    remoteProductId: string;
    origin: "import" | "created";
  } | null;
  reviewConfirmation: {
    revision: number;
    fieldConfirmations: Record<string, boolean>;
    negativeConfirmations: Record<string, boolean>;
  } | null;
  sourceImportId: string | null;
  contentDigest: string | null;
  permissions: ListingPermissions;
  historicalImportResults?: Array<{
    id: string;
    outcome: "accepted" | "rejected";
    rejectReason: string | null;
    correctionReason: string | null;
    revision: number;
    createdAt: string;
  }>;
  activity: WireListingActivityEntry[];
  // Facts the extraction step already recorded. Present even when the run
  // ended in needs_info and wrote no version, which is exactly when the rest
  // of this snapshot has nothing to show.
  processing?: ListingProcessingSummary | null;
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
  // The workspace policy says exclusivity claims require evidence, but the
  // listing schema carries no exclusivity fact to check against, so the flag
  // asks a person rather than asserting the claim is unsupported.
  exclusivity: {
    label: "獨家聲稱",
    description: "補充獨家代理或供應的證明，或記錄移除／保留理由。",
  },
};

function reviewStatus(status: ListingStatus): ListingReviewModel["status"] {
  // `reopened` is shown as itself: an approval that stopped holding must not
  // look like a listing that was never approved.
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
      evidenceKey: REVIEW_FIELD_BINDINGS.nameZh.evidenceKey,
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
      evidenceKey: REVIEW_FIELD_BINDINGS.summaryZh.evidenceKey,
      kind: "textarea",
    }),
    field(response.evidence, {
      key: "descriptionEn",
      label: "商品描述（英文）",
      englishLabel: "Description (English)",
      value: content.description.en,
      evidenceKey: REVIEW_FIELD_BINDINGS.summaryEn.evidenceKey,
      kind: "textarea",
    }),
    field(response.evidence, {
      key: "seoTitleEn",
      label: "SEO 標題（英文）",
      englishLabel: "SEO title (English)",
      value: content.seo.title.en,
      evidenceKey: REVIEW_FIELD_BINDINGS.seoTitleEn.evidenceKey,
    }),
    field(response.evidence, {
      key: "seoTitleZh",
      label: "SEO 標題（繁中）",
      englishLabel: "SEO title (Traditional Chinese)",
      value: content.seo.title["zh-Hant"],
      evidenceKey: REVIEW_FIELD_BINDINGS.seoTitleZh.evidenceKey,
    }),
    field(response.evidence, {
      key: "seoDescriptionEn",
      label: "SEO 描述（英文）",
      englishLabel: "SEO description (English)",
      value: content.seo.description.en,
      evidenceKey: REVIEW_FIELD_BINDINGS.seoDescriptionEn.evidenceKey,
      kind: "textarea",
    }),
    field(response.evidence, {
      key: "seoDescriptionZh",
      label: "SEO 描述（繁中）",
      englishLabel: "SEO description (Traditional Chinese)",
      value: content.seo.description["zh-Hant"],
      evidenceKey: REVIEW_FIELD_BINDINGS.seoDescriptionZh.evidenceKey,
      kind: "textarea",
    }),
    field(response.evidence, {
      key: "seoKeywords",
      label: "SEO 關鍵字",
      englishLabel: "SEO keywords",
      value: content.tags.join(", "),
      evidenceKey: REVIEW_FIELD_BINDINGS.seoKeywords.evidenceKey,
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
      remoteProductId: response.delivery?.remoteProductId ?? null,
      shoplineLink: response.shoplineLink,
      contentDigest: response.contentDigest,
      listingId: response.listingId,
      versionId: version.id,
      canRecordImportResult:
        response.permissions.canRecordImportResult ?? false,
      historicalImportResults: response.historicalImportResults ?? [],
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

function optionalNumber(fields: ListingField[], key: string): number | null {
  const raw = valueOf(fields, key);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a valid number`);
  return value;
}

/**
 * Turn the edited form back into savable content.
 *
 * An empty commercial field means "not known yet", not "invalid". These used to
 * go through `requiredNumber`, which threw before the request was ever made, so
 * an operator waiting on the merchant's price could not save the producer,
 * origin, vintage, volume and ABV they had already confirmed. `optionalNumber`
 * still rejects text that is not a number -- absent and wrong stay different.
 *
 * Completeness is enforced at approval and delivery, where the listing is about
 * to leave the workspace, rather than on every keystroke-to-save.
 */
export function applyListingFields(
  current: ReviewableListing,
  fields: ListingField[],
): ReviewableListing {
  return {
    ...current,
    sku: valueOf(fields, "sku") || null,
    producer: valueOf(fields, "producer") || null,
    productType:
      (valueOf(fields, "productType") as ReviewableListing["productType"]) ||
      null,
    country: valueOf(fields, "country") || null,
    region: valueOf(fields, "region") || null,
    vintage: optionalNumber(fields, "vintage"),
    grapeVarieties: valueOf(fields, "grapeVarieties")
      .split(/[,，]/)
      .map((value) => value.trim())
      .filter(Boolean),
    volumeMl: optionalNumber(fields, "volumeMl"),
    abvPercent: optionalNumber(fields, "abvPercent"),
    // The schema defaults this to 1, so an empty box means one bottle rather
    // than an unanswered question.
    packQuantity: optionalNumber(fields, "packQuantity") ?? 1,
    priceHkd: optionalNumber(fields, "priceHkd"),
    stockQuantity: optionalNumber(fields, "stockQuantity"),
    title: {
      en: valueOf(fields, "titleEn"),
      "zh-Hant": valueOf(fields, "titleZhHant"),
    },
    description: {
      en: valueOf(fields, "descriptionEn"),
      "zh-Hant": valueOf(fields, "descriptionZhHant"),
    },
    seo: {
      title: {
        en: valueOf(fields, "seoTitleEn"),
        "zh-Hant": valueOf(fields, "seoTitleZh"),
      },
      description: {
        en: valueOf(fields, "seoDescriptionEn"),
        "zh-Hant": valueOf(fields, "seoDescriptionZh"),
      },
    },
    tags: valueOf(fields, "seoKeywords")
      .split(/[,，]/)
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

type CodedError = Error & { code?: string };

/**
 * Keeps the server's error CODE, and nothing else.
 *
 * This used to discard the body entirely, so every action failure arrived as
 * `Request failed (409)` and rendered as one sentence: "the AI is still working
 * on this", "your copy of this page is stale" and "resolve the flags below"
 * were the same sentence, and none of them said what to do.
 *
 * `message` is deliberately still dropped. Route handlers may put internals
 * there, and the rule against leaking internals into a response body means
 * nothing if the screen prints them instead. Only `code` -- a closed server
 * enum -- crosses over. The Error's own message stays the status line, because
 * `safeUiError` reads it to recognise 401/403.
 */
async function responseError(response: Response): Promise<CodedError> {
  const error: CodedError = new Error(`Request failed (${response.status})`);
  try {
    const body = (await response.json()) as { code?: unknown };
    if (typeof body?.code === "string") error.code = body.code;
  } catch {
    // A half-deployed edge answers with an HTML error page, so `json()` throws
    // after the fetch resolved. Reporting a failure must not itself fail.
  }
  return error;
}

const errorCodeOf = (cause: unknown): string | undefined =>
  cause instanceof Error ? (cause as CodedError).code : undefined;

export function ListingReviewClient({
  listingId,
  initialProcessing,
}: {
  listingId: string;
  initialProcessing?: "queued" | "retry_required";
}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [snapshot, setSnapshot] = useState<ListingViewResponse | null>(null);
  const [processingState, setProcessingState] = useState(initialProcessing);
  const [errorKind, setErrorKind] = useState<"read" | "action">("read");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<readonly [string, string] | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const trackedRunId = useRef<string | null>(null);
  const processKey = useRef<string | null>(null);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [workingDirty, setWorkingDirty] = useState(false);
  const [wineDirty, setWineDirty] = useState(false);
  const [wineBusy, setWineBusy] = useState(false);
  const mutationBusy = busy || wineBusy;
  const [productShotChoice, setProductShotChoice] =
    useState<BackgroundChoice>("white");
  // A code the screen recognises says what to do about it. Anything else falls
  // back to the generic sentence, which is also what renders the permission
  // wording for 401/403 -- `insufficient_role` deliberately has no entry.
  const actionErrorText =
    reviewErrorLabel(errorCode, locale) ??
    safeUiError(error, locale, errorKind);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const id = ++requestId.current;
      try {
        const response = await fetch(`/api/listings/${listingId}`, {
          cache: "no-store",
          signal,
        });
        if (!response.ok) throw await responseError(response);
        const next = (await response.json()) as ListingViewResponse;
        if (requestId.current !== id || signal?.aborted) return;
        setSnapshot(next);
        setError(null);
        setErrorCode(undefined);
        const current = next.currentRun;
        if (
          current &&
          (!trackedRunId.current || trackedRunId.current === current.runId)
        ) {
          trackedRunId.current = current.runId;
          setProcessingState(
            ["queued", "running"].includes(current.state)
              ? "queued"
              : undefined,
          );
        } else if (
          !trackedRunId.current &&
          !current &&
          next.status !== "received"
        ) {
          setProcessingState(undefined);
        }
      } catch (cause) {
        if (requestId.current === id && !signal?.aborted) {
          setErrorKind("read");
          setError(
            cause instanceof Error ? cause.message : "Unable to load listing.",
          );
          setErrorCode(errorCodeOf(cause));
        }
        // Background callers swallow rejection; imperative callers must observe it
        // even when a newer request owns the displayed snapshot and load error.
        throw cause;
      }
    },
    [listingId],
  );

  useEffect(() => {
    const controller = new AbortController();
    // load publishes request-scoped errors; imperative callers still reject.
    void load(controller.signal).catch(() => {});
    return () => {
      ++requestId.current;
      controller.abort();
    };
  }, [load]);

  useEffect(() => {
    if (
      !["queued", "running"].includes(snapshot?.wineProgress?.state ?? "") &&
      processingState !== "queued" &&
      snapshot?.status !== "received" &&
      snapshot?.status !== "processing"
    )
      return;
    const timer = window.setInterval(() => {
      void load().catch(() => {});
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [load, snapshot?.status, snapshot?.wineProgress?.state, processingState]);

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
    async (work: () => Promise<void>, success: readonly [string, string]) => {
      setBusy(true);
      setError(null);
      setErrorCode(undefined);
      setMessage(null);
      try {
        await work();
        setMessage(success);
      } catch (runError) {
        setErrorKind("action");
        setError(
          runError instanceof Error
            ? runError.message
            : "Unable to complete request.",
        );
        setErrorCode(errorCodeOf(runError));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  async function startProcessing() {
    await run(async () => {
      const terminalRun =
        snapshot?.currentRun &&
        ["failed", "superseded", "succeeded"].includes(
          snapshot.currentRun.state,
        )
          ? snapshot.currentRun
          : null;
      const response = await fetch(`/api/listings/${listingId}/process`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedInputRevision:
            snapshot?.workingInput?.revision ?? snapshot?.inputRevision ?? 0,
          baseVersionId:
            snapshot?.workingInput?.baseVersionId ??
            snapshot?.activeVersion?.id ??
            null,
          ...(terminalRun ? { retryOfRunId: terminalRun.runId } : {}),
        }),
      });
      if (!response.ok) throw await responseError(response);
      setProcessingState("queued");
      await load();
    }, ["已加入處理佇列", "Processing queued"]);
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
        <div className="load-error" role="alert">
          <span>{safeUiError(viewState.message, locale)}</span>
          <button type="button" onClick={() => void load().catch(() => {})}>
            {commonCopy[locale].retry}
          </button>
        </div>
      </div>
    );
  if (viewState.kind === "processing" && snapshot)
    return (
      <div className="page-wrap review-page" aria-busy={mutationBusy}>
        {error ? (
          <p className="inline-warning" role="alert" id="listing-action-error">
            {actionErrorText}
            <button type="button" onClick={() => void load().catch(() => {})}>
              {commonCopy[locale].retry}
            </button>
          </p>
        ) : null}
        {message ? (
          <p className="success-note" role="status">
            {localized(locale, ...message)}
          </p>
        ) : null}
        {snapshot.sourceImportId ? (
          <SourceReadinessSummary readiness={snapshot.sourceReadiness} />
        ) : null}
        {snapshot.wineProgress ? (
          <WineEnrichmentWorkspace
            snapshot={snapshot}
            onRefresh={load}
            externalDirty={workingDirty}
            onDirtyChange={setWineDirty}
            onBusyChange={setWineBusy}
            disabled={mutationBusy}
          />
        ) : (
          <ListingProcessingPanel
            status={viewState.status}
            errorCode={
              snapshot.currentRun?.errorCode ?? snapshot.processing?.errorCode
            }
            enqueueState={processingState}
            canProcess={snapshot.permissions.canProcess}
            onProcess={startProcessing}
            busy={mutationBusy}
          />
        )}
        {snapshot.currentRun ? (
          <details>
            <summary>{t("處理詳情", "Processing details")}</summary>
            <p>
              {t("參考編號", "Reference")}: {snapshot.currentRun.runId}
            </p>
            <p>
              {snapshot.currentRun.state} ·{" "}
              {snapshot.currentRun.errorCode ?? ""}
            </p>
            {snapshot.currentRun.retryOfRunId ? (
              <p>
                {t("重試來源", "Retry of")}: {snapshot.currentRun.retryOfRunId}
              </p>
            ) : null}
          </details>
        ) : null}
        {snapshot.workingInput ? (
          <ListingWorkingCopy
            currentRunId={snapshot.currentRun?.runId}
            listingId={listingId}
            input={snapshot.workingInput}
            sources={snapshot.sources ?? []}
            canEdit={snapshot.permissions.canEdit && !wineDirty && !wineBusy}
            onDirtyChange={setWorkingDirty}
            onSaved={load}
            onProcessingAccepted={(run) => {
              trackedRunId.current = run.runId;
              setProcessingState("queued");
            }}
          />
        ) : null}
        <ListingExtractedFacts processing={snapshot.processing} />
        {snapshot.productShotWorkflow || snapshot.workingInput ? (
          <ProductShotReview
            listingId={listingId}
            canOperate={snapshot.permissions.canProcess && !mutationBusy}
            canApprove={snapshot.permissions.canApprove && !mutationBusy}
          />
        ) : null}
      </div>
    );
  if (viewState.kind === "loading" || !snapshot || !mapped)
    return (
      <div className="page-wrap">
        <p className="helper-copy" role="status">
          {t("正在載入商品資料…", "Loading listing…")}
        </p>
      </div>
    );

  const { model, delivery, permissions, evidence } = mapped;
  const content = snapshot.activeVersion?.content;

  async function save(fields: ListingField[], baseVersionId: string) {
    if (!content || !snapshot)
      throw new Error("Listing is not ready for review");
    const observedInputRevision =
      snapshot.inputRevision ?? snapshot.workingInput?.revision ?? 0;
    await run(async () => {
      const response = await fetch(`/api/listings/${listingId}/review`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseVersionId,
          expectedInputRevision: observedInputRevision,
          listing: applyListingFields(content, fields),
        }),
      });
      if (!response.ok) throw await responseError(response);
      await load();
    }, ["草稿已儲存", "Draft saved"]);
  }

  async function approve() {
    if (!snapshot) throw new Error("Listing is not ready for review");
    const { reviewConfirmation, sourceImportId, contentDigest } = snapshot;
    await run(async () => {
      const response = await fetch(`/api/listings/${listingId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersionId: model.versionId,
          confirmationLedgerRevision: reviewConfirmation?.revision ?? 0,
          ...(sourceImportId && contentDigest
            ? {
                sourceImportId,
                expectedRowDigest: contentDigest,
              }
            : {}),
        }),
      });
      if (!response.ok) throw await responseError(response);
      await load();
    }, ["商品已批准", "Listing approved"]);
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
    }, ["合規提示已處理", "Compliance flag resolved"]);
  }

  async function saveConfirmations(
    nextFieldConfirmations: Record<string, boolean>,
    nextNegativeConfirmations: Record<string, boolean>,
  ) {
    await run(async () => {
      const response = await fetch(
        `/api/listings/${listingId}/review-confirmations`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            versionId: model.versionId,
            expectedRevision: snapshot?.reviewConfirmation?.revision ?? null,
            fieldConfirmations: nextFieldConfirmations,
            negativeConfirmations: nextNegativeConfirmations,
          }),
        },
      );
      if (!response.ok) throw await responseError(response);
      await load();
    }, ["確認狀態已更新", "Confirmation updated"]);
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
    }, ["CSV 已下載", "CSV downloaded"]);
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
    }, ["已加入 SHOPLINE 發佈佇列", "Publish queued"]);
  }

  return (
    <div className="page-wrap review-page" aria-busy={mutationBusy}>
      <div className="breadcrumb">
        <Link href="/dashboard">{t("工作台", "Dashboard")}</Link>
        <span aria-hidden="true">/</span>
        <span>{model.title}</span>
      </div>
      <SourceReadinessSummary readiness={snapshot.sourceReadiness} />
      <div className="review-header">
        <div>
          <p className="eyebrow">
            {t("商品審核", "Listing review")} · <code>{model.id}</code>
          </p>
          <h1>{model.title}</h1>
          <p className="lede">
            {t(
              "確認 AI 建議、核對來源，然後交由審核員批准。",
              "Review AI suggestions and source evidence before reviewer approval.",
            )}
          </p>
        </div>
        <span className={`review-status status-${model.status}`}>
          <span aria-hidden="true" />
          {stateLabel(model.status, locale)}
        </span>
      </div>
      {error ? (
        <p className="inline-warning" role="alert" id="listing-action-error">
          {actionErrorText}
          <button type="button" onClick={() => void load().catch(() => {})}>
            {commonCopy[locale].retry}
          </button>
        </p>
      ) : null}
      {message ? (
        <p className="success-note" role="status">
          {localized(locale, ...message)}
        </p>
      ) : null}
      {snapshot.wineProgress && (
        <WineEnrichmentWorkspace
          snapshot={snapshot}
          onRefresh={load}
          externalDirty={reviewDirty || workingDirty}
          onDirtyChange={setWineDirty}
          onBusyChange={setWineBusy}
          disabled={mutationBusy}
        />
      )}
      <div className="review-layout">
        <EvidencePanel evidence={evidence} />
        <div className="review-content">
          {snapshot.productShotWorkflow ? (
            <ProductShotReview
              key={`${listingId}:${model.versionId}`}
              listingId={listingId}
              canOperate={permissions.canProcess && !mutationBusy}
              canApprove={permissions.canApprove && !mutationBusy}
            />
          ) : snapshot.productShot ? (
            <ProductShotPanel
              previewUrl={snapshot.productShot.previewUrl}
              brandBackgroundColor={snapshot.productShot.brandBackgroundColor}
              onChoiceChange={setProductShotChoice}
            />
          ) : null}
          {snapshot.workingInput ? (
            <details className="working-input-details">
              <summary>
                {t(
                  "修改來源、備註及工作草稿",
                  "Edit sources, notes and working draft",
                )}
              </summary>
              <p>
                {t(
                  "以下修改會先保存至工作草稿。請另存為審核版本，才會更新下方已保存的審核內容。",
                  "Changes here save to the working draft. Save as a review version to update the saved review content below.",
                )}
              </p>
              <ListingWorkingCopy
                listingId={listingId}
                input={{
                  ...snapshot.workingInput,
                  baseVersionId: model.versionId,
                }}
                sources={snapshot.sources ?? []}
                canEdit={
                  permissions.canEdit && !reviewDirty && !wineDirty && !wineBusy
                }
                busy={mutationBusy}
                currentRunId={snapshot.currentRun?.runId}
                onSaved={load}
                onDirtyChange={setWorkingDirty}
                onProcessingAccepted={(run) => {
                  trackedRunId.current = run.runId;
                  setProcessingState("queued");
                }}
              />
            </details>
          ) : null}
          <ListingFieldsForm
            key={model.versionId}
            model={model}
            canApprove={
              permissions.canApprove &&
              !mutationBusy &&
              !workingDirty &&
              !wineDirty
            }
            canEdit={
              permissions.canEdit &&
              !mutationBusy &&
              !workingDirty &&
              !wineDirty
            }
            fieldConfirmations={snapshot.reviewConfirmation?.fieldConfirmations}
            negativeConfirmations={
              snapshot.reviewConfirmation?.negativeConfirmations
            }
            onApprove={approve}
            actionErrorId={error ? "listing-action-error" : undefined}
            busy={mutationBusy}
            onSave={save}
            onDirtyChange={setReviewDirty}
          />
          <ConfirmationChecklist
            fieldConfirmations={
              snapshot.reviewConfirmation?.fieldConfirmations ?? {}
            }
            negativeConfirmations={
              snapshot.reviewConfirmation?.negativeConfirmations ?? {}
            }
            canConfirm={
              permissions.canEdit &&
              !mutationBusy &&
              !reviewDirty &&
              !workingDirty &&
              !wineDirty
            }
            onChange={saveConfirmations}
          />
          <ComplianceFlags
            flags={model.blockingFlags}
            canResolve={permissions.canResolveFlags && !mutationBusy}
            onResolve={resolveFlag}
          />
          <DeliveryPanel
            model={{
              ...delivery,
              canReview: delivery.canReview && !mutationBusy,
            }}
            sku={content?.sku ?? null}
            onCsv={exportCsv}
            onPublish={publish}
            onResultRecorded={() => load()}
          />
          <ActivityPanel entries={snapshot.activity} />
        </div>
      </div>
    </div>
  );
}
