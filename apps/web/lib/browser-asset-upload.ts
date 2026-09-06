type UploadStep = "presign" | "upload" | "finalize";

export type BrowserAssetUploadDependencies = {
  fetcher?: typeof fetch;
  digest?: (file: File) => Promise<string>;
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

export async function uploadSourceAsset(
  file: File,
  dependencies: BrowserAssetUploadDependencies = {},
): Promise<string> {
  const fetcher = dependencies.fetcher ?? fetch;
  const digest = dependencies.digest ?? sha256;
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

  const finalizeResponse = await send(
    "finalize",
    fetcher,
    "/api/assets/finalize",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: presign.key,
        mimeType: file.type,
        size: file.size,
        sha256: await digest(file),
      }),
    },
  );
  if (!finalizeResponse.ok) throw await responseError(finalizeResponse);
  const finalized = (await finalizeResponse.json()) as { assetId: string };
  return finalized.assetId;
}
