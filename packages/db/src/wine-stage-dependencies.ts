import { listingInputDigest } from "./repositories/listing-inputs.js";
import type { ListingOperation } from "./repositories/listing-operations.js";
import type { StageRecord } from "./repositories/wine-enrichment.js";
/** Canonical persisted checkpoint contract. Keep all stage producers/readers on this exact hash. */
export function wineStageDependencyDigest(
  run: ListingOperation,
  dependencies: StageRecord[],
) {
  return listingInputDigest({
    runId: run.id,
    inputDigest: run.execution.wineInputDigest,
    sourceDigest: run.execution.wineSourceDigest,
    mode: run.execution.wineMode,
    budget: run.execution.wineBudget,
    go: run.execution.wineGo,
    policy: run.execution.wineEnrichment,
    dependencies,
  });
}
