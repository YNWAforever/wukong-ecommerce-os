type UploadStep = "presign" | "upload" | "finalize";

export type BrowserAssetUploadDependencies = {
  fetcher?: typeof fetch;
  digest?: (file: File) => Promise<string>;
  /**
   * Called the moment the bytes are in object storage, before finalize runs.
   *
   * This is the only point at which the caller can learn that re-sending the
   * file would be wasted work: presign and the PUT have succeeded, so a later
   * failure costs nothing to recover from if the key is kept. Without it, a
   * finalize that fails throws away a completed upload.
   */
  onStored?: (key: string) => void;
};

export type UploadedSourceAsset = {
  assetId: string;
  /** The storage key the bytes live at, so a replay can skip re-sending them. */
  key: string;
};

export type ResumeUpload = {
  /** A key from a previous attempt's `onStored`. Its bytes are already stored. */
  key: string;
};

const UNREACHABLE: Record<UploadStep, string> = {
  presign:
    "Could not reach Wukong to prepare the upload. Check your connection and try again.",
  upload:
    "Could not reach object storage, so the upload never started. This is usually the asset bucket refusing the browser rather than a problem with the file.",
  finalize:
    "Could not reach Wukong to record the uploaded file. Check your connection and try again.",
};

async function responseError(response: Response): Promise<Error> {
  const fallback = `Upload request failed (${response.status})`;
  try {
    const body = (await response.json()) as { message?: string };
    return new Error(body.message || fallback);
  } catch {
    return new Error(fallback);
  }
}

async function send(
  step: UploadStep,
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(input, init);
  } catch (cause) {
    throw new Error(UNREACHABLE[step], { cause });
  }
}

async function sha256(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

/** Presign, then PUT the bytes. Returns the key they were stored under. */
async function storeBytes(
  file: File,
  fetcher: typeof fetch,
  onStored: ((key: string) => void) | undefined,
): Promise<string> {
  const presignResponse = await send(
    "presign",
    fetcher,
    "/api/assets/presign",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type,
        size: file.size,
      }),
    },
  );
  if (!presignResponse.ok) throw await responseError(presignResponse);
  const presign = (await presignResponse.json()) as {
    key: string;
    uploadUrl: string;
  };

  const uploadResponse = await send("upload", fetcher, presign.uploadUrl, {
    method: "PUT",
    headers: { "content-type": file.type },
    body: file,
  });
  if (!uploadResponse.ok) throw await responseError(uploadResponse);

  onStored?.(presign.key);
  return presign.key;
}

/**
 * Uploads one file and records it, resuming from stored bytes when it can.
 *
 * Every attempt used to start at presign, which mints a fresh random key
 * (`asset-store.ts` -> `ws/<workspace>/sources/<uuid>/<name>`). So a retry after
 * a failed finalize re-sent the whole file over a connection that had just
 * proved unreliable, and left the first copy orphaned in the bucket. Passing the
 * key from a previous attempt's `onStored` skips straight to finalize.
 */
export async function uploadSourceAsset(
  file: File,
  dependencies: BrowserAssetUploadDependencies = {},
  resume?: ResumeUpload,
): Promise<UploadedSourceAsset> {
  const fetcher = dependencies.fetcher ?? fetch;
  const digest = dependencies.digest ?? sha256;
  const checksum = await digest(file);

  let key =
    resume?.key ?? (await storeBytes(file, fetcher, dependencies.onStored));

  for (let attempt = 0; ; attempt += 1) {
    const finalizeResponse = await send(
      "finalize",
      fetcher,
      "/api/assets/finalize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          mimeType: file.type,
          size: file.size,
          sha256: checksum,
        }),
      },
    );
    if (finalizeResponse.ok) {
      const finalized = (await finalizeResponse.json()) as { assetId: string };
      return { assetId: finalized.assetId, key };
    }
    // A resumed key whose object is gone is the one failure a retry cannot fix
    // by repeating itself, and finalize is the first place anyone can notice:
    // it HEADs the object. Re-send the bytes once rather than leaving the
    // operator with a retry button that can only ever fail.
    if (finalizeResponse.status !== 404 || attempt > 0) {
      throw await responseError(finalizeResponse);
    }
    key = await storeBytes(file, fetcher, dependencies.onStored);
  }
}
