import { createHash } from "node:crypto";
import type { Database, WorkbookSaveInput } from "@wukong/db";
import {
  prepareWorkbookBase,
  parseBulkForm,
  hashBulkFormHeaderContract,
  type BulkFormSheet,
  type WorkbookBaseProduct,
} from "@wukong/shopline";
import {
  readBulkFormSheet,
  readBulkFormSheetName,
} from "@wukong/shopline/bulk-form-xlsx";
import { ApiError } from "./route-support";

export type ParsedWorkbook = Omit<WorkbookSaveInput, "actorId">;
export type WorkbookParser = (request: Request) => Promise<ParsedWorkbook>;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
async function readUpload(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_UPLOAD_BYTES)
    throw new ApiError(
      413,
      "upload_too_large",
      "Choose an XLSX no larger than 4 MiB.",
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new ApiError(400, "empty_upload", "Attach a SHOPLINE XLSX workbook.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw new ApiError(
          413,
          "upload_too_large",
          "Choose an XLSX no larger than 4 MiB.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size)
    throw new ApiError(400, "empty_upload", "Attach a SHOPLINE XLSX workbook.");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export function createWorkbookParser(
  deps: {
    readSheet(bytes: Uint8Array): BulkFormSheet;
    readSheetName(bytes: Uint8Array): string;
  } = { readSheet: readBulkFormSheet, readSheetName: readBulkFormSheetName },
): WorkbookParser {
  return async (request) => {
    const filename = new URL(request.url).searchParams.get("filename");
    if (!filename || filename.length > 255 || !/^.+\.xlsx$/i.test(filename))
      throw new ApiError(
        400,
        "invalid_filename",
        "Provide the original .xlsx filename, up to 255 characters.",
      );
    const bytes = await readUpload(request);
    let sheet: BulkFormSheet, sheetName: string;
    try {
      sheet = deps.readSheet(bytes);
      sheetName = deps.readSheetName(bytes);
    } catch {
      throw new ApiError(
        400,
        "upload_not_a_workbook",
        "Choose a readable SHOPLINE XLSX workbook with its Default sheet.",
      );
    }
    if (!sheet.some((row) => row.some((cell) => cell?.trim())))
      throw new ApiError(
        422,
        "workbook_empty",
        "The workbook sheet is empty. Choose a SHOPLINE product export.",
      );
    const parsed = parseBulkForm(sheet);
    if (parsed.headerRow === null)
      throw new ApiError(
        422,
        "workbook_unrecognized",
        "The sheet does not match the supported SHOPLINE export columns.",
      );
    const prepared = prepareWorkbookBase(sheet, filename);
    if (prepared.totalRows > 5000)
      throw new ApiError(
        413,
        "workbook_too_many_rows",
        "Choose a workbook containing at most 5,000 data rows.",
      );
    if (!prepared.totalRows)
      throw new ApiError(
        422,
        "workbook_empty",
        "The workbook contains no product rows.",
      );
    if (
      Buffer.byteLength(JSON.stringify(sheet)) > 16 * 1024 * 1024 ||
      prepared.products.some(
        (p) => Buffer.byteLength(JSON.stringify(p)) > 1024 * 1024,
      )
    )
      throw new ApiError(
        413,
        "workbook_evidence_too_large",
        "The normalized workbook evidence is too large. Export a smaller workbook.",
      );
    return {
      filename,
      sheetName,
      workbookSha256: createHash("sha256").update(bytes).digest("hex"),
      headerContractSha256: hashBulkFormHeaderContract(),
      prepared,
    };
  };
}
export function workbookPreview(input: ParsedWorkbook) {
  const { prepared } = input;
  const products: Pick<
    WorkbookBaseProduct,
    "rowNumber" | "productId" | "sku" | "title" | "priceHkd"
  >[] = prepared.products
    .slice(0, 20)
    .map(({ rowNumber, productId, sku, title, priceHkd }) => ({
      rowNumber,
      productId,
      sku,
      title,
      priceHkd,
    }));
  return {
    filename: input.filename,
    sheetName: input.sheetName,
    workbookSha256: input.workbookSha256,
    headerContractSha256: input.headerContractSha256,
    specVersion: prepared.specVersion,
    inferredExportTime: prepared.inferredExportTime,
    totalRows: prepared.totalRows,
    eligibleProducts: prepared.products.length,
    excludedRows: prepared.excludedRows,
    products,
    issues: prepared.issues.slice(0, 100),
    totalIssues: prepared.issues.length,
  };
}
export function createWorkbookSaver(deps: { getDatabase(): Database }) {
  return async (input: WorkbookSaveInput & { workspaceId: string }) => {
    const { workspaceId, ...save } = input;
    try {
      return await deps
        .getDatabase()
        .forWorkspace(workspaceId, (r) => r.workbookCatalog.save(save));
    } catch (error) {
      // PostgreSQL JSONB adds canonical whitespace. Its final size guard can
      // reject evidence that passed the compact JSON preflight; keep that
      // boundary actionable without exposing database details.
      const cause = error instanceof Error ? error.cause : null;
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "23514" &&
        "constraint_name" in cause &&
        typeof cause.constraint_name === "string" &&
        [
          "workbook_imports_normalized_sheet_check",
          "workbook_imports_check",
          "workbook_products_check",
        ].includes(cause.constraint_name)
      ) {
        throw new ApiError(
          413,
          "workbook_evidence_too_large",
          "The normalized workbook evidence is too large. Export a smaller workbook.",
        );
      }
      throw error;
    }
  };
}
