import type { ListingFacts } from "@wukong/core";

import { SHOPLINE_TITLE_MAX_LENGTH } from "./validation.js";

/**
 * SHOPLINE's bulk update form: export xlsx, edit cells, re-import keyed by
 * `Product ID (DO NOT EDIT)`. This is a different artifact from the create form
 * in `csv.ts` — it carries no description or image column, and it is the only
 * supported way to read an existing catalog in and write enrichment back onto
 * products SHOPLINE already owns.
 *
 * See docs/superpowers/specs/2026-08-15-shopline-bulk-form-design.md.
 */
export const SHOPLINE_BULK_FORM_SPEC_VERSION = "opak-2026-05" as const;

/**
 * The 71-column contract, in sheet order. Every entry carries the exact English
 * header (row 1) and the exact Traditional Chinese header (row 2) so that
 * addressing, contract verification, and header emission all read one source
 * and cannot drift apart.
 */
export const BULK_FORM_COLUMNS = [
  {
    key: "productId",
    en: "Product ID (DO NOT EDIT)",
    zh: "商品編號 （切勿更改)",
  },
  { key: "nameEn", en: "Product Name (English)", zh: "商品名稱 (英文)" },
  {
    key: "nameZh",
    en: "Product Name (Traditional Chinese)",
    zh: "商品名稱 (繁體中文)",
  },
  { key: "summaryEn", en: "Product Summary (English)", zh: "商品摘要 (英文)" },
  {
    key: "summaryZh",
    en: "Product Summary (Traditional Chinese)",
    zh: "商品摘要 (繁體中文)",
  },
  { key: "seoTitleEn", en: "SEO Title (English)", zh: "SEO標題 (英文)" },
  {
    key: "seoTitleZh",
    en: "SEO Title (Traditional Chinese)",
    zh: "SEO標題 (繁體中文)",
  },
  {
    key: "seoDescriptionEn",
    en: "SEO Description (English)",
    zh: "SEO簡介 (英文)",
  },
  {
    key: "seoDescriptionZh",
    en: "SEO Description (Traditional Chinese)",
    zh: "SEO簡介 (繁體中文)",
  },
  { key: "seoKeywords", en: "SEO Keywords", zh: "SEO關鍵字" },
  { key: "hiddenProduct", en: "Hidden Product", zh: "隱藏商品" },
  { key: "preorderFeature", en: "Preorder Feature", zh: "預購功能" },
  {
    key: "preorderNoteEn",
    en: "Preorder Note (English)",
    zh: "預購提示 (英文)",
  },
  {
    key: "preorderNoteZh",
    en: "Preorder Note (Traditional Chinese)",
    zh: "預購提示 (繁體中文)",
  },
  {
    key: "unlimitedPreorderSupply",
    en: "Unlimited Preorder Supply",
    zh: "預購商品可無限供貨",
  },
  { key: "preorderLimit", en: "Preorder Limit", zh: "預購上限" },
  { key: "onlineStoreStatus", en: "Online Store Status", zh: "網店上架狀態" },
  { key: "retailStoreStatus", en: "Retail Store Status", zh: "實體店上架狀態" },
  {
    key: "presetOnlineStorePublishDate",
    en: "Preset Online Store Publish Date",
    zh: "預設網店上架日期",
  },
  {
    key: "productAvailableStartDate",
    en: "Product Available start date",
    zh: "銷售開始時間",
  },
  {
    key: "productAvailableEndDate",
    en: "Product Available end date",
    zh: "銷售結束時間",
  },
  { key: "brand", en: "Brand", zh: "商品品牌" },
  { key: "hidePrice", en: "Hide Price", zh: "隱藏價格" },
  {
    key: "onlineStoreCategories",
    en: "Online Store Categories",
    zh: "網店分類",
  },
  {
    key: "posCategoriesEn",
    en: "POS Categories (English)",
    zh: "POS分類 (英文)",
  },
  {
    key: "posCategoriesZh",
    en: "POS Categories (Traditional Chinese)",
    zh: "POS分類 (繁體中文)",
  },
  { key: "regularPrice", en: "Regular Price", zh: "商品原價" },
  { key: "salePrice", en: "Sale Price", zh: "商品特價" },
  {
    key: "productRetailStorePrice",
    en: "Product Retail Store Price",
    zh: "實體店價格",
  },
  { key: "memberPrice", en: "Member Price", zh: "商品會員價" },
  { key: "goldMembershipPrice", en: "Gold Membership Price", zh: "金會員價" },
  {
    key: "platinumMembershipPrice",
    en: "Platinum Membership Price",
    zh: "鉑金會員價",
  },
  {
    key: "diamondMembershipPrice",
    en: "Diamond Membership Price",
    zh: "鑽石會員價",
  },
  { key: "tradePrice", en: "Trade Price", zh: "Trade價" },
  { key: "unlimitedQuantity", en: "Unlimited Quantity", zh: "無限數量" },
  { key: "samePrice", en: "Same Price", zh: "價格一致" },
  { key: "productCost", en: "Product Cost", zh: "商品成本" },
  { key: "sku", en: "SKU", zh: "商品貨號" },
  {
    key: "quantity",
    en: "Quantity (DO NOT EDIT)",
    zh: "數量 (參考用，請勿修改)",
  },
  {
    key: "updateQuantity",
    en: "Update Quantity (e.g. +5 or -8)",
    zh: "增減數量 (例: +5 或 -8)",
  },
  { key: "weightKg", en: "Weight(KG)", zh: "重量(公斤)" },
  { key: "supplier", en: "Supplier", zh: "供應商" },
  { key: "productTag", en: "Product Tag", zh: "商品管理標籤" },
  {
    key: "promotionLabelEn",
    en: "Product Promotion Label (English)",
    zh: "商品促銷標籤 (英文)",
  },
  {
    key: "promotionLabelZh",
    en: "Product Promotion Label (Traditional Chinese)",
    zh: "商品促銷標籤 (繁體中文)",
  },
  {
    key: "excludePaymentOptions",
    en: "Exclude Payment Options",
    zh: "排除的付款方式",
  },
  {
    key: "excludeDeliveryOptions",
    en: "Exclude Delivery Options",
    zh: "排除的送貨方式",
  },
  {
    key: "variantId",
    en: "Variant ID (DO NOT EDIT)",
    zh: "款式編號 （切勿更改)",
  },
  {
    key: "variantEn",
    en: "Variant (English) (DO NOT EDIT)",
    zh: "款式 (英文) (勿更改)",
  },
  {
    key: "variantZh",
    en: "Variant (Traditional Chinese) (DO NOT EDIT)",
    zh: "款式 (繁體中文) (勿更改)",
  },
  {
    key: "variantQuantity",
    en: "Variant Quantity (DO NOT EDIT)",
    zh: "款式數量 (參考用，請勿修改)",
  },
  {
    key: "updateVariantQuantity",
    en: "Update Variant Quantity (e.g. +5 or -8)",
    zh: "增減款式數量 (例: +5 或 -8)",
  },
  { key: "variantPrice", en: "Variant Price", zh: "款式價格" },
  { key: "variantSalePrice", en: "Variant Sale Price", zh: "款式特價" },
  {
    key: "variantRetailStorePrice",
    en: "Variant Retail Store Price",
    zh: "款式實體店價格",
  },
  { key: "variantMemberPrice", en: "Variant Member Price", zh: "款式會員價" },
  {
    key: "variantGoldMembershipPrice",
    en: "Variant Gold Membership Price",
    zh: "款式金會員價",
  },
  {
    key: "variantPlatinumMembershipPrice",
    en: "Variant Platinum Membership Price",
    zh: "款式鉑金會員價",
  },
  {
    key: "variantDiamondMembershipPrice",
    en: "Variant Diamond Membership Price",
    zh: "款式鑽石會員價",
  },
  { key: "variantTradePrice", en: "Variant Trade Price", zh: "款式Trade價" },
  { key: "variantCost", en: "Variant Cost", zh: "款式成本" },
  { key: "variantWeightKg", en: "Variant Weight(KG)", zh: "款式重量(KG)" },
  { key: "variantSku", en: "Variant SKU", zh: "款式貨號" },
  { key: "locationId", en: "Location ID", zh: "儲位編號" },
  { key: "mpn", en: "MPN", zh: "製造編號" },
  { key: "barcode", en: "Barcode", zh: "商品條碼編號" },
  {
    key: "slStockId",
    en: "SL_STOCK_ID(DO NOT EDIT)",
    zh: "庫存參照值(切勿更改)",
  },
  {
    key: "warehouse",
    en: "Warehouse(DO NOT EDIT)",
    zh: "出貨倉庫(參考用，請勿修改)",
  },
  {
    key: "productNotApplicableToDiscount",
    en: "Product not applicable to discount",
    zh: "不適用折扣商品",
  },
  {
    key: "slKey0",
    en: "SL_KEY0(DO NOT EDIT)",
    zh: "商品名稱參照值0(切勿更改)",
  },
  {
    key: "slKey1",
    en: "SL_KEY1(DO NOT EDIT)",
    zh: "商品名稱參照值1(切勿更改)",
  },
] as const;

export type BulkFormColumnKey = (typeof BULK_FORM_COLUMNS)[number]["key"];

/** Columns whose header says DO NOT EDIT. Echoed verbatim; never written. */
export const BULK_FORM_LOCKED_COLUMNS = [
  "productId",
  "quantity",
  "variantId",
  "variantEn",
  "variantZh",
  "variantQuantity",
  "slStockId",
  "warehouse",
  "slKey0",
  "slKey1",
] as const satisfies readonly BulkFormColumnKey[];

/**
 * The only columns Wukong may write. `nameEn` is deliberately excluded:
 * rewriting the English name changes the merchant's product identity and their
 * operators' search handle, while the untranslated Chinese name is the gap
 * Wukong exists to fill.
 */
export const BULK_FORM_ENRICHABLE_COLUMNS = [
  "nameZh",
  "summaryEn",
  "summaryZh",
  "seoTitleEn",
  "seoTitleZh",
  "seoDescriptionEn",
  "seoDescriptionZh",
  "seoKeywords",
] as const satisfies readonly BulkFormColumnKey[];

export type BulkFormEnrichableColumn =
  (typeof BULK_FORM_ENRICHABLE_COLUMNS)[number];

/** Enrichable columns SHOPLINE treats as a title, and so length-limits. */
const TITLE_COLUMNS: readonly BulkFormEnrichableColumn[] = [
  "nameZh",
  "seoTitleEn",
  "seoTitleZh",
];

/** Delta columns. Echoing a non-zero delta re-applies a stock movement. */
const QUANTITY_DELTA_COLUMNS = [
  "updateQuantity",
  "updateVariantQuantity",
] as const satisfies readonly BulkFormColumnKey[];

const NEUTRAL_QUANTITY_DELTA = "+0";

/** The literal SHOPLINE writes into the numeric quantity column for unlimited stock. */
const UNLIMITED_QUANTITY_SENTINEL = "無限數量";

/**
 * Top-level category to canonical product type. Merchandising and consignment
 * buckets (Party Wines Selection, Top Picks, Case Offer, CM/Branco Consignment)
 * are intentionally absent so a product filed under both a real category and a
 * merchandising one resolves by the real one.
 */
const CATEGORY_PRODUCT_TYPES = new Map<
  string,
  NonNullable<ListingFacts["productType"]>
>([
  ["Whisky", "spirits"],
  ["Brandy", "spirits"],
  ["Spirits / Fortified Wine", "spirits"],
  ["Red Wine", "wine"],
  ["White Wine", "wine"],
  ["Rose", "wine"],
  ["Champagne", "wine"],
  ["Sparkling Wine", "wine"],
  ["Sake", "sake"],
  ["Plum Wine", "other"],
  ["Other Alcohol", "other"],
  ["Wine Accessories", "other"],
]);

export type BulkFormCell = string | null;
export type BulkFormSheet = readonly (readonly BulkFormCell[])[];

/** A normalized string row; blank and whitespace-only cells are null, not typed XLSX cells. */
export type BulkFormRawRow = Readonly<Record<BulkFormColumnKey, string | null>>;

/**
 * `platform_products.rawRow` is stored as `Record<string, string | null>` —
 * looser than `BulkFormRawRow`, because the database column has no way to
 * enforce that all 71 `BulkFormColumnKey`s are present. The importer always
 * writes a full row, so this should never fail in practice; it exists so a
 * malformed stored row is reported as unexportable instead of producing
 * `undefined` cells `createBulkFormUpdate` wasn't written to expect.
 */
export function isBulkFormRawRow(
  value: Record<string, string | null>,
): value is BulkFormRawRow {
  return BULK_FORM_COLUMNS.every((column) => column.key in value);
}

export type BulkFormIssueCode =
  | "header_row_missing"
  | "column_contract_mismatch"
  | "row_too_short"
  | "product_id_missing"
  | "product_id_duplicated"
  | "sku_missing"
  | "quantity_unlimited_sentinel"
  | "quantity_negative"
  | "price_negative"
  | "number_not_numeric"
  | "flag_not_recognized"
  | "categories_missing"
  | "variant_row_blocked"
  | "quantity_delta_not_neutral";

export type BulkFormIssue = {
  code: BulkFormIssueCode;
  /** `error` drops the row; `warning` keeps it after normalizing. */
  severity: "error" | "warning";
  /** 1-based worksheet row, or null for whole-sheet issues. */
  row: number | null;
  column: BulkFormColumnKey | null;
  value: string | null;
  message: string;
};

export type BulkFormText = { en: string | null; "zh-Hant": string | null };

/** One complete category path, split on `>`. */
export type BulkFormCategoryPath = readonly string[];

/**
 * The six content pathologies the pilot export exhibits, computed per row so a
 * hygiene report and an enrichment cohort are derived rather than hand-picked.
 */
export type BulkFormContentGaps = {
  untranslatedName: boolean;
  untranslatedSeoTitle: boolean;
  seoTitleMirrorsName: boolean;
  seoDescriptionMirrorsSeoTitle: boolean;
  keywordsMirrorName: boolean;
  summaryMissing: boolean;
};

export type BulkFormProductRow = {
  /** 1-based worksheet row, for operator-facing diagnostics. */
  rowNumber: number;
  productId: string;
  sku: string;
  raw: BulkFormRawRow;
  categories: readonly BulkFormCategoryPath[];
  posCategory: { en: string; "zh-Hant": string | null } | null;
  pricing: {
    regular: number | null;
    sale: number | null;
    retail: number | null;
    trade: number | null;
    cost: number | null;
  };
  inventory: {
    quantity: number | null;
    unlimited: boolean;
    warehouse: string | null;
  };
  visibility: {
    onlineStore: boolean;
    retailStore: boolean;
    hiddenProduct: boolean;
    hidePrice: boolean;
  };
  identifiers: {
    barcode: string | null;
    mpn: string | null;
    supplier: string | null;
  };
  content: {
    name: BulkFormText;
    summary: BulkFormText;
    seoTitle: BulkFormText;
    seoDescription: BulkFormText;
    seoKeywords: string | null;
  };
  gaps: BulkFormContentGaps;
  /** Only values the form states. Inference from prose belongs to `extract`. */
  facts: ListingFacts;
};

/**
 * The only fields `createBulkFormUpdate` reads at runtime. Export builds this
 * directly from a stored `platform_products` row, which carries none of
 * `BulkFormProductRow`'s other derived fields — those exist only because
 * `parseBulkForm` derives them from a fresh upload, and the writer never
 * needed them.
 */
export type BulkFormExportRow = Pick<
  BulkFormProductRow,
  "productId" | "raw" | "rowNumber"
>;

export type BulkFormParseResult = {
  specVersion: typeof SHOPLINE_BULK_FORM_SPEC_VERSION;
  /** 1-based row holding the English contract, or null when absent. */
  headerRow: number | null;
  /** 1-based row holding the Traditional Chinese labels, when present. */
  localeHeaderRow: number | null;
  rows: readonly BulkFormProductRow[];
  issues: readonly BulkFormIssue[];
};

const cellAt = (row: readonly BulkFormCell[], index: number): string | null => {
  const value = row[index];
  if (value === undefined || value === null) return null;
  return value.trim().length === 0 ? null : value;
};

const issue = (
  code: BulkFormIssueCode,
  severity: BulkFormIssue["severity"],
  row: number | null,
  column: BulkFormColumnKey | null,
  value: string | null,
  message: string,
): BulkFormIssue => ({ code, severity, row, column, value, message });

const matchesHeaders = (
  row: readonly BulkFormCell[],
  locale: "en" | "zh",
): boolean =>
  row
    .slice(BULK_FORM_COLUMNS.length)
    .every((cell) => (cell ?? "").trim() === "") &&
  BULK_FORM_COLUMNS.every(
    (column, index) => (row[index] ?? "").trim() === column[locale],
  );

function parseNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFlag(value: string | null): boolean | null {
  if (value === null) return false;
  const normalized = value.trim().toUpperCase();
  if (normalized === "Y") return true;
  if (normalized === "N") return false;
  return null;
}

/**
 * Splits the category cell. Newlines separate complete category paths — 26 of
 * the pilot's 500 rows carry two — so collapsing them destroys an assignment.
 */
function parseCategories(
  value: string | null,
): readonly BulkFormCategoryPath[] {
  if (value === null) return [];
  return value
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) =>
      path
        .split(">")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0),
    )
    .filter((segments) => segments.length > 0);
}

function resolveProductType(
  categories: readonly BulkFormCategoryPath[],
): ListingFacts["productType"] {
  for (const path of categories) {
    const top = path[0];
    if (top === undefined) continue;
    const productType = CATEGORY_PRODUCT_TYPES.get(top);
    if (productType !== undefined) return productType;
  }
  return null;
}

const sameText = (left: string | null, right: string | null): boolean =>
  left !== null && right !== null && left.trim() === right.trim();

function buildRawRow(row: readonly BulkFormCell[]): BulkFormRawRow {
  const raw: Partial<Record<BulkFormColumnKey, string | null>> = {};
  BULK_FORM_COLUMNS.forEach((column, index) => {
    raw[column.key] = cellAt(row, index);
  });
  return raw as BulkFormRawRow;
}

/**
 * A stored snapshot may omit columns that were blank, so this accepts a partial
 * row rather than a complete one. Exported so a cohort can be selected from
 * `platform_products.rawRow` without re-parsing a sheet.
 */
export type BulkFormGapsInput = Readonly<
  Partial<Record<BulkFormColumnKey, string | null>>
>;

export function bulkFormGaps(raw: BulkFormGapsInput): BulkFormContentGaps {
  const nameEn = raw.nameEn ?? null;
  const nameZh = raw.nameZh ?? null;
  const seoTitleEn = raw.seoTitleEn ?? null;
  const seoTitleZh = raw.seoTitleZh ?? null;
  const seoDescriptionEn = raw.seoDescriptionEn ?? null;
  const summaryEn = raw.summaryEn ?? null;
  const summaryZh = raw.summaryZh ?? null;

  return {
    untranslatedName: nameZh === null || sameText(nameEn, nameZh),
    untranslatedSeoTitle:
      seoTitleZh === null || sameText(seoTitleEn, seoTitleZh),
    seoTitleMirrorsName: sameText(seoTitleEn, nameEn),
    seoDescriptionMirrorsSeoTitle: sameText(seoDescriptionEn, seoTitleEn),
    keywordsMirrorName: sameText(raw.seoKeywords ?? null, nameEn),
    summaryMissing: summaryEn === null && summaryZh === null,
  };
}

function parseRow(
  row: readonly BulkFormCell[],
  rowNumber: number,
  seenProductIds: Set<string>,
  issues: BulkFormIssue[],
): BulkFormProductRow | null {
  // Worksheets omit trailing empty cells, so a short row means trailing blanks
  // rather than a broken layout — the header contract already proved the column
  // alignment. Report it and read the missing cells as empty.
  if (row.length < BULK_FORM_COLUMNS.length) {
    issues.push(
      issue(
        "row_too_short",
        "warning",
        rowNumber,
        null,
        String(row.length),
        `row has ${row.length} cells; the contract has ${BULK_FORM_COLUMNS.length}, trailing cells read as empty`,
      ),
    );
  }

  const raw = buildRawRow(row);

  const productId = raw.productId;
  if (productId === null) {
    issues.push(
      issue(
        "product_id_missing",
        "error",
        rowNumber,
        "productId",
        null,
        "row has no Product ID",
      ),
    );
    return null;
  }
  if (seenProductIds.has(productId)) {
    issues.push(
      issue(
        "product_id_duplicated",
        "error",
        rowNumber,
        "productId",
        productId,
        "Product ID already seen in this sheet",
      ),
    );
    return null;
  }

  const sku = raw.sku;
  if (sku === null) {
    issues.push(
      issue("sku_missing", "error", rowNumber, "sku", null, "row has no SKU"),
    );
    return null;
  }
  seenProductIds.add(productId);

  if (raw.variantId !== null) {
    issues.push(
      issue(
        "variant_row_blocked",
        "error",
        rowNumber,
        "variantId",
        raw.variantId,
        "row has a Variant ID; variant support is not yet validated for the Opak Bulk Update pilot",
      ),
    );
    return null;
  }

  for (const column of QUANTITY_DELTA_COLUMNS) {
    const delta = raw[column];
    if (delta !== null && delta.trim() !== NEUTRAL_QUANTITY_DELTA) {
      issues.push(
        issue(
          "quantity_delta_not_neutral",
          "warning",
          rowNumber,
          column,
          delta,
          `source carries a stock delta; it will be reset to ${NEUTRAL_QUANTITY_DELTA} on export`,
        ),
      );
    }
  }

  const numberFor = (column: BulkFormColumnKey): number | null => {
    const value = raw[column];
    if (value === null) return null;
    const parsed = parseNumber(value);
    if (parsed === null) {
      issues.push(
        issue(
          "number_not_numeric",
          "warning",
          rowNumber,
          column,
          value,
          "value is not a number",
        ),
      );
    }
    return parsed;
  };

  const flagFor = (column: BulkFormColumnKey): boolean => {
    const value = raw[column];
    const parsed = parseFlag(value);
    if (parsed === null) {
      issues.push(
        issue(
          "flag_not_recognized",
          "warning",
          rowNumber,
          column,
          value,
          "expected Y or N",
        ),
      );
      return false;
    }
    return parsed;
  };

  const unlimitedFlag = flagFor("unlimitedQuantity");
  const rawQuantity = raw.quantity;
  let quantity: number | null = null;
  let unlimited = unlimitedFlag;

  if (
    rawQuantity !== null &&
    rawQuantity.trim() === UNLIMITED_QUANTITY_SENTINEL
  ) {
    unlimited = true;
    issues.push(
      issue(
        "quantity_unlimited_sentinel",
        "warning",
        rowNumber,
        "quantity",
        rawQuantity,
        "quantity column holds the unlimited-stock sentinel instead of an integer",
      ),
    );
  } else if (rawQuantity !== null) {
    const parsed = parseNumber(rawQuantity);
    if (parsed === null) {
      issues.push(
        issue(
          "number_not_numeric",
          "warning",
          rowNumber,
          "quantity",
          rawQuantity,
          "value is not a number",
        ),
      );
    } else if (parsed < 0) {
      // listingFactsSchema.stockQuantity is nonnegative; oversold rows clamp.
      issues.push(
        issue(
          "quantity_negative",
          "warning",
          rowNumber,
          "quantity",
          rawQuantity,
          "negative stock clamped to 0",
        ),
      );
      quantity = 0;
    } else {
      quantity = Math.trunc(parsed);
    }
  }

  const categories = parseCategories(raw.onlineStoreCategories);
  if (categories.length === 0) {
    issues.push(
      issue(
        "categories_missing",
        "warning",
        rowNumber,
        "onlineStoreCategories",
        raw.onlineStoreCategories,
        "row has no category path",
      ),
    );
  }

  const regular = numberFor("regularPrice");
  const sale = numberFor("salePrice");
  // A 0.0 sale price means "not on sale" — 24 of the pilot's 500 rows — so
  // treating zero as a price would give the catalog away.
  const resolvedPrice = sale !== null && sale > 0 ? sale : regular;
  // listingFactsSchema.priceHkd is nonnegative, and the facts prefill is now
  // parsed at the persistence boundary — a negative price would throw there
  // instead of surfacing here as a readable issue. Report it and drop the value
  // rather than inventing one; stock gets clamped because zero stock is
  // meaningful, whereas a zero price is not.
  let priceHkd = resolvedPrice;
  if (resolvedPrice !== null && resolvedPrice < 0) {
    issues.push(
      issue(
        "price_negative",
        "warning",
        rowNumber,
        sale !== null && sale > 0 ? "salePrice" : "regularPrice",
        String(resolvedPrice),
        "negative price dropped; the listing has no price until it is corrected",
      ),
    );
    priceHkd = null;
  }

  const name: BulkFormText = { en: raw.nameEn, "zh-Hant": raw.nameZh };
  const summary: BulkFormText = { en: raw.summaryEn, "zh-Hant": raw.summaryZh };
  const seoTitle: BulkFormText = {
    en: raw.seoTitleEn,
    "zh-Hant": raw.seoTitleZh,
  };
  const seoDescription: BulkFormText = {
    en: raw.seoDescriptionEn,
    "zh-Hant": raw.seoDescriptionZh,
  };

  const posEn = raw.posCategoriesEn;

  return {
    rowNumber,
    productId,
    sku,
    raw,
    categories,
    posCategory:
      posEn === null ? null : { en: posEn, "zh-Hant": raw.posCategoriesZh },
    pricing: {
      regular,
      sale,
      retail: numberFor("productRetailStorePrice"),
      trade: numberFor("tradePrice"),
      cost: numberFor("productCost"),
    },
    inventory: {
      quantity: unlimited ? null : quantity,
      unlimited,
      warehouse: raw.warehouse,
    },
    visibility: {
      onlineStore: flagFor("onlineStoreStatus"),
      retailStore: flagFor("retailStoreStatus"),
      hiddenProduct: flagFor("hiddenProduct"),
      hidePrice: flagFor("hidePrice"),
    },
    identifiers: { barcode: raw.barcode, mpn: raw.mpn, supplier: raw.supplier },
    content: {
      name,
      summary,
      seoTitle,
      seoDescription,
      seoKeywords: raw.seoKeywords,
    },
    gaps: bulkFormGaps(raw),
    facts: {
      sku,
      producer: null,
      productType: resolveProductType(categories),
      country: null,
      region: null,
      vintage: null,
      grapeVarieties: [],
      volumeMl: null,
      abvPercent: null,
      packQuantity: 1,
      priceHkd,
      stockQuantity: unlimited ? null : quantity,
      criticScores: [],
      awards: [],
    },
  };
}

/**
 * Reads a bulk update form. Never throws: a broken column contract yields no
 * rows and one issue, and row-level problems are reported per row so a 500-row
 * catalog is not lost to a single bad cell.
 */
export function parseBulkForm(sheet: BulkFormSheet): BulkFormParseResult {
  const issues: BulkFormIssue[] = [];

  const headerIndex = sheet.findIndex((row) => matchesHeaders(row, "en"));
  if (headerIndex < 0) {
    const width = sheet[0]?.length ?? 0;
    issues.push(
      issue(
        width === BULK_FORM_COLUMNS.length
          ? "column_contract_mismatch"
          : "header_row_missing",
        "error",
        null,
        null,
        null,
        `no row matches the ${BULK_FORM_COLUMNS.length}-column ${SHOPLINE_BULK_FORM_SPEC_VERSION} header contract`,
      ),
    );
    return {
      specVersion: SHOPLINE_BULK_FORM_SPEC_VERSION,
      headerRow: null,
      localeHeaderRow: null,
      rows: [],
      issues,
    };
  }

  const localeRow = sheet[headerIndex + 1];
  const hasLocaleHeader =
    localeRow !== undefined && matchesHeaders(localeRow, "zh");
  const firstDataIndex = headerIndex + (hasLocaleHeader ? 2 : 1);

  const rows: BulkFormProductRow[] = [];
  const seenProductIds = new Set<string>();
  for (let index = firstDataIndex; index < sheet.length; index += 1) {
    const row = sheet[index];
    if (row === undefined) continue;
    if (row.every((cell) => cell === null || cell.trim().length === 0))
      continue;
    const parsed = parseRow(row, index + 1, seenProductIds, issues);
    if (parsed !== null) rows.push(parsed);
  }

  return {
    specVersion: SHOPLINE_BULK_FORM_SPEC_VERSION,
    headerRow: headerIndex + 1,
    localeHeaderRow: hasLocaleHeader ? headerIndex + 2 : null,
    rows,
    issues,
  };
}

export type BulkFormEnrichmentIssueCode =
  | "enrichment_empty"
  | "enrichment_no_changes"
  | "enrichment_duplicate"
  | "enrichment_product_unknown"
  | "enrichment_column_not_enrichable"
  | "enrichment_value_blank"
  | "enrichment_value_too_long"
  | "enrichment_value_control_characters"
  // Thrown by a caller (apps/web/lib/bulk-export-service.ts), not by
  // anything inside this package -- reuses ShoplineBulkFormError's shared
  // shape/handling for a batch that mixes listings from two different
  // SHOPLINE connections rather than adding a new error type.
  | "mixed_source_connections";

export type BulkFormEnrichmentIssue = {
  code: BulkFormEnrichmentIssueCode;
  productId: string | null;
  column: string | null;
  message: string;
};

export class ShoplineBulkFormError extends Error {
  readonly issues: BulkFormEnrichmentIssue[];

  constructor(issues: BulkFormEnrichmentIssue[]) {
    super(
      issues
        .map(
          (item) =>
            `${item.productId ?? "-"}.${item.column ?? "-"}: ${item.message}`,
        )
        .join("; "),
    );
    this.name = "ShoplineBulkFormError";
    this.issues = issues;
  }
}

export type BulkFormEnrichment = {
  productId: string;
  values: Partial<Record<BulkFormEnrichableColumn, string>>;
};

export type BulkFormChange = {
  rowNumber: number;
  productId: string;
  column: BulkFormEnrichableColumn;
  from: string | null;
  to: string;
};

export type BulkFormUpdate = {
  specVersion: typeof SHOPLINE_BULK_FORM_SPEC_VERSION;
  /** Both header rows followed by the selected data rows. */
  sheet: readonly (readonly string[])[];
  changes: readonly BulkFormChange[];
  /** 1-based source rows whose stock delta was reset to `+0`. */
  neutralizedQuantityDeltas: readonly number[];
};

export type BulkFormUpdateOptions = {
  /** `changed` (default) omits untouched rows; SHOPLINE leaves absent rows alone. */
  include?: "changed" | "all";
};

const isEnrichable = (column: string): column is BulkFormEnrichableColumn =>
  (BULK_FORM_ENRICHABLE_COLUMNS as readonly string[]).includes(column);

/**
 * Rejected in enriched values but preserved in echoed ones: the category
 * column newlines are meaningful multi-path separators, while a newline in a
 * generated SEO field is a defect that corrupts the cell.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function validateEnrichments(
  rows: readonly BulkFormExportRow[],
  enrichments: readonly BulkFormEnrichment[],
): BulkFormEnrichmentIssue[] {
  const issues: BulkFormEnrichmentIssue[] = [];
  if (enrichments.length === 0) {
    return [
      {
        code: "enrichment_empty",
        productId: null,
        column: null,
        message: "no enrichments supplied",
      },
    ];
  }

  const known = new Set(rows.map((row) => row.productId));
  const seen = new Set<string>();

  for (const enrichment of enrichments) {
    const { productId } = enrichment;
    if (!known.has(productId)) {
      issues.push({
        code: "enrichment_product_unknown",
        productId,
        column: null,
        message: "Product ID is not present in the parsed sheet",
      });
      continue;
    }
    if (seen.has(productId)) {
      issues.push({
        code: "enrichment_duplicate",
        productId,
        column: null,
        message: "Product ID is enriched more than once",
      });
      continue;
    }
    seen.add(productId);

    for (const [column, value] of Object.entries(enrichment.values)) {
      if (!isEnrichable(column)) {
        issues.push({
          code: "enrichment_column_not_enrichable",
          productId,
          column,
          message: "column is locked or not part of the enrichable surface",
        });
        continue;
      }
      if (value === undefined || value.trim().length === 0) {
        issues.push({
          code: "enrichment_value_blank",
          productId,
          column,
          message: "value must not be blank",
        });
        continue;
      }
      if (CONTROL_CHARACTERS.test(value)) {
        issues.push({
          code: "enrichment_value_control_characters",
          productId,
          column,
          message:
            "value must not contain newlines, tabs, or other control characters",
        });
        continue;
      }
      if (
        TITLE_COLUMNS.includes(column) &&
        value.length > SHOPLINE_TITLE_MAX_LENGTH
      ) {
        issues.push({
          code: "enrichment_value_too_long",
          productId,
          column,
          message: `title must be at most ${SHOPLINE_TITLE_MAX_LENGTH} characters`,
        });
      }
    }
  }

  return issues;
}

/**
 * Emits a re-importable bulk update form in which only enriched columns differ
 * from the source. Throws before writing any cell if an enrichment is invalid,
 * mirroring `createShoplineCsv`: never emit a file SHOPLINE would reject.
 */
export function createBulkFormUpdate(
  rows: readonly BulkFormExportRow[],
  enrichments: readonly BulkFormEnrichment[],
  options: BulkFormUpdateOptions = {},
): BulkFormUpdate {
  const issues = validateEnrichments(rows, enrichments);
  if (issues.length > 0) throw new ShoplineBulkFormError(issues);

  const byProductId = new Map(
    enrichments.map((enrichment) => [enrichment.productId, enrichment.values]),
  );
  const include = options.include ?? "changed";

  const changes: BulkFormChange[] = [];
  const neutralizedQuantityDeltas: number[] = [];
  const dataRows: string[][] = [];

  for (const row of rows) {
    const values = byProductId.get(row.productId);
    const changesBeforeRow = changes.length;

    const cells = BULK_FORM_COLUMNS.map((column) => {
      const key = column.key;
      const original = row.raw[key];

      if ((QUANTITY_DELTA_COLUMNS as readonly string[]).includes(key)) {
        return original === null ? "" : NEUTRAL_QUANTITY_DELTA;
      }

      if (values === undefined || !isEnrichable(key)) return original ?? "";

      const replacement = values[key];
      if (replacement === undefined) return original ?? "";
      if (original === replacement) return original;

      changes.push({
        rowNumber: row.rowNumber,
        productId: row.productId,
        column: key,
        from: original,
        to: replacement,
      });
      return replacement;
    });

    // Skip a row that produced zero real changes -- e.g. an enrichment
    // whose every value already matches the raw source. Deciding this
    // AFTER building `cells` (rather than before, based on whether an
    // enrichment entry merely exists) is what makes this correct for a
    // MIXED batch: `createBulkExport` always supplies an enrichment entry
    // for every freshness-surviving listing, even genuine no-ops, so
    // "does an entry exist" was never a reliable signal that this specific
    // row actually changed.
    const rowChanged = changes.length > changesBeforeRow;
    if (!rowChanged && include === "changed") continue;

    for (const column of QUANTITY_DELTA_COLUMNS) {
      const original = row.raw[column];
      if (original !== null && original.trim() !== NEUTRAL_QUANTITY_DELTA) {
        neutralizedQuantityDeltas.push(row.rowNumber);
        break;
      }
    }

    dataRows.push(cells);
  }

  if (changes.length === 0) {
    throw new ShoplineBulkFormError([
      {
        code: "enrichment_no_changes",
        productId: null,
        column: null,
        message: "every enriched value already matches the source sheet",
      },
    ]);
  }

  return {
    specVersion: SHOPLINE_BULK_FORM_SPEC_VERSION,
    sheet: [
      BULK_FORM_COLUMNS.map((column) => column.en),
      BULK_FORM_COLUMNS.map((column) => column.zh),
      ...dataRows,
    ],
    changes,
    neutralizedQuantityDeltas,
  };
}
