"use client";

import { useMemo, useState } from "react";

import type { ListingField, ListingReviewModel } from "./listing-view-models";

export type { ListingField, ListingReviewModel } from "./listing-view-models";

type ListingFieldsFormProps = {
  model: ListingReviewModel;
  canApprove?: boolean;
  onApprove?: () => void;
  onSave?: (fields: ListingField[], baseVersionId: string) => void;
};

const groups: Array<{ label: string; englishLabel: string; keys: string[] }> = [
  { label: "商品資料", englishLabel: "Product details", keys: ["producer", "productType", "country", "vintage"] },
  { label: "規格與定價", englishLabel: "Specifications & price", keys: ["volumeMl", "abvPercent", "priceHkd", "stockQuantity"] },
  { label: "內容草稿", englishLabel: "Content draft", keys: ["description", "title"] },
];

function inputValue(value: ListingField["value"]): string {
  return value === null ? "" : String(value);
}

function displayConfidence(value: number | null): string {
  return value === null ? "未評估" : `信心度 ${Math.round(value * 100)}%`;
}

function fieldId(key: string) { return `listing-field-${key}`; }

export function ListingFieldsForm({ model, canApprove = true, onApprove, onSave }: ListingFieldsFormProps) {
  const [fields, setFields] = useState(model.fields);
  const hasOpenBlockingFlag = useMemo(() => model.blockingFlags.some((flag) => flag.status === "open"), [model.blockingFlags]);
  const approvalDisabled = !canApprove || hasOpenBlockingFlag || model.status !== "in_review";

  function updateField(key: string, value: string) {
    setFields((current) => current.map((field) => field.key === key ? { ...field, value: value || null } : field));
  }

  return (
    <form className="listing-fields-form" onSubmit={(event) => { event.preventDefault(); onSave?.(fields, model.versionId); }}>
      <div className="form-heading">
        <div>
          <p className="eyebrow">內容審核 <span>CONTENT REVIEW</span></p>
          <h2 id="fields-heading">商品欄位</h2>
        </div>
        <span className="version-label">版本 {model.versionId.slice(0, 12)}</span>
      </div>

      {groups.map((group) => {
        const groupFields = fields.filter((field) => group.keys.includes(field.key));
        if (groupFields.length === 0) return null;
        return (
          <fieldset className="field-group" key={group.label}>
            <legend><span>{group.label}</span><small>{group.englishLabel}</small></legend>
            <div className="field-grid">
              {groupFields.map((field) => {
                const id = fieldId(field.key);
                const descriptionId = `${id}-description`;
                const isLongText = field.kind === "textarea";
                return (
                  <div className={`field-control ${isLongText ? "field-wide" : ""}`} key={field.key}>
                    <label htmlFor={id}><span>{field.label}</span><small>{field.englishLabel}</small></label>
                    {isLongText ? (
                      <textarea id={id} value={inputValue(field.value)} onChange={(event) => updateField(field.key, event.target.value)} aria-describedby={descriptionId} rows={4} />
                    ) : (
                      <input id={id} type={field.kind === "number" ? "number" : "text"} value={inputValue(field.value)} onChange={(event) => updateField(field.key, event.target.value)} aria-describedby={descriptionId} />
                    )}
                    <div className="field-meta" id={descriptionId}>
                      <span className={field.confidence === null ? "confidence confidence-missing" : "confidence"}>{displayConfidence(field.confidence)}</span>
                      {field.value === null ? <span className="missing-value">需要資料</span> : null}
                      {field.evidence ? <span className="source-copy">來源：{field.evidence.source}{field.evidence.page ? ` · 第 ${field.evidence.page} 頁` : ""} · 「{field.evidence.excerpt}」</span> : <span className="source-copy">尚未有來源摘錄</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      <div className="form-actions">
        <button className="secondary-button" type="submit">儲存草稿 <span>Save draft</span></button>
        <button className="primary-button" type="button" onClick={onApprove} disabled={approvalDisabled} aria-describedby={hasOpenBlockingFlag ? "approval-help" : undefined}>批准上架 <span>Approve listing</span></button>
      </div>
      {hasOpenBlockingFlag ? <div id="approval-help" className="inline-warning" role="alert"><strong>尚有開放的阻塞提示：</strong> {model.blockingFlags.filter((flag) => flag.status === "open").map((flag) => flag.label).join("、")}。完成處理並記錄理由後才能批准上架。</div> : null}
      {!canApprove ? <p className="helper-copy">你的角色只能檢視內容，需由審核員或管理員批准。</p> : null}
    </form>
  );
}
