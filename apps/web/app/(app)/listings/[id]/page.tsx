import { ListingReviewClient } from "../../../../components/listing-review-client";

export default async function ListingReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ processing?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const initialProcessing =
    query.processing === "queued" || query.processing === "retry_required"
      ? query.processing
      : undefined;
  return (
    <ListingReviewClient listingId={id} initialProcessing={initialProcessing} />
  );
}
