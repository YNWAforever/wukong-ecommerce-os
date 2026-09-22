import {
  wineCopySnapshotSchema,
  wineEnrichmentPolicySchema,
  wineExecutionSnapshotSchema,
} from "@wukong/core";
import type { WorkspaceRepositories } from "./client.js";
import type { ListingOperation } from "./repositories/listing-operations.js";
import type { WineGenerationOwnership } from "./wine-generation-ownership.js";
import { readAdoptedWineDependencies } from "./wine-adopted-dependencies.js";
import {
  buildWineCopySnapshot,
  wineCopyDependencyDigest,
  WineCopyDependencyError,
} from "./wine-copy-snapshot.js";
/** Caller owns current run fence; retains listing/workspace authority locks through COMMIT. */
export async function readWineCopyDependencies(
  r: WorkspaceRepositories,
  run: ListingOperation,
  ownership: WineGenerationOwnership,
) {
  try {
    const accepted = wineCopySnapshotSchema.parse(run.execution.wineCopy);
    if (
      ownership.status !== "available" ||
      accepted.mode !== run.execution.wineMode ||
      accepted.baseVersionId !== run.baseVersionId ||
      accepted.listingId !== run.listingId ||
      accepted.workspaceId !== ownership.binding.workspaceId ||
      accepted.inputRevision !== run.inputRevision ||
      accepted.dependencyDigest !== wineCopyDependencyDigest(accepted)
    )
      throw new WineCopyDependencyError();
    const input = await r.listingInputs.getRevision(
      run.listingId,
      run.inputRevision,
    );
    if (!input) throw new WineCopyDependencyError();
    const adopted = await readAdoptedWineDependencies(r, {
      workspaceId: accepted.workspaceId,
      listingId: run.listingId,
      versionId: accepted.baseVersionId,
      inputRevision: run.inputRevision,
    });
    const rebuilt = buildWineCopySnapshot({
      adopted,
      input,
      ownership,
      mode: accepted.mode,
      section: accepted.section,
      policy: wineEnrichmentPolicySchema.parse(run.execution.wineEnrichment),
      model: wineExecutionSnapshotSchema.parse(run.execution.wineGo),
    });
    if (
      rebuilt.snapshot.dependencyDigest !== accepted.dependencyDigest ||
      adopted.status !== "available"
    )
      throw new WineCopyDependencyError();
    return {
      ...rebuilt,
      input,
      identity: adopted.origins[0]!.frozenVerification.identity,
    };
  } catch {
    throw new WineCopyDependencyError();
  }
}
