import {
  wineBudgetSnapshotSchema,
  wineEnrichmentPolicySchema,
  wineExecutionSnapshotSchema,
} from "@wukong/core";
import { wineAcquisitionPolicySchema } from "@wukong/jobs";
import {
  listingInputDigest,
  type ListingOperation,
  type WorkspaceRepositories,
  type StageRecord,
  type WineStageResult,
  parseWineStageResult,
  wineStageDependencyDigest,
} from "@wukong/db";
export function savedResult(record: StageRecord): WineStageResult {
  const value = record.output as {
    schemaVersion?: number;
    fresh?: boolean;
    result?: unknown;
  };
  if (
    value?.schemaVersion !== 1 ||
    value.fresh !== true ||
    record.state !== "succeeded"
  )
    throw Error("stage dependency unavailable");
  return parseWineStageResult(value.result, record.stage);
}
export function validDependencies(
  run: ListingOperation,
  dependencies: StageRecord[],
): boolean {
  const prefix: StageRecord[] = [];
  try {
    for (const record of dependencies) {
      if (
        record.runId !== run.id ||
        record.inputDigest !== run.execution.wineInputDigest ||
        record.dependencyDigest !== wineStageDependencyDigest(run, prefix)
      )
        return false;
      if (record.state === "skipped") {
        const verification = prefix.find((x) => x.stage === "verification");
        const result = verification ? savedResult(verification) : null;
        const output = record.output as {
          schemaVersion?: number;
          reason?: string;
        };
        if (
          !["search_deep", "verification_deep"].includes(record.stage) ||
          output?.schemaVersion !== 1 ||
          output.reason !== "deep_search_not_required" ||
          !result ||
          result.state !== "succeeded" ||
          result.stage !== "verification" ||
          result.needsDeepSearch
        )
          return false;
      } else if (savedResult(record).state !== "succeeded") return false;
      prefix.push(record);
    }
    return true;
  } catch {
    return false;
  }
}
/** Only full/research acceptance exists. copy/section fail closed until adopted dependency wiring. */
export async function accepted(
  r: WorkspaceRepositories,
  run: ListingOperation,
): Promise<boolean> {
  try {
    const e = run.execution,
      b = wineBudgetSnapshotSchema.parse(e.wineBudget),
      g = wineExecutionSnapshotSchema.parse(e.wineGo),
      p = wineEnrichmentPolicySchema.parse(e.wineEnrichment),
      a = wineAcquisitionPolicySchema.parse(e.wineAcquisition);
    const input = await r.listingInputs.getRevision(
      run.listingId,
      run.inputRevision,
    );
    const snapshot = e.input as Record<string, unknown>;
    return Boolean(
      e.schemaVersion === 1 &&
      e.flowVersion === "wine-enrichment-v1" &&
      input &&
      snapshot &&
      snapshot.listingId === run.listingId &&
      snapshot.workspaceId === input.workspaceId &&
      snapshot.revision === run.inputRevision &&
      snapshot.inputDigest === input.inputDigest &&
      e.wineInputDigest === input.inputDigest &&
      e.wineSourceDigest === listingInputDigest(input.sources) &&
      listingInputDigest(snapshot.sources) === e.wineSourceDigest &&
      e.wineMode === b.mode &&
      p.enabled &&
      g.rulesVersion === p.rulesVersion &&
      a.rulesVersion === p.rulesVersion &&
      a.policyVersion === p.policyVersion &&
      a.allowedDomains.length > 0 &&
      listingInputDigest([...a.allowedDomains].sort()) ===
        listingInputDigest([...p.allowedDomains].sort()) &&
      Date.parse(a.deadlineAt) > Date.parse(run.acceptedAt) &&
      Date.parse(a.deadlineAt) - Date.parse(run.acceptedAt) <= 900000,
    );
  } catch {
    return false;
  }
}
