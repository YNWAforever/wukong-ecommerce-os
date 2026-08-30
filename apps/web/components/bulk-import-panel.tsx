"use client";

import { useState } from "react";

/** Matches MAX_UPLOAD_BYTES in apps/web/app/api/listings/import/route.ts:34. */
export const MAX_BULK_IMPORT_BYTES = 4 * 1024 * 1024;

export type BulkImportIssue = {
  code: string;
  severity: "error" | "warning";
  row: number | null;
  column: string | null;
  value: string | null;
  message: string;
};

export type BulkImportSuccess = {
  kind: "success";
  specVersion: string;
  parsedRows: number;
  createdDrafts: number;
  refreshedProducts: number;
  issues: BulkImportIssue[];
};

export type BulkImportFailure =
  | { kind: "validation_error"; message: string }
  | { kind: "api_error"; code: string; message: string }
  | { kind: "network_error"; message: string };

export type BulkImportOutcome = BulkImportSuccess | BulkImportFailure;

export type BulkImportDeps = { fetcher: typeof fetch };

const API_ERROR_MESSAGES: Record<string, string> = {
  empty_upload: "Attach a SHOPLINE bulk update form.",
  upload_too_large: "The bulk update form is too large.",
  upload_not_a_workbook: "The upload is not a readable xlsx workbook.",
  bulk_form_unreadable:
    "No product rows could be read from this bulk update form.",
  bulk_form_too_many_rows: "This form holds too many products for one import.",
  shopline_connection_missing:
    "Connect a SHOPLINE store before importing a catalog.",
  insufficient_role: "Operator access is required.",
};

export function validateBulkImportFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return "Choose an .xlsx SHOPLINE Bulk Update workbook.";
  }
  if (file.size > MAX_BULK_IMPORT_BYTES) {
    return "Workbook exceeds the 4 MiB runtime limit.";
  }
  return null;
}

export async function submitBulkImport(
  file: File,
  deps: BulkImportDeps = { fetcher: fetch },
): Promise<BulkImportOutcome> {
  const validationError = validateBulkImportFile(file);
  if (validationError) {
    return { kind: "validation_error", message: validationError };
  }

  let response: Response;
  try {
    response = await deps.fetcher("/api/listings/import", {
      method: "POST",
      body: file,
    });
  } catch {
    return {
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    };
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // A non-JSON body reaches here from a platform-level failure (e.g. a
    // 502/504/524 gateway page) rather than the application itself, but the
    // caller cannot tell the difference and does not need to: either way we
    // could not get something usable back from the server.
    return {
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    };
  }

  if (!response.ok) {
    const code = typeof body.code === "string" ? body.code : "unknown_error";
    const message =
      API_ERROR_MESSAGES[code] ??
      (typeof body.message === "string" ? body.message : "The import failed.");
    return { kind: "api_error", code, message };
  }

  return {
    kind: "success",
    specVersion: body.specVersion as string,
    parsedRows: body.parsedRows as number,
    createdDrafts: body.createdDrafts as number,
    refreshedProducts: body.refreshedProducts as number,
    issues: (body.issues as BulkImportIssue[]) ?? [],
  };
}

export function BulkImportPanel() {
  const [outcome, setOutcome] = useState<BulkImportOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setOutcome(null);
    const result = await submitBulkImport(file);
    setOutcome(result);
    setBusy(false);
  }

  return (
    <div className="intake-form">
      <div className="upload-dropzone">
        <label htmlFor="bulk-import-file" className="upload-label">
          <span className="upload-title">匯入 SHOPLINE Bulk Update 匯出檔</span>
          <span className="upload-subtitle">
            上載最新匯出的 .xlsx 檔案 · 最多 4 MiB
          </span>
          <span className="secondary-button upload-button">
            選擇檔案 <span>Select file</span>
          </span>
        </label>
        <input
          id="bulk-import-file"
          type="file"
          accept=".xlsx"
          disabled={busy}
          onChange={handleChange}
        />
      </div>

      {outcome?.kind === "success" ? (
        <ul className="file-list" aria-live="polite">
          <li>
            已解析 {outcome.parsedRows} 列 · 新增 {outcome.createdDrafts} 筆草稿
            · 更新 {outcome.refreshedProducts} 筆
          </li>
          {outcome.issues.map((issue, index) => (
            <li key={index}>{issue.message}</li>
          ))}
        </ul>
      ) : null}

      <p className="intake-message" role="status" aria-live="polite">
        {busy
          ? "匯入中…"
          : outcome && outcome.kind !== "success"
            ? outcome.message
            : "選擇最新的 SHOPLINE Bulk Update 匯出檔開始匯入。"}
      </p>
    </div>
  );
}
