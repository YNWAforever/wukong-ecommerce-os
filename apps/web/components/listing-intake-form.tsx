"use client";

import { useMemo, useState } from "react";

import {
  isImageMimeType,
  MAX_ASSET_SIZE,
  rejectAsset,
  type MediaRejection,
} from "@wukong/assets/media-policy";

type IntakeFileState = {
  id: string;
  file: File;
  status: "ready" | "uploading" | "uploaded" | "error";
  message?: string;
};

export type ListingIntakePayload = { files: File[]; note: string };
export type ListingIntakeFormProps = {
  onCreate?: (payload: ListingIntakePayload) => Promise<void> | void;
};

/**
 * Identifies a chosen file well enough to spot the same one picked twice.
 *
 * Also the React key, so it must not depend on position: re-validating the
 * union renumbers the array, and an index-based key would make React reuse the
 * wrong row and show one file's status against another's name.
 */
function fileIdentity(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

const rejectionCopy: Record<MediaRejection, string> = {
  unsupported_type: "只接受 JPG、PNG、WebP 或 PDF。",
  empty_file: "檔案是空的，請重新選取。",
  too_large: `檔案超過 ${Math.round(MAX_ASSET_SIZE / (1024 * 1024))} MB 上限。`,
  too_many_images: "圖片數量已達上限。",
  too_many_pdfs: "PDF 數量已達上限。",
};

/**
 * Applies the SHARED media policy, so what this form accepts is what presign,
 * finalize and the create route accept. It previously enforced no size limit at
 * all, so an operator could be told a 25 MB photo was ready and only discover
 * the cap once presign refused it -- after they had committed to the upload.
 */
function validateFiles(files: File[]): {
  accepted: IntakeFileState[];
  errors: string[];
} {
  const errors: string[] = [];
  const accepted: IntakeFileState[] = [];
  let images = 0;
  let pdfs = 0;
  for (const file of files) {
    const rejection = rejectAsset(
      { mimeType: file.type, size: file.size },
      { imagesBefore: images, pdfsBefore: pdfs },
    );
    if (rejection === null) {
      if (isImageMimeType(file.type)) images += 1;
      else pdfs += 1;
    } else if (
      (rejection === "too_many_images" || rejection === "too_many_pdfs") &&
      !errors.includes(rejectionCopy[rejection])
    ) {
      errors.push(rejectionCopy[rejection]);
    }
    accepted.push({
      id: fileIdentity(file),
      file,
      status: rejection === null ? "ready" : "error",
      message: rejection === null ? undefined : rejectionCopy[rejection],
    });
  }
  return { accepted, errors };
}

export function ListingIntakeForm({ onCreate }: ListingIntakeFormProps) {
  const [files, setFiles] = useState<IntakeFileState[]>([]);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const validFiles = useMemo(
    () => files.filter((item) => item.status !== "error"),
    [files],
  );

  /**
   * Add to the selection rather than replace it.
   *
   * A bottle shot and a back label are two trips to the file picker on most
   * phones, and this used to overwrite the whole array on the second one -- the
   * first photo disappeared with no warning and no way back to it except to
   * find the file again. Re-validating the union rather than only the new files
   * keeps the 10-image and 1-PDF caps meaningful across both trips.
   */
  function handleFiles(nextFiles: FileList | null) {
    if (!nextFiles || nextFiles.length === 0) return;
    setFiles((current) => {
      const seen = new Set(current.map((item) => fileIdentity(item.file)));
      const added = Array.from(nextFiles).filter(
        (file) => !seen.has(fileIdentity(file)),
      );
      const parsed = validateFiles([
        ...current.map((item) => item.file),
        ...added,
      ]);
      setMessage(
        parsed.errors[0] ??
          `${parsed.accepted.filter((item) => item.status !== "error").length} 個檔案已準備`,
      );
      return parsed.accepted;
    });
  }

  function removeFile(id: string) {
    setFiles((current) => {
      // Re-validate what is left: dropping an image can bring a file that was
      // over the cap back under it, and leaving it marked as an error would
      // strand a file the operator can now actually use.
      const parsed = validateFiles(
        current.filter((item) => item.id !== id).map((item) => item.file),
      );
      setMessage(
        parsed.errors[0] ??
          `${parsed.accepted.filter((item) => item.status !== "error").length} 個檔案已準備`,
      );
      return parsed.accepted;
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (validFiles.length === 0) {
      setMessage("請先加入至少一個圖片或 PDF 檔案。");
      return;
    }
    setBusy(true);
    setMessage("正在準備上傳…");
    setFiles((current) =>
      current.map((item) =>
        item.status === "ready" ? { ...item, status: "uploading" } : item,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      await onCreate?.({
        files: validFiles.map((item) => item.file),
        note: note.trim(),
      });
      setFiles((current) =>
        current.map((item) =>
          item.status === "uploading" ? { ...item, status: "uploaded" } : item,
        ),
      );
      setMessage("草稿已建立，下一步會進入 AI 處理佇列。");
    } catch (error) {
      setFiles((current) =>
        current.map((item) =>
          item.status === "uploading" ? { ...item, status: "ready" } : item,
        ),
      );
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to create the listing draft.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="intake-form" onSubmit={submit}>
      <div className="upload-dropzone">
        <label htmlFor="listing-files" className="upload-label">
          <span className="upload-title">加入商品資料</span>
          <span className="upload-subtitle">
            上載瓶身圖片或供應商資料 · JPG, PNG, WebP · PDF
          </span>
          <span className="secondary-button upload-button">
            選擇檔案 <span>Select files</span>
          </span>
        </label>
        <input
          id="listing-files"
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          multiple
          onChange={(event) => {
            handleFiles(event.target.files);
            // Clear the input so choosing the SAME file again still fires a
            // change event -- otherwise removing a file and re-picking it does
            // nothing, which reads as the picker being broken.
            event.target.value = "";
          }}
        />
        <p className="upload-limit">
          最多 10 張圖片及 1 份 PDF。成功上傳的檔案不會在重試時重複上傳。
        </p>
      </div>

      {files.length > 0 ? (
        <ul className="file-list" aria-live="polite">
          {files.map((item) => (
            <li className={`file-row file-${item.status}`} key={item.id}>
              <div>
                <strong>{item.file.name}</strong>
                <span>
                  {Math.ceil(item.file.size / 1024)} KB ·{" "}
                  {item.file.type === "application/pdf" ? "PDF" : "圖片"}
                </span>
              </div>
              <span>
                {item.status === "ready"
                  ? "待上傳"
                  : item.status === "uploading"
                    ? "上傳中…"
                    : item.status === "uploaded"
                      ? "已完成"
                      : item.message}
              </span>
              {item.status === "uploading" ? null : (
                <button
                  type="button"
                  className="link-button file-remove"
                  onClick={() => removeFile(item.id)}
                >
                  移除 <span>Remove</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="notes-field">
        <label htmlFor="listing-note">
          <span>補充備註</span>
          <small>Operator notes · Optional</small>
        </label>
        <textarea
          id="listing-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={5000}
          rows={5}
          placeholder="例如：只保留 2024 年份；請以英文與繁體中文輸出。"
        />
        <span className="character-count">{note.length}/5000</span>
      </div>

      <div className="form-actions intake-actions">
        <button
          className="primary-button"
          type="submit"
          disabled={busy || validFiles.length === 0}
        >
          建立上架草稿 <span>Create listing draft</span>
        </button>
      </div>
      <p className="intake-message" role="status" aria-live="polite">
        {message ?? "檔案會先經過驗證，再交由 AI 佇列處理。"}
      </p>
    </form>
  );
}
