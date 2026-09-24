import { randomUUID } from "node:crypto";
import type { Database } from "@wukong/db";
import { z } from "zod";
import { acceptListingOperation } from "./listing-operation-service";
import { ApiError } from "./route-support";

export const batchControlSchema = z
  .object({
    action: z.enum(["pause", "resume", "cancel", "retry_selected"]),
    expectedControlRevision: z.number().int().min(0),
    idempotencyKey: z.uuid(),
    itemIds: z.array(z.uuid()).min(1).max(5).optional(),
  })
  .strict()
  .refine((x) =>
    x.action === "retry_selected"
      ? Boolean(x.itemIds && new Set(x.itemIds).size === x.itemIds.length)
      : x.itemIds === undefined,
  );
export const batchAdvanceSchema = z
  .object({
    expectedControlRevision: z.number().int().min(0),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type BatchControlInput = z.infer<typeof batchControlSchema> & {
  workspaceId: string;
  actorId: string;
  batchId: string;
};
export function batchControlError(error: unknown): never {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    const code = error.code;
    if (
      [
        "batch_not_found",
        "batch_revision_conflict",
        "idempotency_conflict",
        "invalid_retry_selection",
      ].includes(code)
    )
      throw new ApiError(
        code === "batch_not_found" ? 404 : 409,
        code,
        "The batch changed or this selection cannot be retried. Refresh and review the current items.",
      );
  }
  throw error;
}
export function createBatchControlService(getDatabase: () => Database) {
  return async (input: BatchControlInput): Promise<Record<string, unknown>> => {
    batchControlSchema.parse({
      action: input.action,
      expectedControlRevision: input.expectedControlRevision,
      idempotencyKey: input.idempotencyKey,
      ...(input.itemIds ? { itemIds: input.itemIds } : {}),
    });
    return getDatabase()
      .forWorkspace(input.workspaceId, async (r) => {
        const digest = JSON.stringify({
          action: input.action,
          itemIds: [...(input.itemIds ?? [])].sort(),
        });
        const command = await r.enrichmentBatches.beginCommand({
          ...input,
          digest,
        });
        if (command.replay) return command.replay;
        const batch = await r.enrichmentBatches.getById(input.batchId);
        if (!batch)
          throw new ApiError(404, "batch_not_found", "No such batch.");
        await r.enrichmentBatches.reconcileBoundRuns(input.batchId);
        let status = batch.status;
        const runIds: string[] = [];
        if (input.action === "pause") {
          if (
            !["open", "running", "budget_exhausted", "paused"].includes(status)
          )
            throw new ApiError(
              409,
              "batch_terminal",
              "A terminal batch cannot be paused.",
            );
          status = "paused";
        } else if (input.action === "resume") {
          if (status !== "paused")
            throw new ApiError(
              409,
              "batch_not_paused",
              "Only a paused batch can resume.",
            );
          status = "open";
        } else if (input.action === "cancel") {
          await r.enrichmentBatches.cancelBoundItems(input.batchId);
          status = "cancelled";
        } else {
          if (status === "paused")
            throw new ApiError(
              409,
              "batch_paused",
              "Resume the batch before admitting a retry.",
            );
          const retries = await r.enrichmentBatches.allocateRetries(
            input.batchId,
            input.itemIds!,
          );
          for (const retry of retries) {
            const listing = await r.listings.requireById(retry.listingId);
            const snapshot = await r.listingInputs.getCurrent(retry.listingId);
            if (!snapshot)
              throw new ApiError(
                409,
                "input_missing",
                "Save the product input before retrying.",
              );
            const accepted = await acceptListingOperation(r, {
              workspaceId: input.workspaceId,
              listingId: retry.listingId,
              actorId: input.actorId,
              expectedInputRevision: snapshot.revision,
              baseVersionId: listing.activeVersionId,
              operationKey: randomUUID(),
              retryOfRunId: retry.retryOfRunId,
            });
            if (
              !(await r.enrichmentBatches.bindRun({
                batchId: input.batchId,
                listingId: retry.listingId,
                pipelineRunId: accepted.run.id,
                inputRevision: accepted.run.inputRevision,
              }))
            )
              throw new ApiError(
                409,
                "batch_budget_exhausted",
                "The retry would exceed the approved batch budget; prior holds remain accounted for.",
              );
            runIds.push(accepted.run.id);
          }
          status = "running";
        }
        await r.enrichmentBatches.setStatus(input.batchId, status);
        const result = {
          batchId: input.batchId,
          status,
          controlRevision: command.revision,
          acceptedRunIds: runIds,
          accepted: runIds.length,
        };
        await r.enrichmentBatches.finishCommand({
          batchId: input.batchId,
          idempotencyKey: input.idempotencyKey,
          digest,
          result,
        });
        await r.audit.write({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          entityId: input.batchId,
          action: `enrichment_batch.${input.action}`,
          metadata: {
            controlRevision: command.revision,
            acceptedRunIds: runIds,
            itemIds: input.itemIds ?? [],
          },
        });
        return result;
      })
      .catch(batchControlError);
  };
}
