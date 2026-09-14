"use client";

import { useRouter } from "next/navigation";

import {
  ListingIntakeForm,
  type ListingIntakePayload,
  type ListingIntakeProgress,
  type ListingIntakeUpload,
} from "./listing-intake-form";
import { uploadSourceAsset } from "../lib/browser-asset-upload";

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

/**
 * Uploads whatever is not uploaded yet, then creates the draft from the lot.
 *
 * The loop used to collect asset ids into a local array and throw on the first
 * failure, so a second photo failing discarded the first photo's completed
 * upload -- the array went out of scope, the form reset every row to "ready",
 * and the retry re-sent every byte over the connection that had just failed.
 * Progress is now reported to the caller as each file lands, so a retry starts
 * from where the last attempt stopped and the earlier uploads are reused rather
 * than orphaned in the bucket.
 */
export async function createListingDraft(
  payload: ListingIntakePayload,
  dependencies: IntakeDependencies = {},
  report?: ListingIntakeProgress,
): Promise<CreateListingDraftResult> {
  const fetcher = dependencies.fetcher ?? fetch;
  const sourceAssetIds: string[] = [];

  for (const entry of payload.files) {
    if (entry.assetId) {
      // Already finalized by an earlier attempt. Re-finalizing is safe but
      // pointless; re-uploading is neither.
      sourceAssetIds.push(entry.assetId);
      continue;
    }
    const uploaded = await uploadSourceAsset(
      entry.file,
      {
        ...dependencies,
        fetcher,
        onStored: (key) => report?.(entry.id, { storedKey: key }),
      },
      entry.storedKey ? { key: entry.storedKey } : undefined,
    );
    report?.(entry.id, { assetId: uploaded.assetId, storedKey: uploaded.key });
    sourceAssetIds.push(uploaded.assetId);
  }

  let listingResponse: Response;
  try {
    listingResponse = await fetcher("/api/listings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceAssetIds, note: payload.note }),
    });
  } catch (cause) {
    throw new Error(
      "Could not reach Wukong to create the draft. Check your connection and try again.",
      { cause },
    );
  }
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

export type { ListingIntakeUpload };

export function ListingIntakeClient() {
  const router = useRouter();
  return (
    <ListingIntakeForm
      onCreate={async (payload, report) => {
        const result = await createListingDraft(payload, {}, report);
        router.push(
          `/listings/${encodeURIComponent(result.listingId)}?processing=${result.processing}`,
        );
        router.refresh();
      }}
    />
  );
}
