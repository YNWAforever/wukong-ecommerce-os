"use client";

import { useRef, useState } from "react";

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
  upload_sheet_name_unreadable:
    "The upload's worksheet name could not be read.",
  bulk_form_unreadable:
    "No product rows could be read from this bulk update form.",
  bulk_form_too_many_rows: "This form holds too many products for one import.",
  shopline_connection_missing:
    "Connect a SHOPLINE store before importing a catalog.",
  insufficient_role: "Operator access is required.",
  merchant_attested_export_at_missing: "Enter the SHOPLINE export time.",
  merchant_attested_export_at_invalid: "Enter a valid SHOPLINE export time.",
  filename_missing: "Choose the original SHOPLINE workbook.",
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

/** Converts an operator-entered Hong Kong wall time to its exact UTC instant. */
export function merchantExportTimeToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;

  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day
  ) {
    return null;
  }

  return new Date(
    Date.UTC(year, month - 1, day, hour - 8, minute),
  ).toISOString();
}

export async function submitBulkImport(
  file: File,
  merchantAttestedExportTime: string,
  deps: BulkImportDeps = { fetcher: fetch },
): Promise<BulkImportOutcome> {
  const validationError = validateBulkImportFile(file);
  if (validationError)
    return { kind: "validation_error", message: validationError };

  if (!merchantAttestedExportTime) {
    return {
      kind: "validation_error",
      message: "Enter the SHOPLINE export time.",
    };
  }
  const merchantAttestedExportAt = merchantExportTimeToIso(
    merchantAttestedExportTime,
  );
  if (!merchantAttestedExportAt) {
    return {
      kind: "validation_error",
      message: "Enter a valid SHOPLINE export time.",
    };
  }

  const params = new URLSearchParams({
    merchantAttestedExportAt,
    filename: file.name,
  });

  let response: Response;
  try {
    // Native browser fetch must not receive the dependency object as its receiver.
    const { fetcher } = deps;
    response = await fetcher(`/api/listings/import?${params.toString()}`, {
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
  const [file, setFile] = useState<File | null>(null);
  const [merchantExportTime, setMerchantExportTime] = useState("");
  const [busy, setBusy] = useState(false);
  const submittingRef = useRef(false);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0] ?? null;
    setFile(selectedFile);
    setOutcome(null);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    if (!file) {
      setOutcome({
        kind: "validation_error",
        message: "Choose a SHOPLINE workbook first.",
      });
      return;
    }
    if (!merchantExportTime) {
      setOutcome({
        kind: "validation_error",
        message: "Enter the SHOPLINE export time.",
      });
      return;
    }

    submittingRef.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await submitBulkImport(file, merchantExportTime));
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="intake-form" onSubmit={handleSubmit}>
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
          onChange={handleFileChange}
        />
      </div>

      {file ? <p className="intake-message">已選擇：{file.name}</p> : null}

      <label htmlFor="merchant-attested-export-at">
        SHOPLINE 匯出時間（香港時間 UTC+08:00）
      </label>
      <input
        id="merchant-attested-export-at"
        type="datetime-local"
        value={merchantExportTime}
        disabled={busy}
        onChange={(event) => {
          setMerchantExportTime(event.target.value);
          setOutcome(null);
        }}
      />

      <button type="submit" className="primary-button" disabled={busy}>
        {busy ? "匯入中…" : "開始匯入 Import"}
      </button>

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
            : "選擇檔案並輸入 SHOPLINE 匯出時間後開始匯入。"}
      </p>
    </form>
  );
}
