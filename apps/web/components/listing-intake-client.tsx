"use client";

import { useRouter } from "next/navigation";

import {
  ListingIntakeForm,
  type ListingIntakePayload,
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

export async function createListingDraft(
  payload: ListingIntakePayload,
  dependencies: IntakeDependencies = {},
): Promise<CreateListingDraftResult> {
  const fetcher = dependencies.fetcher ?? fetch;
  const sourceAssetIds: string[] = [];

  for (const file of payload.files) {
    sourceAssetIds.push(
      await uploadSourceAsset(file, { ...dependencies, fetcher }),
    );
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
