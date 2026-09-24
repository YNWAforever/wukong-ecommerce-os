import {
  resolveWineGenerationOwnership,
  type WineGenerationOwnership,
} from "@wukong/db";
export type { WineGenerationOwnership } from "@wukong/db";
import {
  listingInputDigest,
  type Database,
  type WorkspaceRepositories,
} from "@wukong/db";
import {
  workingListingSchema,
  workingFieldStateSchema,
  workingFields,
  hasWineSectionMapping,
} from "@wukong/core";
import type { WineStageContext } from "./wine-enrichment-pipeline.js";
class OwnershipError extends Error {}
function requireOwnership(value: unknown, code: string): asserts value {
  if (!value) throw new OwnershipError(code);
}
const same = (a: unknown, b: unknown) =>
  listingInputDigest(a) === listingInputDigest(b);
/** Server-only accepted input/base reader. This read does not authorize a provider call or validate semantic stage dependencies. */
export async function readWineGenerationOwnership(
  database: Pick<Database, "forWorkspace">,
  raw: WineStageContext,
): Promise<WineGenerationOwnership> {
  try {
    return await database.forWorkspace(raw.job.workspaceId, (r) =>
      readWineGenerationOwnershipFromRepositories(r, raw),
    );
  } catch {
    return { status: "unavailable", code: "ownership_unavailable" };
  }
}
/** Same authoritative checks, within the caller's existing transaction; never opens another transaction. */
export async function readWineGenerationOwnershipFromRepositories(
  r: WorkspaceRepositories,
  raw: WineStageContext,
): Promise<WineGenerationOwnership> {
  const c = structuredClone(raw);
  try {
    await r.pipelineRuns.lockOperation(c.job.runId);
    const run = await r.pipelineRuns.getOperation(c.job.runId);
    requireOwnership(
      run &&
        c.schemaVersion === 1 &&
        run.id === c.run.id &&
        run.listingId === c.job.draftId &&
        run.inputRevision === c.job.inputRevision &&
        run.activeVersionSequence === c.job.activeVersionSequence &&
        run.baseVersionId === c.run.baseVersionId &&
        same(run.execution, c.run.execution) &&
        same({ ...run, executionState: c.run.executionState }, c.run) &&
        run.execution.flowVersion === "wine-enrichment-v1" &&
        c.job.flowVersion === "wine-enrichment-v1",
      "ownership_binding_invalid",
    );
    const listing = await r.listings.getById(run.listingId),
      current = await r.pipelineRuns.getCurrentOperation(run.listingId);
    requireOwnership(
      listing &&
        ["queued", "running"].includes(run.executionState) &&
        current?.id === run.id &&
        listing.inputRevision === run.inputRevision &&
        listing.activeVersionId === run.baseVersionId,
      "ownership_operation_stale",
    );
    const input = await r.listingInputs.getRevision(
        run.listingId,
        run.inputRevision,
      ),
      snapshot = run.execution.input as Record<string, unknown>;
    requireOwnership(
      input &&
        input.workspaceId === c.job.workspaceId &&
        input.listingId === run.listingId &&
        snapshot &&
        snapshot.inputDigest === input.inputDigest &&
        snapshot.revision === input.revision &&
        snapshot.workspaceId === input.workspaceId &&
        snapshot.listingId === input.listingId &&
        input.inputDigest === run.execution.wineInputDigest &&
        listingInputDigest(input.sources) === run.execution.wineSourceDigest,
      "ownership_input_invalid",
    );
    for (const key of [
      "workingContent",
      "fieldStates",
      "sources",
      "note",
    ] as const)
      requireOwnership(
        same(input[key], snapshot[key]),
        "ownership_input_invalid",
      );
    requireOwnership(
      input.inputDigest ===
        listingInputDigest({
          note: input.note,
          sources: input.sources,
          workingContent: input.workingContent,
          fieldStates: input.fieldStates,
        }),
      "ownership_input_invalid",
    );
    const parsed = workingListingSchema.parse(input.workingContent);
    for (const [key, value] of Object.entries(input.fieldStates)) {
      requireOwnership(
        workingFields.includes(key as (typeof workingFields)[number]),
        "ownership_states_invalid",
      );
      workingFieldStateSchema.parse(value);
    }
    const review = run.baseVersionId
      ? await r.listings.getReviewSnapshot(run.listingId)
      : null;
    requireOwnership(
      !run.baseVersionId || review?.activeVersion?.id === run.baseVersionId,
      "ownership_base_missing",
    );
    const base = review?.activeVersion?.content;
    if (parsed.wineOwnership)
      requireOwnership(
        hasWineSectionMapping(parsed),
        "ownership_mapping_invalid",
      );
    if (base?.wineOwnership)
      requireOwnership(
        hasWineSectionMapping(base),
        "ownership_mapping_invalid",
      );
    const now = Date.parse(await r.pipelineRuns.acceptanceTimestamp()),
      deadline = Date.parse(
        (run.execution.wineAcquisition as { deadlineAt: string }).deadlineAt,
      );
    requireOwnership(
      Number.isFinite(deadline) &&
        now >= Date.parse(run.acceptedAt) &&
        now < deadline &&
        deadline - Date.parse(run.acceptedAt) <= 900000,
      "ownership_deadline",
    );
    const binding = {
      workspaceId: c.job.workspaceId,
      operationId: run.id,
      listingId: run.listingId,
      inputRevision: run.inputRevision,
      baseVersionId: run.baseVersionId,
    };
    return resolveWineGenerationOwnership(input, parsed, base, binding);
  } catch (error) {
    if (error instanceof OwnershipError)
      return { status: "unavailable", code: error.message };
    return { status: "unavailable", code: "ownership_unavailable" };
  }
}
