"use client";
import { complianceLabel } from "../lib/review-ui-copy";
import { useLocale } from "../lib/locale-context";
import { localized, commonCopy, formatNumber } from "../lib/ui-copy";

import { useMemo, useState } from "react";

import { allConfirmed } from "./confirmation-checklist";
import type { ListingField, ListingReviewModel } from "./listing-view-models";

export type { ListingField, ListingReviewModel } from "./listing-view-models";

type ListingFieldsFormProps = {
  model: ListingReviewModel;
  actionErrorId?: string;
  busy?: boolean;
  canEdit?: boolean;
  canApprove?: boolean;
  fieldConfirmations?: Record<string, boolean>;
  negativeConfirmations?: Record<string, boolean>;
  onApprove?: () => void;
  onSave?: (fields: ListingField[], baseVersionId: string) => void;
};

const groups: Array<{ label: string; englishLabel: string; keys: string[] }> = [
  {
    label: "商品資料",
    englishLabel: "Product details",
    keys: [
      "sku",
      "producer",
      "productType",
      "country",
      "region",
      "vintage",
      "grapeVarieties",
    ],
  },
  {
    label: "規格與定價",
    englishLabel: "Specifications & price",
    keys: [
      "volumeMl",
      "abvPercent",
      "packQuantity",
      "priceHkd",
      "stockQuantity",
    ],
  },
  {
    label: "內容草稿",
    englishLabel: "Content draft",
    keys: [
      "titleZhHant",
      "titleEn",
      "descriptionZhHant",
      "descriptionEn",
      "description",
      "title",
    ],
  },
  {
    label: "SEO 與標籤",
    englishLabel: "SEO & tags",
    keys: [
      "seoTitleEn",
      "seoTitleZh",
      "seoDescriptionEn",
      "seoDescriptionZh",
      "seoKeywords",
    ],
  },
];

function inputValue(value: ListingField["value"]): string {
  return value === null ? "" : String(value);
}

function displayConfidence(
  value: number | null,
  locale: ReturnType<typeof useLocale>,
): string {
  return value === null
    ? localized(locale, "未評估", "Not assessed")
    : `${localized(locale, "信心度", "Confidence")} ${formatNumber(Math.round(value * 100), locale)}%`;
}

function fieldId(key: string) {
  return `listing-field-${key}`;
}

export function ListingFieldsForm({
  model,
  actionErrorId,
  busy = false,
  canEdit = true,
  canApprove = true,
  fieldConfirmations = {},
  negativeConfirmations = {},
  onApprove,
  onSave,
}: ListingFieldsFormProps) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [fields, setFields] = useState(model.fields);
  const hasOpenBlockingFlag = useMemo(
    () => model.blockingFlags.some((flag) => flag.status === "open"),
    [model.blockingFlags],
  );
  const confirmationsIncomplete = !allConfirmed(
    fieldConfirmations,
    negativeConfirmations,
  );
  const approvalDisabled =
    !canApprove ||
    hasOpenBlockingFlag ||
    confirmationsIncomplete ||
    model.status !== "in_review";

  function updateField(key: string, value: string) {
    setFields((current) =>
      current.map((field) =>
        field.key === key ? { ...field, value: value || null } : field,
      ),
    );
  }

  return (
    <form
      className="listing-fields-form"
      aria-describedby={actionErrorId}
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        onSave?.(fields, model.versionId);
      }}
    >
      <div className="form-heading">
        <div>
          <p className="eyebrow">{t("內容審核", "Content review")}</p>
          <h2 id="fields-heading">{t("商品欄位", "Listing fields")}</h2>
        </div>
        <span className="version-label">
          {t("版本", "Version")} {model.versionId}
        </span>
      </div>

      {groups.map((group) => {
        const groupFields = fields.filter((field) =>
          group.keys.includes(field.key),
        );
        if (groupFields.length === 0) return null;
        return (
          <fieldset className="field-group" key={group.label}>
            <legend>{t(group.label, group.englishLabel)}</legend>
            <div className="field-grid">
              {groupFields.map((field) => {
                const id = fieldId(field.key);
                const descriptionId = `${id}-description`;
                const isLongText = field.kind === "textarea";
                return (
                  <div
                    className={`field-control ${isLongText ? "field-wide" : ""}`}
                    key={field.key}
                  >
                    <label htmlFor={id}>
                      {t(field.label, field.englishLabel)}
                    </label>
                    {isLongText ? (
                      <textarea
                        id={id}
                        value={inputValue(field.value)}
                        onChange={(event) =>
                          updateField(field.key, event.target.value)
                        }
                        aria-describedby={descriptionId}
                        rows={4}
                        disabled={!canEdit}
                      />
                    ) : (
                      <input
                        id={id}
                        type={field.kind === "number" ? "number" : "text"}
                        value={inputValue(field.value)}
                        onChange={(event) =>
                          updateField(field.key, event.target.value)
                        }
                        aria-describedby={descriptionId}
                        disabled={!canEdit}
                      />
                    )}
                    <div className="field-meta" id={descriptionId}>
                      <span
                        className={
                          field.confidence === null
                            ? "confidence confidence-missing"
                            : "confidence"
                        }
                      >
                        {displayConfidence(field.confidence, locale)}
                      </span>
                      {field.value === null ? (
                        <span className="missing-value">
                          {t("需要資料", "Needs information")}
                        </span>
                      ) : null}
                      {field.evidence ? (
                        <span className="source-copy">
                          {t("來源：", "Source:")}
                          {field.evidence.source}
                          {field.evidence.page
                            ? ` · ${t("頁", "Page")} ${formatNumber(field.evidence.page, locale)}`
                            : ""}{" "}
                          · 「{field.evidence.excerpt}」
                        </span>
                      ) : (
                        <span className="source-copy">
                          {t("尚未有來源摘錄", "No source excerpt")}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      <div className="form-actions">
        <button className="secondary-button" type="submit" disabled={!canEdit}>
          {busy ? commonCopy[locale].loading : t("儲存草稿", "Save draft")}
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={onApprove}
          disabled={approvalDisabled}
          aria-describedby={
            hasOpenBlockingFlag
              ? "approval-help"
              : confirmationsIncomplete
                ? "confirmation-help"
                : undefined
          }
        >
          {t("批准上架", "Approve listing")}
        </button>
      </div>
      {hasOpenBlockingFlag ? (
        <div id="approval-help" className="inline-warning" role="alert">
          <strong>{t("尚有開放的阻塞提示：", "Open blocking flags:")}</strong>{" "}
          {model.blockingFlags
            .filter((flag) => flag.status === "open")
            .map((flag) => complianceLabel(flag.code, locale, "label"))
            .join("、")}
          {t(
            "。完成處理並記錄理由後才能批准上架。",
            ". Resolve flags and record reasons before approval.",
          )}
        </div>
      ) : null}
      {!hasOpenBlockingFlag && confirmationsIncomplete ? (
        <div id="confirmation-help" className="inline-warning" role="alert">
          <strong>
            {t("審核確認尚未完成：", "Review confirmations are incomplete:")}
          </strong>
          {t(
            "請在下方確認清單勾選所有 8 個欄位與 7 項條件後才能批准上架。",
            "Confirm all 8 fields and 7 conditions in the checklist before approval.",
          )}
        </div>
      ) : null}
      {!canApprove ? (
        <p className="helper-copy">
          {t(
            "你的角色只能檢視內容，需由審核員或管理員批准。",
            "Your role can only view content. A reviewer or administrator must approve.",
          )}
        </p>
      ) : null}
    </form>
  );
}
