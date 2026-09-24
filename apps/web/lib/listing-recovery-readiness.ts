import { ApiError } from "./route-support";
/** Production Database always implements this; narrow injected test ports may omit it. */
export async function requireListingRecovery(database: object) {
  const inspect = (
    database as {
      inspectListingRecoveryCompatibility?: () => Promise<{ ready: boolean }>;
    }
  ).inspectListingRecoveryCompatibility;
  if (!inspect) return;
  let ready = false;
  try {
    ready = (await inspect.call(database)).ready;
  } catch {
    /* Do not expose SQL or connection details. */
  }
  if (!ready)
    throw new ApiError(
      503,
      "listing_recovery_setup_required",
      "Listing recovery setup is required. Ask an administrator to apply the approved database migrations.",
    );
}
