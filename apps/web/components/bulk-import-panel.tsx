"use client";

import { useCallback, useRef, useState } from "react";
import { useLocale } from "../lib/locale-context";
import {
  localized,
  sharedMessages,
  type BilingualMessage,
} from "../lib/ui-copy";
import { ImportStoreSetupPanel } from "./import-store-setup-panel";
import type { MaintenanceReference } from "./listing-intake-choices";
import type { MaintenanceReferenceRequest } from "../lib/catalog-maintenance-intent";
import { MaintenanceReferenceSelection } from "./maintenance-reference-selection";

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
  invalidatedApprovals: number;
  issues: BulkImportIssue[];
  replayed: boolean;
  alreadyImportedProducts: number;
  sourceImportId?: string;
  merchantAttestedExportAt?: string;
};

export type BulkImportFailure =
  | { kind: "validation_error"; message: BilingualMessage }
  | { kind: "api_error"; code: string; message: BilingualMessage }
  | { kind: "network_error"; message: BilingualMessage };

export type BulkImportOutcome = BulkImportSuccess | BulkImportFailure;
export type BulkImportDeps = { fetcher: typeof fetch };

// Named above the table because the panel raises them itself as well, before
// any request is sent.
const EXPORT_TIME_MISSING: BilingualMessage = [
  "請輸入 SHOPLINE 匯出時間。",
  "Enter the SHOPLINE export time.",
];
const EXPORT_TIME_INVALID: BilingualMessage = [
  "請輸入有效的 SHOPLINE 匯出時間。",
  "Enter a valid SHOPLINE export time.",
];

/**
 * Failures this panel has its own copy for, in both languages.
 *
 * Same shape and same rule as the batch screens (batch-list.tsx:44,
 * advance-batch-button.tsx:36): a code we recognise gets our wording, and
 * anything else falls back to the message the server sent.
 */
const API_ERROR_MESSAGES: Record<string, BilingualMessage> = {
  empty_upload: [
    "請附上 SHOPLINE Bulk Update 檔案。",
    "Attach a SHOPLINE bulk update form.",
  ],
  upload_too_large: [
    "Bulk Update 檔案過大。",
    "The bulk update form is too large.",
  ],
  upload_not_a_workbook: [
    "上載的檔案不是可讀取的 xlsx 活頁簿。",
    "The upload is not a readable xlsx workbook.",
  ],
  upload_sheet_name_unreadable: [
    "無法讀取上載檔案的工作表名稱。",
    "The upload's worksheet name could not be read.",
  ],
  bulk_form_unreadable: [
    "無法從此 Bulk Update 檔案讀取任何商品資料列。",
    "No product rows could be read from this bulk update form.",
  ],
  bulk_form_too_many_rows: [
    "此檔案的商品數量超過單次匯入上限。",
    "This form holds too many products for one import.",
  ],
  shopline_connection_missing: [
    "匯入商品目錄前，請先連結 SHOPLINE 商店。",
    "Connect a SHOPLINE store before importing a catalog.",
  ],
  bulk_form_ambiguous_identity: [
    "原始檔案有重複 Product ID，請先解決。",
    "Resolve duplicate Product IDs in the original export.",
  ],
  maintenance_reference_missing: [
    "此工作區沒有該參考資料。",
    "The reference is unavailable in this workspace.",
  ],
  maintenance_store_changed: [
    "店舖設定已變更，請重新核對。",
    "The store changed. Check it again.",
  ],
  maintenance_request_invalid: [
    "請填寫商品 ID 及確認店舖與來源。",
    "Supply the product ID and confirm the store and source.",
  ],
  maintenance_product_missing: [
    "新匯出檔沒有此商品的有效資料列，請核對 Product ID 及變體。",
    "The new export has no eligible row for this product. Check Product ID and variants.",
  ],
  maintenance_identity_conflict: [
    "商品身份、年份、容量或包裝有衝突，請先解決。",
    "Resolve product identity, vintage, volume or pack conflicts.",
  ],
  maintenance_identity_confirmation_required: [
    "有資料未確認，請人工核實商品身份及包裝。",
    "Manually verify unknown product identity and pack facts.",
  ],
  maintenance_source_confirmation_required: [
    "請確認店舖及目前的原始匯出檔。",
    "Confirm the store and current original export.",
  ],
  insufficient_role: sharedMessages.operatorRequired,
  merchant_attested_export_at_missing: EXPORT_TIME_MISSING,
  merchant_attested_export_at_invalid: EXPORT_TIME_INVALID,
  filename_missing: [
    "請選擇原始的 SHOPLINE 活頁簿。",
    "Choose the original SHOPLINE workbook.",
  ],
};

const NOT_A_WORKBOOK: BilingualMessage = [
  "請選擇 .xlsx 格式的 SHOPLINE Bulk Update 活頁簿。",
  "Choose an .xlsx SHOPLINE Bulk Update workbook.",
];
const TOO_LARGE: BilingualMessage = [
  "活頁簿超過 4 MiB 的執行限制。",
  "Workbook exceeds the 4 MiB runtime limit.",
];
const FILE_MISSING: BilingualMessage = [
  "請先選擇 SHOPLINE 活頁簿。",
  "Choose a SHOPLINE workbook first.",
];
const IMPORT_FAILED: BilingualMessage = ["匯入失敗。", "The import failed."];

export function validateBulkImportFile(file: File): BilingualMessage | null {
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return NOT_A_WORKBOOK;
  }
  if (file.size > MAX_BULK_IMPORT_BYTES) {
    return TOO_LARGE;
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
  options: {
    maintenance?: MaintenanceReferenceRequest;
    expectedConnectionId?: string;
  } = {},
): Promise<BulkImportOutcome> {
  const validationError = validateBulkImportFile(file);
  if (validationError)
    return { kind: "validation_error", message: validationError };

  if (!merchantAttestedExportTime) {
    return { kind: "validation_error", message: EXPORT_TIME_MISSING };
  }
  const merchantAttestedExportAt = merchantExportTimeToIso(
    merchantAttestedExportTime,
  );
  if (!merchantAttestedExportAt) {
    return { kind: "validation_error", message: EXPORT_TIME_INVALID };
  }

  const params = new URLSearchParams({
    merchantAttestedExportAt,
    filename: file.name,
  });
  if (options.expectedConnectionId)
    params.set("expectedConnectionId", options.expectedConnectionId);
  if (options.maintenance)
    for (const [key, value] of Object.entries(options.maintenance))
      params.set(key, String(value));

  let response: Response;
  try {
    // Native browser fetch must not receive the dependency object as its receiver.
    const { fetcher } = deps;
    response = await fetcher(`/api/listings/import?${params.toString()}`, {
      method: "POST",
      body: file,
    });
  } catch {
    return { kind: "network_error", message: sharedMessages.unreachable };
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return { kind: "network_error", message: sharedMessages.unreachable };
  }

  if (!response.ok) {
    const code = typeof body.code === "string" ? body.code : "unknown_error";
    // A message the server wrote is shown as it stands: translating it here
    // would mean inventing a Chinese version of text we did not write.
    const message: BilingualMessage = API_ERROR_MESSAGES[code] ?? IMPORT_FAILED;
    return { kind: "api_error", code, message };
  }

  return {
    kind: "success",
    replayed: body.replayed === true,
    alreadyImportedProducts:
      typeof body.alreadyImportedProducts === "number"
        ? body.alreadyImportedProducts
        : 0,
    ...(typeof body.sourceImportId === "string"
      ? { sourceImportId: body.sourceImportId }
      : {}),
    ...(typeof body.merchantAttestedExportAt === "string"
      ? { merchantAttestedExportAt: body.merchantAttestedExportAt }
      : {}),
    specVersion: body.specVersion as string,
    parsedRows: body.parsedRows as number,
    createdDrafts: body.createdDrafts as number,
    refreshedProducts: body.refreshedProducts as number,
    // Older servers omit it; absent means nothing was invalidated.
    invalidatedApprovals:
      typeof body.invalidatedApprovals === "number"
        ? body.invalidatedApprovals
        : 0,
    issues: (body.issues as BulkImportIssue[]) ?? [],
  };
}

export function BulkImportPanel({
  reference,
}: { reference?: MaintenanceReference } = {}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [outcome, setOutcome] = useState<BulkImportOutcome | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [merchantExportTime, setMerchantExportTime] = useState("");
  const [busy, setBusy] = useState(false);
  const submittingRef = useRef(false);
  const [importReady, setImportReady] = useState(false);
  const [connectionId, setConnectionId] = useState<string | undefined>();
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [remoteProductId, setRemoteProductId] = useState("");
  const readyChanged = useCallback((ready: boolean, id?: string) => {
    setImportReady(ready);
    setConnectionId(id);
    setSourceConfirmed(false);
    setIdentityConfirmed(false);
  }, []);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0] ?? null;
    setFile(selectedFile);
    setOutcome(null);
    setSourceConfirmed(false);
    setIdentityConfirmed(false);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      submittingRef.current ||
      !importReady ||
      !connectionId ||
      !sourceConfirmed ||
      (reference && (!remoteProductId.trim() || !identityConfirmed))
    )
      return;
    if (!file) {
      setOutcome({ kind: "validation_error", message: FILE_MISSING });
      return;
    }
    if (!merchantExportTime) {
      setOutcome({ kind: "validation_error", message: EXPORT_TIME_MISSING });
      return;
    }

    submittingRef.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(
        await submitBulkImport(file, merchantExportTime, undefined, {
          expectedConnectionId: connectionId,
          ...(reference
            ? {
                maintenance: {
                  referenceKind: reference.kind,
                  referenceId: reference.id,
                  remoteProductId: remoteProductId.trim(),
                  expectedConnectionId: connectionId,
                  identityConfirmed,
                  storeSourceConfirmed: sourceConfirmed,
                },
              }
            : {}),
        }),
      );
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <ImportStoreSetupPanel onImportReadyChange={readyChanged} />
      <form className="intake-form" onSubmit={handleSubmit}>
        {reference ? (
          <MaintenanceReferenceSelection
            reference={reference}
            productId={remoteProductId}
            onProductIdChange={(value) => {
              setRemoteProductId(value);
              setIdentityConfirmed(false);
              setOutcome(null);
            }}
            confirmed={identityConfirmed}
            onConfirmedChange={setIdentityConfirmed}
            disabled={busy}
          />
        ) : null}
        <p className="helper-copy">
          {t(
            "請上載此店舖目前的原始 SHOPLINE Bulk Update 檔；舊參考資料不會被複製成最新來源。此步會匯入檔案內所有有效資料列為維護草稿，不會寫入 SHOPLINE。",
            "Upload this store's current original SHOPLINE Bulk Update file. Old reference rows are not copied into a new source. All eligible rows become maintenance drafts; this step does not write to SHOPLINE.",
          )}
        </p>
        <div className="upload-dropzone">
          <label htmlFor="bulk-import-file" className="upload-label">
            <span className="upload-title">
              {t(
                "匯入 SHOPLINE Bulk Update 匯出檔",
                "Import a SHOPLINE Bulk Update export",
              )}
            </span>
            <span className="upload-subtitle">
              {t(
                "上載最新匯出的 .xlsx 檔案 · 最多 4 MiB",
                "Upload the most recent .xlsx export · 4 MiB maximum",
              )}
            </span>
            <span className="secondary-button upload-button">
              {t("選擇檔案", "Select file")}
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

        {file ? (
          <p className="intake-message">
            {t(`已選擇：${file.name}`, `Selected: ${file.name}`)}
          </p>
        ) : null}

        <label htmlFor="merchant-attested-export-at">
          {t(
            "SHOPLINE 匯出時間（香港時間 UTC+08:00）",
            "SHOPLINE export time (Hong Kong time, UTC+08:00)",
          )}
        </label>
        <input
          id="merchant-attested-export-at"
          type="datetime-local"
          value={merchantExportTime}
          disabled={busy}
          onChange={(event) => {
            setMerchantExportTime(event.target.value);
            setSourceConfirmed(false);
            setIdentityConfirmed(false);
            setOutcome(null);
          }}
        />
        <label>
          <input
            id="bulk-source-confirmation"
            type="checkbox"
            checked={sourceConfirmed}
            disabled={busy || !importReady}
            onChange={(event) => setSourceConfirmed(event.target.checked)}
          />
          {t(
            "我確認這是上述店舖目前的原始匯出檔，並已核對匯出時間。",
            "I confirm this is the above store's current original export and I checked its export time.",
          )}
        </label>

        <button
          type="submit"
          className="primary-button"
          disabled={
            busy ||
            !importReady ||
            !connectionId ||
            !sourceConfirmed ||
            Boolean(
              reference && (!remoteProductId.trim() || !identityConfirmed),
            )
          }
        >
          {busy ? t("匯入中…", "Importing…") : t("開始匯入", "Start import")}
        </button>

        {outcome?.kind === "success" ? (
          <ul className="file-list" aria-live="polite">
            {outcome.replayed ? (
              <li>
                {t(
                  `相同檔案已匯入：${outcome.alreadyImportedProducts} 列；保留原匯出時間及來源。`,
                  `This file was already imported: ${outcome.alreadyImportedProducts} rows. Original export time and source are retained.`,
                )}
              </li>
            ) : null}
            {outcome.sourceImportId ? (
              <li>
                {t("來源收據", "Source receipt")}: {outcome.sourceImportId}
              </li>
            ) : null}
            {outcome.merchantAttestedExportAt ? (
              <li>
                {t("保留的匯出時間", "Recorded export time")}:{" "}
                {outcome.merchantAttestedExportAt}
              </li>
            ) : null}
            <li>
              <a href="/queue">
                {t("查看維護草稿", "View maintenance drafts")}
              </a>
            </li>
            <li>
              {/* Labelled figures rather than a sentence, so one phrasing
                  reads correctly for any count in either language. */}
              {t(
                `已解析 ${outcome.parsedRows} 列 · 新增 ${outcome.createdDrafts} 筆草稿 · 更新 ${outcome.refreshedProducts} 筆`,
                `Rows parsed: ${outcome.parsedRows} · Drafts created: ${outcome.createdDrafts} · Products updated: ${outcome.refreshedProducts}`,
              )}
            </li>
            {outcome.invalidatedApprovals > 0 ? (
              <li>
                {t(
                  `已失效批准 ${outcome.invalidatedApprovals} 筆 · 這些商品須重新批准才能匯出`,
                  `Approvals invalidated: ${outcome.invalidatedApprovals} · These listings need renewed approval before export`,
                )}
              </li>
            ) : null}
            {outcome.issues.map((issue, index) => (
              // Server-written, so shown as it stands in either language.
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
        ) : null}

        <p className="intake-message" role="status" aria-live="polite">
          {busy
            ? t("匯入中…", "Importing…")
            : outcome && outcome.kind !== "success"
              ? localized(locale, ...outcome.message)
              : t(
                  "選擇檔案並輸入 SHOPLINE 匯出時間後開始匯入。",
                  "Choose a file and enter the SHOPLINE export time, then start the import.",
                )}
        </p>
      </form>
    </>
  );
}
