"use client";

import { useRouter } from "next/navigation";

import {
  ListingIntakeForm,
  type ListingIntakePayload,
} from "./listing-intake-form";

type IntakeDependencies = {
  fetcher?: typeof fetch;
  digest?: (file: File) => Promise<string>;
};

export type CreateListingDraftResult = {
  listingId: string;
  processing: "queued" | "retry_required";
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

type IntakeStep = "presign" | "upload" | "finalize" | "listing";

// fetch() rejects with a bare TypeError ("Failed to fetch") whenever a request
// never completes: offline, DNS failure, or a cross-origin preflight the
// browser refused. That message reached the operator verbatim, naming neither
// the step nor the host, which made a missing asset-bucket CORS policy
// indistinguishable from the application being down.
const UNREACHABLE: Record<IntakeStep, string> = {
  presign:
    "Could not reach Wukong to prepare the upload. Check your connection and try again.",
  upload:
    "Could not reach object storage, so the upload never started. This is usually the asset bucket refusing the browser rather than a problem with the file.",
  finalize:
    "Could not reach Wukong to record the uploaded file. Check your connection and try again.",
  listing:
    "Could not reach Wukong to create the draft. Check your connection and try again.",
};

async function send(
  step: IntakeStep,
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(input, init);
  } catch (cause) {
    // Keep the original TypeError reachable in DevTools; only the operator
    // facing message changes.
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

export async function createListingDraft(
  payload: ListingIntakePayload,
  dependencies: IntakeDependencies = {},
): Promise<CreateListingDraftResult> {
  const fetcher = dependencies.fetcher ?? fetch;
  const digest = dependencies.digest ?? sha256;
  const sourceAssetIds: string[] = [];

  for (const file of payload.files) {
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
    sourceAssetIds.push(finalized.assetId);
  }

  const listingResponse = await send("listing", fetcher, "/api/listings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceAssetIds, note: payload.note }),
  });
  if (!listingResponse.ok) throw await responseError(listingResponse);
  const result = (await listingResponse.json()) as {
    listing: { id: string };
    processing: { state: "queued" | "retry_required" };
  };
  return {
    listingId: result.listing.id,
    processing: result.processing.state,
  };
}

export function ListingIntakeClient() {
  const router = useRouter();
  return (
    <ListingIntakeForm
      onCreate={async (payload) => {
        const result = await createListingDraft(payload);
        router.push(
          `/listings/${encodeURIComponent(result.listingId)}?processing=${result.processing}`,
        );
        router.refresh();
      }}
    />
  );
}
