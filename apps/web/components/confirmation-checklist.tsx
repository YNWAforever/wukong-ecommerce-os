"use client";

const FIELD_LABELS: Record<string, { zh: string; en: string }> = {
  nameZh: { zh: "商品名稱（繁中）", en: "Name (zh)" },
  summaryEn: { zh: "摘要（英文）", en: "Summary (en)" },
  summaryZh: { zh: "摘要（繁中）", en: "Summary (zh)" },
  seoTitleEn: { zh: "SEO 標題（英文）", en: "SEO title (en)" },
  seoTitleZh: { zh: "SEO 標題（繁中）", en: "SEO title (zh)" },
  seoDescriptionEn: { zh: "SEO 描述（英文）", en: "SEO description (en)" },
  seoDescriptionZh: { zh: "SEO 描述（繁中）", en: "SEO description (zh)" },
  seoKeywords: { zh: "SEO 關鍵字", en: "SEO keywords" },
};

const NEGATIVE_LABELS: Record<string, { zh: string; en: string }> = {
  priceUnchanged: { zh: "售價未變動", en: "Price unchanged" },
  membershipUnchanged: { zh: "會員權益未變動", en: "Membership unchanged" },
  categoryUnchanged: { zh: "分類未變動", en: "Category unchanged" },
  statusUnchanged: { zh: "上下架狀態未變動", en: "Status unchanged" },
  supplierUnchanged: { zh: "供應商未變動", en: "Supplier unchanged" },
  quantityDeltaNeutral: { zh: "數量差額為中性", en: "Quantity delta neutral" },
  noImageChange: { zh: "圖片無變動", en: "No image change" },
};

export const CONFIRMATION_FIELD_KEYS = Object.keys(FIELD_LABELS);
export const CONFIRMATION_NEGATIVE_KEYS = Object.keys(NEGATIVE_LABELS);

export function allConfirmed(
  fieldConfirmations: Record<string, boolean>,
  negativeConfirmations: Record<string, boolean>,
): boolean {
  return (
    CONFIRMATION_FIELD_KEYS.every((key) => fieldConfirmations[key] === true) &&
    CONFIRMATION_NEGATIVE_KEYS.every(
      (key) => negativeConfirmations[key] === true,
    )
  );
}

type ConfirmationChecklistProps = {
  fieldConfirmations: Record<string, boolean>;
  negativeConfirmations: Record<string, boolean>;
  canConfirm?: boolean;
  onChange?: (
    nextFieldConfirmations: Record<string, boolean>,
    nextNegativeConfirmations: Record<string, boolean>,
  ) => void;
};

function confirmedCount(
  keys: string[],
  confirmations: Record<string, boolean>,
): number {
  return keys.filter((key) => confirmations[key] === true).length;
}

export function ConfirmationChecklist({
  fieldConfirmations,
  negativeConfirmations,
  canConfirm = false,
  onChange,
}: ConfirmationChecklistProps) {
  const totalItems =
    CONFIRMATION_FIELD_KEYS.length + CONFIRMATION_NEGATIVE_KEYS.length;
  const totalConfirmed =
    confirmedCount(CONFIRMATION_FIELD_KEYS, fieldConfirmations) +
    confirmedCount(CONFIRMATION_NEGATIVE_KEYS, negativeConfirmations);
  const complete = allConfirmed(fieldConfirmations, negativeConfirmations);

  function toggleField(key: string, checked: boolean) {
    onChange?.(
      { ...fieldConfirmations, [key]: checked },
      negativeConfirmations,
    );
  }

  function toggleNegative(key: string, checked: boolean) {
    onChange?.(fieldConfirmations, {
      ...negativeConfirmations,
      [key]: checked,
    });
  }

  return (
    <section
      className="confirmations"
      aria-labelledby="confirmations-heading"
      data-all-confirmed={complete}
    >
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">
            審核確認 <span>REVIEW CONFIRMATION</span>
          </p>
          <h2 id="confirmations-heading">批准前需要確認</h2>
        </div>
        <span className="flag-count">
          {totalConfirmed} / {totalItems} 項已確認
        </span>
      </div>

      <fieldset className="field-group">
        <legend>
          <span>AI 撰寫欄位</span>
          <small>AI-written fields</small>
        </legend>
        <ul className="flag-list">
          {CONFIRMATION_FIELD_KEYS.map((key) => {
            const label = FIELD_LABELS[key]!;
            const checked = fieldConfirmations[key] === true;
            const id = `confirmation-field-${key}`;
            return (
              <li
                className={`flag-item ${checked ? "flag-resolved" : ""}`}
                key={key}
              >
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  disabled={!canConfirm}
                  onChange={(event) => toggleField(key, event.target.checked)}
                />
                <label htmlFor={id}>
                  <span>{label.zh}</span>
                  <small>{label.en}</small>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <fieldset className="field-group">
        <legend>
          <span>負面條件</span>
          <small>Negative conditions</small>
        </legend>
        <ul className="flag-list">
          {CONFIRMATION_NEGATIVE_KEYS.map((key) => {
            const label = NEGATIVE_LABELS[key]!;
            const checked = negativeConfirmations[key] === true;
            const id = `confirmation-negative-${key}`;
            return (
              <li
                className={`flag-item ${checked ? "flag-resolved" : ""}`}
                key={key}
              >
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  disabled={!canConfirm}
                  onChange={(event) =>
                    toggleNegative(key, event.target.checked)
                  }
                />
                <label htmlFor={id}>
                  <span>{label.zh}</span>
                  <small>{label.en}</small>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
    </section>
  );
}
