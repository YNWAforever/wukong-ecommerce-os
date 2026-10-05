import { ListingDataError, type ListingDataFailureReason } from "@wukong/db";
import {
  atRouteStage,
  type DiagnosticStage,
  type RouteDiagnostics,
} from "./route-support";

export type ListingReadFailure = {
  reason: ListingDataFailureReason | "preview_unavailable";
  requestId: string;
};
export type ListingReadResult<T> =
  | { state: "ready"; value: T }
  | { state: "unavailable"; failure: ListingReadFailure };

export function recordListingReadFailure(
  diagnostics: RouteDiagnostics,
  stage: DiagnosticStage,
  reason: ListingReadFailure["reason"],
): ListingReadFailure {
  console.error(
    JSON.stringify({
      event: "listing_read_unavailable",
      requestId: diagnostics.requestId,
      stage,
      code: reason === "preview_unavailable" ? reason : "invalid_record",
      reason,
    }),
  );
  return { reason, requestId: diagnostics.requestId };
}

export function readIsolatedListing<T>(
  diagnostics: RouteDiagnostics,
  stage: DiagnosticStage,
  work: () => Promise<T>,
): Promise<ListingReadResult<T>> {
  return atRouteStage(stage, async () => {
    try {
      return { state: "ready" as const, value: await work() };
    } catch (error) {
      if (!(error instanceof ListingDataError)) throw error;
      return {
        state: "unavailable" as const,
        failure: recordListingReadFailure(diagnostics, stage, error.reason),
      };
    }
  });
}
