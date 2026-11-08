import { WorkbenchReturnLink } from "../../../../components/workbench-return-link";
import { ListingReviewClient } from "../../../../components/listing-review-client";
import { getDatabase } from "../../../../lib/intake-runtime";
import { authSessionContext } from "../../../../lib/session-context";
import { loadListingStudioHandoff } from "../../../../lib/studio/listing-handoff";

/**
 * `/listings/[id]` ??listing review (B2 adds the optional Studio handoff).
 *
 * The existing query parameters are unchanged. A new optional `studioOutput`
 * UUID is resolved server-side into a read-only copy-proposal banner only when
 * the artifact is a same-workspace proposal for this same listing; every
 * invalid, foreign, mismatched, disabled-Studio or error case yields
 * `undefined` and the page renders exactly as before. The handoff never writes
 * canonical data and is not used to seed the review form.
 */
export default async function ListingReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    processing?: string;
    returnTo?: string;
    studioOutput?: string | string[];
  }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const initialProcessing =
    query.processing === "queued" || query.processing === "retry_required"
      ? query.processing
      : undefined;
  // A repeated parameter is ambiguous, so it is ignored rather than guessed at.
  const studioOutput =
    typeof query.studioOutput === "string" ? query.studioOutput : undefined;
  const studioHandoff = await loadListingStudioHandoff({
    listingId: id,
    studioOutput,
    deps: {
      sessionContext: authSessionContext,
      getDatabase,
    },
  });
  return (
    <>
      {typeof query.returnTo === "string" ? (
        <WorkbenchReturnLink returnTo={query.returnTo} />
      ) : null}
      <ListingReviewClient
        listingId={id}
        initialProcessing={initialProcessing}
        {...(studioHandoff ? { studioHandoff } : {})}
      />
    </>
  );
}
