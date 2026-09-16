import {
  listingInputDigest,
  type ListingOperation,
  type StageRecord,
} from "@wukong/db";
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
