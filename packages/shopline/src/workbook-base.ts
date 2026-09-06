import {
  parseBulkForm,
  type BulkFormIssue,
  type BulkFormRawRow,
  type BulkFormSheet,
  type BulkFormText,
} from "./bulk-form.js";

export type WorkbookBaseProduct = {
  rowNumber: number;
  productId: string;
  sku: string;
  title: BulkFormText;
  priceHkd: number | null;
  raw: BulkFormRawRow;
};

export type InferredWorkbookTime = {
  value: string;
  source: "filename";
  timeZone: null;
};

export type PreparedWorkbookBase = {
  specVersion: string;
  sheet: BulkFormSheet;
  products: WorkbookBaseProduct[];
  totalRows: number;
  excludedRows: number;
  issues: BulkFormIssue[];
  inferredExportTime: InferredWorkbookTime | null;
};

const WORKBOOK_DATE_PATTERN =
  /BulkUpdateForm-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:_\d+)?\.xlsx$/;

export function inferWorkbookExportTime(
  filename: string,
): InferredWorkbookTime | null {
  const match = WORKBOOK_DATE_PATTERN.exec(filename);
  if (match === null) return null;

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined
  ) {
    return null;
  }

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (hour > 23 || minute > 59) return null;

  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    value: `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}`,
    source: "filename",
    timeZone: null,
  };
}

export function prepareWorkbookBase(
  sheet: BulkFormSheet,
  filename: string,
): PreparedWorkbookBase {
  const parsed = parseBulkForm(sheet);
  const products = parsed.rows.map((row) => ({
    rowNumber: row.rowNumber,
    productId: row.productId,
    sku: row.sku,
    title: row.content.name,
    priceHkd: row.facts.priceHkd,
    raw: row.raw,
  }));

  const lastHeaderRow = parsed.localeHeaderRow ?? parsed.headerRow;
  const totalRows =
    lastHeaderRow === null
      ? 0
      : sheet
          .slice(lastHeaderRow)
          .filter((row) =>
            row.some((cell) => cell !== null && cell.trim().length > 0),
          ).length;

  return {
    specVersion: parsed.specVersion,
    sheet,
    products,
    totalRows,
    excludedRows: totalRows - products.length,
    issues: [...parsed.issues],
    inferredExportTime: inferWorkbookExportTime(filename),
  };
}
