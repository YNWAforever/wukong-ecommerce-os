import type { StudioReadDeps } from "../tools.js";

/**
 * `listing.get_run_status` execution (plan Task 10).
 *
 * The tool registry allows an operator+ turn to read one listing-pipeline
 * operation's state. It is a read only: the Studio never starts, retries or
 * mutates listing work through a tool, and a missing/unknown run is reported as
 * `unavailable` rather than guessed.
 */

const KNOWN_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
  "unavailable",
] as const;

export type ListingRunStateCopy = (typeof KNOWN_STATES)[number];

/**
 * Map a persisted operation state onto the reviewed tool output enum.
 *
 * `superseded` means a newer operation took over; the reviewed enum has no
 * separate value for it, and `cancelled` is the honest reading (this run will
 * not produce a result). Anything unrecognised becomes `unavailable` — a state
 * this build cannot prove is never reported as success.
 */
export function mapListingRunState(state: string): ListingRunStateCopy {
  if ((KNOWN_STATES as readonly string[]).includes(state))
    return state as ListingRunStateCopy;
  if (state === "superseded") return "cancelled";
  return "unavailable";
}

export async function readListingRunStatus(
  deps: Pick<StudioReadDeps, "getListingRunStatus">,
  input: { listingId: string; runId: string },
): Promise<{
  listingId: string;
  runId: string;
  state: ListingRunStateCopy;
} | null> {
  const run = await deps.getListingRunStatus(input.listingId, input.runId);
  if (!run) return null;
  return {
    listingId: input.listingId,
    runId: input.runId,
    state: mapListingRunState(run.state),
  };
}
