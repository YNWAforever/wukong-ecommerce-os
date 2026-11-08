"use client";

import {
  MAX_ASSET_SIZE,
  rejectAsset,
  SUPPORTED_ASSET_MIME_TYPES,
} from "@wukong/assets/media-policy";
import { useCallback, useMemo, useRef, useState } from "react";

import { uploadSourceAsset } from "../browser-asset-upload";
import type { StudioCopyKey } from "../studio-copy";

/**
 * Studio composer attachments (B1).
 *
 * The wire contract is the existing intake upload stack, not a new one:
 * `POST /api/assets/presign` accepts `{ fileName, mimeType, size }` for the
 * shared supported MIME/type limits, the bytes are PUT to the returned URL,
 * and `POST /api/assets/finalize` accepts `{ key, mimeType, size, sha256 }` and
 * returns `{ assetId }`. This module wraps that flow for the composer:
 *
 *  - validation reuses `@wukong/assets/media-policy` (the same leaf module the
 *    presign/finalize routes and the intake form use), so what the composer
 *    accepts cannot drift from what the server accepts;
 *  - uploads go through the reviewed `uploadSourceAsset` helper with an
 *    injected fetcher/digest, so tests never touch the network or S3;
 *  - at most eight files are kept, and a file is only presented as uploaded
 *    after finalize returned a real asset id;
 *  - failures map to localized copy keys; raw provider/response text never
 *    reaches the UI;
 *  - each in-flight upload has an `AbortController`, so removing a chip really
 *    stops it instead of leaving a request running.
 */

/** Composer cap; the API's own `attachmentAssetIds.max(8)` mirrors it. */
export const STUDIO_MAX_ATTACHMENTS = 8;

/** `accept` attribute matching the presign/finalize MIME enum exactly. */
export const STUDIO_ATTACHMENT_ACCEPT = SUPPORTED_ASSET_MIME_TYPES.join(",");

export type StudioAttachmentRejection =
  "unsupported_type" | "empty_file" | "too_large";

export const STUDIO_ATTACHMENT_REJECTION_COPY: Record<
  StudioAttachmentRejection,
  StudioCopyKey
> = {
  unsupported_type: "studio.composer.attachment.unsupported",
  empty_file: "studio.composer.attachment.empty",
  too_large: "studio.composer.attachment.tooLarge",
};

/**
 * Why this file cannot be attached, or null.
 *
 * Reuses the shared media policy so the MIME list and the 20 MiB ceiling are
 * the routes' values. The listing-specific image/PDF counts are not applied;
 * the Studio has one total cap instead.
 */
export function rejectStudioAttachment(file: {
  mimeType: string;
  size: number;
}): StudioAttachmentRejection | null {
  const rejection = rejectAsset(
    { mimeType: file.mimeType, size: file.size },
    { imagesBefore: 0, pdfsBefore: 0 },
  );
  if (
    rejection === "unsupported_type" ||
    rejection === "empty_file" ||
    rejection === "too_large"
  )
    return rejection;
  return null;
}

export type StudioAttachmentPlan = {
  /** Files that may be uploaded now, in selection order. */
  accepted: File[];
  /** Files that can never be uploaded as-is; shown with a reason. */
  rejected: Array<{ file: File; code: StudioAttachmentRejection }>;
  /** Valid files dropped because the composer already holds the maximum. */
  limitSkipped: number;
};

/**
 * Split one selection into uploadable, rejected and over-cap files.
 *
 * `existingCount` is the number of attachments that count against the cap
 * (uploading + uploaded); rejected chips are informational and do not consume
 * an upload slot.
 */
export function planStudioAttachments(
  files: readonly File[],
  existingCount: number,
): StudioAttachmentPlan {
  const remaining = Math.max(0, STUDIO_MAX_ATTACHMENTS - existingCount);
  const accepted: File[] = [];
  const rejected: StudioAttachmentPlan["rejected"] = [];
  let limitSkipped = 0;
  let slots = remaining;
  for (const file of files) {
    const rejection = rejectStudioAttachment({
      mimeType: file.type,
      size: file.size,
    });
    if (rejection) {
      rejected.push({ file, code: rejection });
      continue;
    }
    if (slots <= 0) {
      limitSkipped += 1;
      continue;
    }
    slots -= 1;
    accepted.push(file);
  }
  return { accepted, rejected, limitSkipped };
}

export type StudioAttachmentErrorCode =
  StudioAttachmentRejection | "cancelled" | "failed";

/** Typed, content-free failure; only a copy key is exposed to the UI. */
export class StudioAttachmentError extends Error {
  constructor(
    readonly code: StudioAttachmentErrorCode,
    readonly copyKey: StudioCopyKey,
  ) {
    super(code);
    this.name = "StudioAttachmentError";
  }
}

const CANCELLED_COPY: StudioCopyKey = "studio.composer.attachment.cancelled";
const FAILED_COPY: StudioCopyKey = "studio.composer.attachment.failed";

function signalAwareFetcher(
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    return fetcher(input, { ...init, ...(signal ? { signal } : {}) });
  }) as typeof fetch;
}

export type UploadStudioAttachmentDeps = {
  fetcher?: typeof fetch;
  digest?: (file: File) => Promise<string>;
  signal?: AbortSignal;
};

/**
 * Upload one attachment through presign → PUT → finalize.
 *
 * Returns the id only after finalize succeeded; every failure is a
 * `StudioAttachmentError` carrying a copy key (and `cancelled` when the
 * caller aborted).
 */
export async function uploadStudioAttachment(
  file: File,
  deps: UploadStudioAttachmentDeps = {},
): Promise<{ assetId: string }> {
  const rejection = rejectStudioAttachment({
    mimeType: file.type,
    size: file.size,
  });
  if (rejection) {
    throw new StudioAttachmentError(
      rejection,
      STUDIO_ATTACHMENT_REJECTION_COPY[rejection],
    );
  }
  if (deps.signal?.aborted) {
    throw new StudioAttachmentError("cancelled", CANCELLED_COPY);
  }
  try {
    const upload = await uploadSourceAsset(file, {
      fetcher: signalAwareFetcher(deps.fetcher ?? fetch, deps.signal),
      ...(deps.digest ? { digest: deps.digest } : {}),
    });
    return { assetId: upload.assetId };
  } catch {
    if (deps.signal?.aborted) {
      throw new StudioAttachmentError("cancelled", CANCELLED_COPY);
    }
    throw new StudioAttachmentError("failed", FAILED_COPY);
  }
}

export type StudioComposerAttachmentState =
  "uploading" | "uploaded" | "failed" | "cancelled" | StudioAttachmentRejection;

/** One chip as the composer renders it. `assetId` exists only when uploaded. */
export type StudioComposerAttachment = {
  id: string;
  fileName: string;
  state: StudioComposerAttachmentState;
  errorKey: StudioCopyKey | null;
  assetId: string | null;
};

export type StudioAttachmentUploader = typeof uploadStudioAttachment;

export type UseStudioAttachmentsOptions = {
  /** Injected in tests so no network/S3 is touched. */
  upload?: StudioAttachmentUploader;
};

/**
 * Composer attachment state: selection, bounded uploads, remove and retry.
 *
 * The hook is deliberately the only owner of in-flight uploads: removing a
 * chip aborts its request, and `clearAttachments()` (called by the send flow on
 * success) aborts anything still running. A failed send keeps the hook state
 * untouched, so the already-finalized ids stay usable for the retry.
 */
export function useStudioAttachments(
  options: UseStudioAttachmentsOptions = {},
) {
  const upload = options.upload ?? uploadStudioAttachment;
  const [items, setItems] = useState<StudioComposerAttachment[]>([]);
  const [notice, setNotice] = useState<StudioCopyKey | null>(null);
  const itemsRef = useRef<StudioComposerAttachment[]>([]);
  const filesRef = useRef(new Map<string, File>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const nextIdRef = useRef(0);

  const applyItems = useCallback(
    (
      next: (current: StudioComposerAttachment[]) => StudioComposerAttachment[],
    ) => {
      const value = next(itemsRef.current);
      itemsRef.current = value;
      setItems(value);
    },
    [],
  );

  const startUpload = useCallback(
    (id: string, file: File) => {
      const controller = new AbortController();
      controllersRef.current.set(id, controller);
      void upload(file, { signal: controller.signal })
        .then((result) => {
          controllersRef.current.delete(id);
          applyItems((current) =>
            current.map((item) =>
              item.id === id
                ? {
                    ...item,
                    state: "uploaded" as const,
                    assetId: result.assetId,
                    errorKey: null,
                  }
                : item,
            ),
          );
        })
        .catch((error: unknown) => {
          controllersRef.current.delete(id);
          const attachmentError =
            error instanceof StudioAttachmentError ? error : null;
          const state: StudioComposerAttachmentState =
            attachmentError?.code === "cancelled" ? "cancelled" : "failed";
          applyItems((current) =>
            current.map((item) =>
              item.id === id
                ? {
                    ...item,
                    state,
                    errorKey: attachmentError?.copyKey ?? FAILED_COPY,
                  }
                : item,
            ),
          );
        });
    },
    [applyItems, upload],
  );

  const addFiles = useCallback(
    (files: readonly File[]) => {
      const counting = itemsRef.current.filter(
        (item) => item.state === "uploading" || item.state === "uploaded",
      ).length;
      const plan = planStudioAttachments(files, counting);
      if (
        plan.accepted.length === 0 &&
        plan.rejected.length === 0 &&
        plan.limitSkipped === 0
      )
        return;
      const additions: StudioComposerAttachment[] = [];
      for (const file of plan.accepted) {
        const id = `attachment-${nextIdRef.current++}`;
        filesRef.current.set(id, file);
        additions.push({
          id,
          fileName: file.name,
          state: "uploading",
          errorKey: null,
          assetId: null,
        });
      }
      for (const rejected of plan.rejected) {
        const id = `attachment-${nextIdRef.current++}`;
        additions.push({
          id,
          fileName: rejected.file.name,
          state: rejected.code,
          errorKey: STUDIO_ATTACHMENT_REJECTION_COPY[rejected.code],
          assetId: null,
        });
      }
      applyItems((current) => [...current, ...additions]);
      setNotice(
        plan.limitSkipped > 0 ? "studio.composer.attachment.limit" : null,
      );
      for (const addition of additions) {
        const file = filesRef.current.get(addition.id);
        if (file && addition.state === "uploading") {
          startUpload(addition.id, file);
        }
      }
    },
    [applyItems, startUpload],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      controllersRef.current.get(id)?.abort();
      controllersRef.current.delete(id);
      filesRef.current.delete(id);
      applyItems((current) => current.filter((item) => item.id !== id));
      setNotice(null);
    },
    [applyItems],
  );

  const retryAttachment = useCallback(
    (id: string) => {
      const file = filesRef.current.get(id);
      if (!file) return;
      controllersRef.current.get(id)?.abort();
      applyItems((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                state: "uploading" as const,
                errorKey: null,
                assetId: null,
              }
            : item,
        ),
      );
      startUpload(id, file);
    },
    [applyItems, startUpload],
  );

  const clearAttachments = useCallback(() => {
    for (const controller of controllersRef.current.values())
      controller.abort();
    controllersRef.current.clear();
    filesRef.current.clear();
    applyItems(() => []);
    setNotice(null);
  }, [applyItems]);

  const uploadedAssetIds = useMemo(
    () =>
      items.flatMap((item) =>
        item.state === "uploaded" && item.assetId !== null
          ? [item.assetId]
          : [],
      ),
    [items],
  );

  const uploading = useMemo(
    () => items.some((item) => item.state === "uploading"),
    [items],
  );

  return {
    items,
    notice,
    uploadedAssetIds,
    uploading,
    addFiles,
    removeAttachment,
    retryAttachment,
    clearAttachments,
  };
}

export type StudioAttachmentsState = ReturnType<typeof useStudioAttachments>;

/** The largest single upload, re-exported for copy/tests. */
export { MAX_ASSET_SIZE };
