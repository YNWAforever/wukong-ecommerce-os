"use client";
import { ListingEvidenceLookup } from "./listing-evidence-lookup";
import type { CandidateDiff } from "../lib/listing-candidate-service";
import { useEffect, useRef, useState } from "react";
import {
  applyWorkingChanges,
  readWorkingField,
  reviewableListingSchema,
  workingFields,
  type WorkingListing,
  type WorkingField,
  type WorkingFieldStates,
  type WorkingChange,
  type SourceSelection,
} from "@wukong/core";
import { uploadSourceAsset } from "../lib/browser-asset-upload";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
export type WorkingCopyInput = {
  revision: number;
  baseVersionId: string | null;
  note: string | null;
  workingContent: WorkingListing;
  fieldStates: WorkingFieldStates;
  sources: SourceSelection[];
};
export type WorkingSourcePreview = {
  assetId: string;
  mimeType: string;
  name: string;
  previewUrl: string | null;
};
type Props = {
  listingId: string;
  input: WorkingCopyInput;
  sources: WorkingSourcePreview[];
  canEdit: boolean;
  busy?: boolean;
  currentRunId?: string;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved: () => Promise<void>;
  onProcessingAccepted?: (processing: { runId: string; state: string }) => void;
};
const labels: Partial<Record<WorkingField, [string, string]>> = {
  sku: ["商戶貨號", "Merchant SKU"],
  producer: ["生產商", "Producer"],
  productType: ["產品類型", "Product type"],
  country: ["國家", "Country"],
  region: ["產區", "Region"],
  vintage: ["年份", "Vintage"],
  grapeVarieties: ["葡萄品種（逗號分隔）", "Grapes (comma separated)"],
  volumeMl: ["容量 (ml)", "Volume (ml)"],
  abvPercent: ["酒精濃度 (%)", "ABV (%)"],
  packQuantity: ["包裝數量", "Pack quantity"],
  priceHkd: ["售價 (HK$)", "Selling price (HK$)"],
  stockQuantity: ["庫存", "Stock"],
  "title.en": ["英文名稱", "English title"],
  "title.zh-Hant": ["中文名稱", "Chinese title"],
  "description.en": ["英文描述", "English description"],
  "description.zh-Hant": ["中文描述", "Chinese description"],
  "seo.title.en": ["英文 SEO 名稱", "English SEO title"],
  "seo.title.zh-Hant": ["中文 SEO 名稱", "Chinese SEO title"],
  "seo.description.en": ["英文 SEO 描述", "English SEO description"],
  "seo.description.zh-Hant": ["中文 SEO 描述", "Chinese SEO description"],
  tags: ["標籤（逗號分隔）", "Tags (comma separated)"],
};
const numeric = new Set<WorkingField>([
  "vintage",
  "volumeMl",
  "abvPercent",
  "packQuantity",
  "priceHkd",
  "stockQuantity",
]);
const fields = workingFields.filter((field) => labels[field]);
function values(content: WorkingListing) {
  return Object.fromEntries(
    fields.map((field) => {
      const value = readWorkingField(content, field);
      return [
        field,
        value === null
          ? ""
          : Array.isArray(value)
            ? value.join(", ")
            : String(value),
      ];
    }),
  ) as Record<WorkingField, string>;
}
function changesFrom(
  base: WorkingCopyInput,
  raw: Record<WorkingField, string>,
  locks: WorkingFieldStates,
): WorkingChange[] {
  return fields.flatMap((field) => {
    const text = raw[field] ?? "";
    const value = numeric.has(field)
      ? text.trim() === ""
        ? null
        : Number(text)
      : ["tags", "grapeVarieties"].includes(field)
        ? text
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : field.includes(".")
          ? text
          : text.trim() === ""
            ? null
            : text;
    const state =
      locks[field]?.state === "not_applicable"
        ? ("not_applicable" as const)
        : undefined;
    if (
      JSON.stringify(value) ===
        JSON.stringify(readWorkingField(base.workingContent, field)) &&
      Boolean(locks[field]?.locked) ===
        Boolean(base.fieldStates[field]?.locked) &&
      state ===
        (base.fieldStates[field]?.state === "not_applicable"
          ? "not_applicable"
          : undefined)
    )
      return [];
    return [
      {
        field,
        value,
        locked: locks[field]?.locked ?? false,
        ...(state ? { state } : {}),
      },
    ];
  });
}
export function ListingWorkingCopy({
  listingId,
  input,
  sources,
  canEdit,
  busy,
  onDirtyChange,
  onSaved,
  onProcessingAccepted,
  currentRunId,
}: Props) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [base, setBase] = useState(input);
  const [raw, setRaw] = useState(() => values(input.workingContent));
  const [note, setNote] = useState(input.note ?? "");
  const [selected, setSelected] = useState(input.sources);
  const [locks, setLocks] = useState(input.fieldStates);
  const [dirty, setDirty] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [uploads, setUploads] = useState<
    Array<{
      id: string;
      file: File;
      key?: string;
      assetId?: string;
      failed?: boolean;
    }>
  >([]);
  const [localPreviews, setLocalPreviews] = useState<WorkingSourcePreview[]>(
    [],
  );
  const operation = useRef<{ body: string; key: string } | null>(null);
  const urls = useRef<string[]>([]);
  function reset(next: WorkingCopyInput) {
    setBase(next);
    setRaw(values(next.workingContent));
    setNote(next.note ?? "");
    setSelected(next.sources);
    setLocks(next.fieldStates);
    setDirty(false);
    setConflict(false);
    operation.current = null;
  }
  useEffect(() => {
    if (
      !dirty &&
      !saving &&
      input.revision >= base.revision &&
      (input.revision !== base.revision ||
        input.baseVersionId !== base.baseVersionId)
    )
      reset(input);
  }, [input, dirty, saving, base.revision, base.baseVersionId]);
  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
    },
    [],
  );
  function edit(field: WorkingField, value: string) {
    setRaw((previous) => ({ ...previous, [field]: value }));
    setDirty(true);
    setMessage("");
  }
  let content: WorkingListing | null = null;
  let changes: WorkingChange[] = [];
  try {
    changes = changesFrom(base, raw, locks);
    content = applyWorkingChanges(
      base.workingContent,
      base.fieldStates,
      changes,
    ).content;
    content.imageAssetIds = selected
      .filter((s) => s.role !== "supplier_document")
      .map((s) => s.assetId);
  } catch {
    /* Validation guidance is shown on save; retain the typed value. */
  }
  const complete =
    content !== null && reviewableListingSchema.safeParse(content).success;
  async function save(action: "save" | "save_and_process" | "promote") {
    if (!canEdit || saving) return;
    if (!content) {
      setMessage(
        t(
          "請檢查欄位格式；數值不可為負數。",
          "Check field formats; numeric values must be valid.",
        ),
      );
      return;
    }
    if (uploads.some((x) => !x.assetId)) {
      setMessage(
        t(
          "請重試或移除尚未完成的上傳。",
          "Retry or remove unfinished uploads first.",
        ),
      );
      return;
    }
    setSaving(true);
    setMessage("");
    setConflict(false);
    const payload =
      action === "promote"
        ? {
            baseVersionId: base.baseVersionId,
            expectedInputRevision: base.revision,
            content,
          }
        : {
            expectedInputRevision: base.revision,
            baseVersionId: base.baseVersionId,
            note,
            sources: selected.map(({ assetId, role, use, hero }) => ({
              assetId,
              role,
              use,
              hero,
            })),
            changes,
            action,
          };
    const body = JSON.stringify(payload);
    if (operation.current?.body !== body)
      operation.current = { body, key: crypto.randomUUID() };
    try {
      const response = await fetch(
        `/api/listings/${listingId}/${action === "promote" ? "review" : "inputs"}`,
        {
          method: action === "promote" ? "PUT" : "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": operation.current!.key,
          },
          body,
        },
      );
      const result = (await response.json()) as {
        code?: string;
        inputRevision?: number;
        versionId?: string;
        processing?: { runId: string; state: string };
      };
      if (!response.ok) {
        if (
          response.status === 409 &&
          [
            "input_revision_conflict",
            "base_version_conflict",
            "stale_version",
            "idempotency_conflict",
          ].includes(result.code ?? "")
        ) {
          setConflict(true);
          setMessage(
            t(
              "另一個版本已保存。你的輸入仍保留；重新載入前請先複製需要保留的修改。",
              "A newer revision was saved. Your edits remain here; copy anything you need before reloading.",
            ),
          );
        } else
          setMessage(
            result.code === "listing_recovery_setup_required"
              ? t(
                  "資料庫設定尚未完成。請聯絡管理員；你的修改仍保留。",
                  "Database setup is incomplete. Contact an administrator; your edits remain here.",
                )
              : response.status === 401
                ? t(
                    "請重新登入；保留此頁以免遺失未保存的修改。",
                    "Sign in again; keep this page open to retain unsaved edits.",
                  )
                : response.status === 403
                  ? t("你沒有修改權限。", "You do not have permission to edit.")
                  : response.status === 429
                    ? t(
                        "AI 額度不足；你仍可選擇只保存。",
                        "AI capacity is unavailable; you can still save without processing.",
                      )
                    : action === "save_and_process"
                      ? t(
                          "未能開始 AI 處理。請先只保存，然後再試。",
                          "AI processing could not start. Save without processing, then retry.",
                        )
                      : t(
                          "未能保存。請檢查欄位或來源並重試。",
                          "Could not save. Check the fields and sources, then retry.",
                        ),
          );
        return;
      }
      setBase({
        ...base,
        revision: result.inputRevision ?? base.revision + 1,
        baseVersionId: result.versionId ?? base.baseVersionId,
        note,
        workingContent: content,
        fieldStates: applyWorkingChanges(
          base.workingContent,
          base.fieldStates,
          changes,
        ).fieldStates,
        sources: selected,
      });
      setDirty(false);
      operation.current = null;
      setUploads([]);
      if (result.processing) onProcessingAccepted?.(result.processing);
      setMessage(
        action === "promote"
          ? t("已保存為待審核版本。", "Saved as a version for review.")
          : t(
              "草稿已保存；售價及 SKU 可稍後補充。",
              "Draft saved; price and SKU can be added later.",
            ),
      );
      try {
        await onSaved();
      } catch {
        setMessage(
          t(
            "已保存，但未能更新畫面。重新載入可查看已保存的版本。",
            "Saved, but the view could not refresh. Reload to see the saved revision.",
          ),
        );
      }
    } catch {
      setMessage(
        t(
          "連線中斷，保存結果未確認。再次按保存會安全重試同一次操作。",
          "Connection lost; the save result is unconfirmed. Save again to retry the same operation.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }
  async function upload(item: { id: string; file: File; key?: string }) {
    setSaving(true);
    setMessage("");
    try {
      const result = await uploadSourceAsset(
        item.file,
        {
          onStored: (key) =>
            setUploads((previous) =>
              previous.map((x) => (x.id === item.id ? { ...x, key } : x)),
            ),
        },
        item.key ? { key: item.key } : undefined,
      );
      setUploads((previous) =>
        previous.map((x) =>
          x.id === item.id ? { ...x, ...result, failed: false } : x,
        ),
      );
      const image = item.file.type.startsWith("image/");
      const previewUrl = image ? URL.createObjectURL(item.file) : null;
      if (previewUrl) urls.current.push(previewUrl);
      setLocalPreviews((previous) => [
        ...previous,
        {
          assetId: result.assetId,
          mimeType: item.file.type,
          name: item.file.name,
          previewUrl,
        },
      ]);
      setSelected((previous) => [
        ...previous,
        {
          assetId: result.assetId,
          role: image ? "other_image" : "supplier_document",
          use: "analyse",
          hero: false,
        },
      ]);
      setDirty(true);
    } catch {
      setUploads((previous) =>
        previous.map((x) => (x.id === item.id ? { ...x, failed: true } : x)),
      );
      setMessage(
        t(
          "上傳未完成；已完成的檔案仍保留。",
          "Upload incomplete; completed files are retained.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }
  const [candidate, setCandidate] = useState<CandidateDiff | null>(null);
  const [candidateRunId, setCandidateRunId] = useState<string | null>(null);
  const [candidateRevision, setCandidateRevision] = useState<number | null>(
    null,
  );
  const [candidateBaseVersion, setCandidateBaseVersion] = useState<
    string | null
  >(null);
  const [candidateFields, setCandidateFields] = useState<WorkingField[]>([]);
  const adoption = useRef<{ body: string; key: string } | null>(null);
  async function loadCandidate() {
    if (!currentRunId) return;
    setSaving(true);
    try {
      const response = await fetch(
        `/api/listings/${listingId}/runs/${currentRunId}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error();
      const result = (await response.json()) as {
        candidate: CandidateDiff | null;
      };
      setCandidateRunId(currentRunId);
      setCandidateRevision(base.revision);
      setCandidateBaseVersion(base.baseVersionId);
      setCandidate(result.candidate);
      setCandidateFields([]);
      if (!result.candidate)
        setMessage(
          t(
            "此處理沒有可比較的候選內容。",
            "This run has no stored candidate to compare.",
          ),
        );
    } catch {
      setMessage(
        t(
          "未能載入候選內容。請重試。",
          "Could not load the stored candidate. Retry.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }
  async function adoptCandidate() {
    if (
      !candidateRunId ||
      candidateRevision !== base.revision ||
      candidateBaseVersion !== base.baseVersionId ||
      dirty ||
      !canEdit ||
      !candidateFields.length
    )
      return;
    const body = JSON.stringify({
      expectedInputRevision: base.revision,
      baseVersionId: base.baseVersionId,
      selectedFieldPaths: [...candidateFields].sort(),
    });
    if (adoption.current?.body !== body)
      adoption.current = { body, key: crypto.randomUUID() };
    setSaving(true);
    try {
      const response = await fetch(
        `/api/listings/${listingId}/runs/${candidateRunId}/adopt`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": adoption.current!.key,
          },
          body,
        },
      );
      const result = (await response.json()) as { code?: string };
      if (!response.ok) {
        setConflict(
          ["input_revision_conflict", "base_version_conflict"].includes(
            result.code ?? "",
          ),
        );
        setMessage(
          result.code === "field_locked"
            ? t(
                "先保存解除鎖定，再採用此欄位。",
                "Save an explicit unlock before adopting this field.",
              )
            : t(
                "候選內容與目前版本不相容。請重新載入並比較。",
                "The candidate no longer matches this revision. Reload and compare.",
              ),
        );
        return;
      }
      adoption.current = null;
      setCandidate(null);
      setCandidateFields([]);
      setMessage(
        t(
          "已採用選取的欄位並保存；仍需正常審核。",
          "Selected fields were adopted and saved; normal review is still required.",
        ),
      );
      await onSaved();
    } catch {
      setMessage(
        t(
          "結果未確認。再次按採用會重試同一次操作。",
          "Result unconfirmed. Adopt again to retry the same operation.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }
  const previews = [...sources, ...localPreviews];
  return (
    <section
      className="panel working-copy"
      aria-label={t("商品工作草稿", "Product working draft")}
    >
      <h2>{t("補充商品資料", "Complete product details")}</h2>
      <p className="helper-copy">
        {t("工作草稿版本", "Input revision")} {base.revision} ·{" "}
        {dirty ? t("尚未保存", "Unsaved changes") : t("已保存", "Saved")}
      </p>
      <p>
        {t(
          "未知的資料可留空。手動保存不需使用 AI。",
          "Leave unknown values blank. Manual saving does not require AI.",
        )}
      </p>
      {busy ? (
        <p role="status">
          {t(
            "AI 正在處理；保存修改會保留你的新資料並停止套用舊結果。",
            "AI is processing. Saving changes preserves your new input and prevents the old result from replacing it.",
          )}
        </p>
      ) : null}
      <fieldset
        disabled={!canEdit || saving}
        style={{ border: 0, padding: 0, minWidth: 0 }}
      >
        <label htmlFor={`note-${listingId}`}>
          {t("來源備註", "Source note")}
        </label>
        <textarea
          id={`note-${listingId}`}
          value={note}
          maxLength={5000}
          rows={3}
          onChange={(e) => {
            setNote(e.target.value);
            setDirty(true);
          }}
          style={{ width: "100%", boxSizing: "border-box" }}
        />
        <h3>{t("來源相片及文件", "Source photos and documents")}</h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,220px),1fr))",
            gap: 16,
          }}
        >
          {selected.map((source, index) => {
            const preview = previews.find((p) => p.assetId === source.assetId);
            return (
              <div key={source.assetId}>
                {preview?.previewUrl &&
                preview.mimeType.startsWith("image/") ? (
                  <img
                    src={preview.previewUrl}
                    alt={preview.name}
                    width={160}
                    height={160}
                    style={{ objectFit: "contain", maxWidth: "100%" }}
                  />
                ) : (
                  <span>
                    {preview?.name ?? t("來源文件", "Source document")}
                  </span>
                )}
                <label>
                  {t("來源用途", "Source role")}
                  <select
                    value={source.role}
                    onChange={(e) => {
                      setSelected((previous) =>
                        previous.map((x) =>
                          x.assetId === source.assetId
                            ? {
                                ...x,
                                role: e.target.value as SourceSelection["role"],
                              }
                            : x,
                        ),
                      );
                      setDirty(true);
                    }}
                  >
                    {source.role === "supplier_document" ? (
                      <option value="supplier_document">
                        {t("供應商文件", "Supplier document")}
                      </option>
                    ) : (
                      <>
                        <option value="front_label">
                          {t("正面標籤", "Front label")}
                        </option>
                        <option value="back_label">
                          {t("背面標籤", "Back label")}
                        </option>
                        <option value="other_image">
                          {t("其他相片", "Other image")}
                        </option>
                      </>
                    )}
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={source.use === "reference_only"}
                    onChange={(e) => {
                      setSelected((previous) =>
                        previous.map((x) =>
                          x.assetId === source.assetId
                            ? {
                                ...x,
                                use: e.target.checked
                                  ? "reference_only"
                                  : "analyse",
                              }
                            : x,
                        ),
                      );
                      setDirty(true);
                    }}
                  />
                  {t("只供參考，不交予 AI", "Reference only; exclude from AI")}
                </label>
                {source.role !== "supplier_document" ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={source.hero}
                      onChange={(e) => {
                        setSelected((previous) =>
                          previous.map((x) => ({
                            ...x,
                            hero:
                              x.assetId === source.assetId
                                ? e.target.checked
                                : false,
                          })),
                        );
                        setDirty(true);
                      }}
                    />
                    {t("主要圖片", "Hero image")}
                  </label>
                ) : null}
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => {
                    setSelected((previous) => {
                      const next = [...previous];
                      [next[index - 1], next[index]] = [
                        next[index]!,
                        next[index - 1]!,
                      ];
                      return next;
                    });
                    setDirty(true);
                  }}
                >
                  {t("上移", "Move up")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelected((previous) =>
                      previous.filter((x) => x.assetId !== source.assetId),
                    );
                    setUploads((previous) =>
                      previous.filter((x) => x.assetId !== source.assetId),
                    );
                    setDirty(true);
                  }}
                >
                  {t("移除", "Remove")}
                </button>
              </div>
            );
          })}
        </div>
        <label>
          {t("加入相片或 PDF", "Add photos or PDF")}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            multiple
            onChange={async (e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = "";
              if (
                selected.length + files.length > 11 ||
                selected.filter((s) => s.role !== "supplier_document").length +
                  files.filter((f) => f.type.startsWith("image/")).length >
                  10 ||
                selected.filter((s) => s.role === "supplier_document").length +
                  files.filter((f) => f.type === "application/pdf").length >
                  1 ||
                files.some(
                  (f) =>
                    f.size === 0 ||
                    f.size > 20 * 1024 * 1024 ||
                    ![
                      "image/jpeg",
                      "image/png",
                      "image/webp",
                      "application/pdf",
                    ].includes(f.type),
                )
              ) {
                setMessage(
                  t(
                    "最多 10 張相片及 1 份 PDF，每個不超過 20 MB；請使用 JPEG、PNG、WebP 或 PDF。",
                    "Use up to 10 images and 1 PDF, each under 20 MB.",
                  ),
                );
                return;
              }
              for (const file of files) {
                const item = { id: crypto.randomUUID(), file };
                setUploads((previous) => [...previous, item]);
                await upload(item);
              }
            }}
          />
        </label>
        {uploads
          .filter((x) => x.failed)
          .map((item) => (
            <p key={item.id}>
              {item.file.name}{" "}
              <button type="button" onClick={() => upload(item)}>
                {t("重試上傳", "Retry upload")}
              </button>{" "}
              <button
                type="button"
                onClick={() =>
                  setUploads((previous) =>
                    previous.filter((x) => x.id !== item.id),
                  )
                }
              >
                {t("移除", "Remove")}
              </button>
            </p>
          ))}
        <h3>{t("商品資料", "Product facts")}</h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,260px),1fr))",
            gap: 16,
          }}
        >
          {fields.map((field) => {
            const label = labels[field]!;
            const id = `working-${listingId}-${field}`;
            return (
              <div key={field}>
                <label htmlFor={id}>{t(label[0], label[1])}</label>
                {field === "productType" ? (
                  <select
                    id={id}
                    value={raw[field]}
                    onChange={(e) => edit(field, e.target.value)}
                  >
                    <option value="">{t("未知", "Unknown")}</option>
                    {["wine", "spirits", "sake", "other"].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                ) : field.includes("description") ? (
                  <textarea
                    id={id}
                    value={raw[field]}
                    rows={3}
                    onChange={(e) => edit(field, e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  />
                ) : (
                  <input
                    id={id}
                    value={raw[field]}
                    type={numeric.has(field) ? "number" : "text"}
                    step="any"
                    onChange={(e) => edit(field, e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  />
                )}
                {field === "vintage" ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={locks.vintage?.state === "not_applicable"}
                      onChange={(e) => {
                        setLocks((previous) => ({
                          ...previous,
                          vintage: {
                            owner: "operator",
                            state: e.target.checked
                              ? "not_applicable"
                              : "unknown",
                            locked: previous.vintage?.locked ?? false,
                            evidenceRefs: [],
                          },
                        }));
                        if (e.target.checked) edit("vintage", "");
                        setDirty(true);
                      }}
                    />
                    {t("無年份", "Non-vintage")}
                  </label>
                ) : null}
                <label>
                  <input
                    type="checkbox"
                    checked={locks[field]?.locked ?? false}
                    onChange={(e) => {
                      setLocks((previous) => ({
                        ...previous,
                        [field]: {
                          owner: "operator",
                          state: "manual",
                          locked: e.target.checked,
                          evidenceRefs: [],
                        },
                      }));
                      setDirty(true);
                    }}
                  />
                  {t("鎖定此欄位", "Lock this field")}
                </label>
              </div>
            );
          })}
        </div>
      </fieldset>
      {currentRunId ? (
        <section aria-label={t("AI 候選比較", "AI candidate comparison")}>
          <h3>{t("比較先前 AI 建議", "Compare stored AI suggestions")}</h3>
          <button
            type="button"
            data-action="load-candidate"
            disabled={saving}
            onClick={loadCandidate}
          >
            {t("載入候選內容", "Load candidate")}
          </button>
          {dirty ? (
            <p>
              {t(
                "請先保存或捨棄修改，再採用候選欄位。",
                "Save or discard edits before adopting candidate fields.",
              )}
            </p>
          ) : null}
          {candidate ? (
            <>
              <p>
                {t("候選來源版本", "Candidate input revision")}{" "}
                {candidate.inputRevision}
              </p>
              {candidateRevision !== base.revision ||
              candidateBaseVersion !== base.baseVersionId ? (
                <p>
                  {t(
                    "目前版本已變更，請重新載入候選比較。",
                    "The current revision changed. Load the candidate comparison again.",
                  )}
                </p>
              ) : null}
              {candidate.fields.map((field) => (
                <div
                  key={field.field}
                  style={{ marginBlock: 16, overflowWrap: "anywhere" }}
                >
                  <label>
                    <input
                      type="checkbox"
                      data-candidate-field={field.field}
                      disabled={!canEdit || saving || dirty || !field.eligible}
                      checked={candidateFields.includes(field.field)}
                      onChange={(e) =>
                        setCandidateFields((previous) =>
                          e.target.checked
                            ? [...previous, field.field]
                            : previous.filter((f) => f !== field.field),
                        )
                      }
                    />
                    {labels[field.field]
                      ? t(labels[field.field]![0], labels[field.field]![1])
                      : field.field}
                  </label>
                  <p>
                    {t("目前", "Current")}: {JSON.stringify(field.currentValue)}
                  </p>
                  <p>
                    {t("建議", "Suggested")}: {JSON.stringify(field.value)}
                  </p>
                  {!field.eligible ? (
                    <p>
                      {field.reason === "field_locked"
                        ? t("欄位已鎖定", "Field locked")
                        : t(
                            "與目前來源不相容，或屬商戶專有資料",
                            "Incompatible with current sources or merchant-only data",
                          )}
                    </p>
                  ) : null}
                  {field.evidence.length ? (
                    field.evidence.map((e, index) => (
                      <blockquote key={index}>
                        {e.excerpt}{" "}
                        <small>
                          {t("來源", "Source")}: {e.sourceAssetId}
                        </small>
                      </blockquote>
                    ))
                  ) : (
                    <p>
                      {t(
                        "沒有此欄位的獨立來源證據；採用不等同核實。",
                        "No independent field evidence; adoption does not verify the value.",
                      )}
                    </p>
                  )}
                </div>
              ))}
              <button
                type="button"
                data-action="adopt-candidate"
                disabled={
                  !canEdit ||
                  saving ||
                  dirty ||
                  candidateRevision !== base.revision ||
                  candidateBaseVersion !== base.baseVersionId ||
                  !candidateFields.length
                }
                onClick={adoptCandidate}
              >
                {t("採用選取欄位並保存", "Adopt selected fields and save")}
              </button>
            </>
          ) : null}
        </section>
      ) : null}
      {message ? <p role={conflict ? "alert" : "status"}>{message}</p> : null}
      {conflict ? (
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            await onSaved();
            reset(input);
          }}
        >
          {t("捨棄未保存的修改並重新載入", "Discard unsaved edits and reload")}
        </button>
      ) : null}
      <div
        className="button-row"
        style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 20 }}
      >
        <button
          type="button"
          className="button primary"
          data-action="save"
          disabled={!canEdit || saving}
          onClick={() => save("save")}
        >
          {saving ? t("保存中…", "Saving…") : t("只保存草稿", "Save draft")}
        </button>
        <button
          type="button"
          className="button"
          data-action="process"
          disabled={!canEdit || saving}
          onClick={() => save("save_and_process")}
        >
          {t("保存並交予 AI 處理", "Save and process with AI")}
        </button>
        <button
          type="button"
          className="button"
          data-action="promote"
          disabled={!canEdit || saving || !complete || dirty}
          onClick={() => save("promote")}
        >
          {t("儲存為待審核版本", "Save as a review version")}
        </button>
      </div>
      {complete && dirty ? (
        <p className="helper-copy">
          {t(
            "請先保存修改，再提交此已保存的工作草稿供審核。",
            "Save changes first, then submit the saved working draft for review.",
          )}
        </p>
      ) : null}
      <details onToggle={(event) => setEvidenceOpen(event.currentTarget.open)}>
        <summary>
          {t("查找公開產品來源證據", "Look up public product evidence")}
        </summary>
        {evidenceOpen ? (
          <ListingEvidenceLookup
            listingId={listingId}
            input={base}
            canEdit={canEdit}
            dirty={dirty}
            onSaved={onSaved}
          />
        ) : null}
      </details>
      {!complete ? (
        <p className="helper-copy">
          {t(
            "手動提交審核前，請完成雙語名稱、描述、SEO 及包裝數量。其他未知資料仍可留空。",
            "Before manual review, complete bilingual title, description, SEO and pack quantity. Other unknown values can stay blank.",
          )}
        </p>
      ) : null}
    </section>
  );
}
