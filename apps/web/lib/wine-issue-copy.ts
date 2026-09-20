/** Operator copy is allowlisted; raw provider paths and diagnostics stay off the review surface. */
const messages: Record<string, readonly [string, string]> = {
  trusted_source_conflict: [
    "\u53ef\u4fe1\u4f86\u6e90\u7684\u8cc7\u6599\u4e92\u76f8\u77db\u76fe\u3002\u8acb\u6bd4\u8f03\u539f\u59cb\u8b49\u64da\u518d\u63a1\u7528\u3002",
    "Trusted sources disagree. Compare the original evidence before adopting this detail.",
  ],
  source_identity_unresolved: [
    "未能確認某個來源屬於此產品。使用其資料前，請先比較來源詳情。",
    "A source could not be matched to this product. Compare the source details before using its claims.",
  ],
  source_identity_mismatch: [
    "某個來源的產品資料不相符。請核對年份、容量及產品名稱。",
    "A source describes a different product. Check its vintage, volume and product name.",
  ],
  observation_identity_conflict: [
    "來源的產品資料互相矛盾。請核對原始標籤及來源。",
    "The sources disagree about the product. Compare the original label and sources.",
  ],
  verification_identity_unresolved: [
    "產品身份仍未確認。請比較可選身份或補充清晰標籤。",
    "The product identity needs confirmation. Compare available choices or add a clearer label.",
  ],
  verification_core_fact_missing: [
    "部分產品資料尚未有足夠證據。請查看來源並補充資料。",
    "Some product details lack sufficient evidence. Review the sources and add missing information.",
  ],
  observation_binding_invalid: [
    "未能從原始來源核實某項資料。請檢查標籤或補充資料。",
    "A detail could not be verified against its source. Check the label or add supporting information.",
  ],
  unsupported_label_value: [
    "來源中有未能解讀的資料。請查看原始來源。",
    "A source contains a detail that could not be interpreted. Inspect the original source.",
  ],
};
export function wineIssueCopy(code: string, locale: "en" | "zh-Hant"): string {
  const value = Object.hasOwn(messages, code)
    ? messages[code]!
    : [
        "繼續前，請核對已儲存的證據及產品資料。",
        "Review the saved evidence and product details before continuing.",
      ];
  return value[locale === "en" ? 1 : 0]!;
}
