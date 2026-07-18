import { ListingReviewClient } from "../../../../components/listing-review-client";

export default async function ListingReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ListingReviewClient listingId={id} />;
}
