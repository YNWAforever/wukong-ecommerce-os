// Only validation of an already fetched record may raise this error. SQL,
// authorization and connection failures must propagate to the route boundary.
export type ListingDataFailureReason =
  | "invalid_active_version"
  | "missing_active_version"
  | "invalid_source_time"
  | "invalid_platform_product"
  | "invalid_activity";

export class ListingDataError extends Error {
  constructor(readonly reason: ListingDataFailureReason) {
    super("listing record cannot be safely read");
    this.name = "ListingDataError";
  }
}
