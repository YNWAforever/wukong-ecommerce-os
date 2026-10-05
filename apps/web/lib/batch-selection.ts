import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  contentFieldSelectionSchema,
  paidListingReservation,
  type ContentField,
} from "@wukong/core";
import {
  listingInputDigest,
  type Database,
  type MaintenanceContent,
  type MaintenanceContentFence,
  type WorkspaceRepositories,
} from "@wukong/db";
import { ApiError } from "./route-support";
import { MAX_ENRICHMENT_WAVE_SIZE } from "./enrichment-wave-limit";
import { computeCurrentContentGaps } from "./current-content-gaps";

export const batchSelectionSchema = z.strictObject({
  mode: z.literal("explicit"),
  listingIds: z
    .array(z.uuid())
    .min(1)
    .max(5000)
    .refine(
      (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
      "Duplicate listing identity",
    ),
  fields: contentFieldSelectionSchema,
});
export type BatchSelection = z.infer<typeof batchSelectionSchema>;
export const batchPreviewInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(200),
  budgetUsd: z.number().positive().max(10000),
  waveSize: z.number().int().min(1).max(MAX_ENRICHMENT_WAVE_SIZE),
  selection: batchSelectionSchema,
});
export const batchCreateInputSchema = z.strictObject({
  previewId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.uuid(),
});
export const cohortPreviewInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(200),
  budgetUsd: z.number().positive().max(10000),
  waveSize: z.number().int().min(1).max(MAX_ENRICHMENT_WAVE_SIZE),
  gap: z.enum([
    "untranslatedName",
    "untranslatedSeoTitle",
    "seoTitleMirrorsName",
    "seoDescriptionMirrorsSeoTitle",
    "keywordsMirrorName",
    "summaryMissing",
  ]),
  fields: contentFieldSelectionSchema,
  continuation: z.uuid().optional(),
});
export const previewRequestSchema = z.union([
  batchPreviewInputSchema,
  cohortPreviewInputSchema,
]);
type PreviewInput = z.infer<typeof batchPreviewInputSchema> & {
  workspaceId: string;
  actorId: string;
};
type CreateInput = z.infer<typeof batchCreateInputSchema> & {
  workspaceId: string;
  actorId: string;
};
type Options = {
  label: string;
  budgetUsd: number;
  waveSize: number;
  selection: BatchSelection;
  eligibleIds: string[];
  fences: Record<string, MaintenanceContentFence>;
  statuses: Record<string, string>;
};
const runnable = new Set(["received", "needs_info", "failed"]);
const optionsSchema = batchPreviewInputSchema.extend({
  eligibleIds: z.array(z.uuid()),
  fences: z.record(z.string(), z.unknown()),
  statuses: z.record(z.string(), z.string()),
});
export type BatchPreviewResult = {
  previewId: string;
  digest: string;
  expiresAt: string;
  selectedCount: number;
  eligibleCount: number;
  skippedByReason: Record<string, number>;
  fields: ContentField[];
  budgetUsd: number;
  waveSize: number;
  maxCostUsd: number | null;
  scope?: {
    scannedCount: number;
    totalMatching: number;
    truncated: boolean;
    continuation: string | null;
  };
};

async function hydrate(
  repos: WorkspaceRepositories,
  ids: string[],
): Promise<MaintenanceContent[]> {
  const rows: MaintenanceContent[] = [];
  for (let offset = 0; offset < ids.length; offset += 100)
    rows.push(
      ...(await repos.platformProducts.getMaintenanceByIds(
        ids.slice(offset, offset + 100),
      )),
    );
  if (
    rows.length !== ids.length ||
    rows.some((row) => !ids.includes(row.listingId))
  )
    throw new ApiError(
      403,
      "selection_not_authorized",
      "One or more selected products are unavailable in this workspace.",
    );
  return rows;
}

export function createBatchSelectionService(deps: {
  getDatabase(): Database;
  now?: () => Date;
  provider?: string;
}) {
  const now = deps.now ?? (() => new Date());
  async function preview(
    input: PreviewInput,
    observed?: Record<
      string,
      { fence: MaintenanceContentFence; status: string }
    >,
  ): Promise<BatchPreviewResult> {
    const parsed = batchPreviewInputSchema.parse({
      label: input.label,
      budgetUsd: input.budgetUsd,
      waveSize: input.waveSize,
      selection: input.selection,
    });
    const selection = {
      ...parsed.selection,
      listingIds: parsed.selection.listingIds
        .map((id) => id.toLowerCase())
        .sort(),
      fields: [...parsed.selection.fields].sort(),
    };
    return deps.getDatabase().forWorkspace(input.workspaceId, async (repos) => {
      const rows = await hydrate(repos, selection.listingIds);
      if (
        observed &&
        rows.some(
          (row) =>
            !observed[row.listingId] ||
            listingInputDigest(row.fence) !==
              listingInputDigest(observed[row.listingId]!.fence) ||
            row.status !== observed[row.listingId]!.status,
        )
      )
        throw new ApiError(
          409,
          "batch_content_stale",
          "Current products changed during the gap scan. Preview the complete selection again.",
        );
      const skippedByReason: Record<string, number> = {};
      const eligibleIds: string[] = [];
      for (const row of rows) {
        const assessment = computeCurrentContentGaps({
          content: row.content,
          assessmentState: row.assessmentState,
        });
        const reason = !runnable.has(row.status)
          ? "requires_legal_reopen"
          : assessment.assessmentState !== "assessed"
            ? `${assessment.assessmentState}_current_content`
            : row.fence.inputRevision === 0
              ? "save_current_inputs"
              : row.content?.packQuantity === null
                ? "confirm_pack_quantity"
                : null;
        if (reason)
          skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
        else eligibleIds.push(row.listingId);
      }
      const options: Options = {
        ...parsed,
        selection,
        eligibleIds: eligibleIds.sort(),
        fences: Object.fromEntries(
          rows.map((row) => [row.listingId, structuredClone(row.fence)]),
        ),
        statuses: Object.fromEntries(
          rows.map((row) => [row.listingId, row.status]),
        ),
      };
      const id = randomUUID();
      const expiresAt = new Date(now().getTime() + 10 * 60_000).toISOString();
      const digest = listingInputDigest({
        id,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        expiresAt,
        options,
      });
      let maxCostUsd: number | null = null;
      const provider = deps.provider ?? process.env.AI_PROVIDER ?? "openai";
      if (provider === "fake") maxCostUsd = 0;
      else {
        const policy = (await repos.workspaces.requireProfile()).listingAi;
        if (policy?.provider === provider) {
          try {
            maxCostUsd =
              Number(paidListingReservation(policy)) * eligibleIds.length;
          } catch {
            /* No reviewed bound: explicitly unknown. */
          }
        }
      }
      await repos.enrichmentBatches.insertPreview({
        id,
        actorId: input.actorId,
        digest,
        expiresAt,
        options: options as unknown as Record<string, unknown>,
      });
      await repos.audit.write({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        entityId: id,
        action: "enrichment_batch.previewed",
        metadata: {
          selected: selection.listingIds.length,
          eligible: eligibleIds.length,
          fields: selection.fields,
          digest,
          expiresAt,
          maxCostUsd,
        },
      });
      return {
        previewId: id,
        digest,
        expiresAt,
        selectedCount: selection.listingIds.length,
        eligibleCount: eligibleIds.length,
        skippedByReason,
        fields: selection.fields,
        budgetUsd: options.budgetUsd,
        waveSize: options.waveSize,
        maxCostUsd,
      };
    });
  }
  async function create(input: CreateInput) {
    const parsed = batchCreateInputSchema.parse({
      previewId: input.previewId,
      digest: input.digest,
      idempotencyKey: input.idempotencyKey,
    });
    return deps.getDatabase().forWorkspace(input.workspaceId, async (repos) => {
      const stored = await repos.enrichmentBatches.lockPreview(
        parsed.previewId,
        parsed.idempotencyKey,
      );
      if (!stored || stored.actorId !== input.actorId)
        throw new ApiError(
          404,
          "preview_not_found",
          "Preview not found. Preview your selection again.",
        );
      if (stored.digest !== parsed.digest)
        throw new ApiError(
          409,
          "preview_digest_conflict",
          "Preview changed. Preview your selection again.",
        );
      const requestDigest = listingInputDigest({
        previewId: parsed.previewId,
        digest: parsed.digest,
        actorId: input.actorId,
      });
      const replay = await repos.enrichmentBatches.findPreviewCreate(
        parsed.idempotencyKey,
      );
      if (replay) {
        if (replay.digest !== requestDigest)
          throw new ApiError(
            409,
            "idempotency_conflict",
            "The create key has different inputs.",
          );
        return replay.response;
      }
      if (await repos.enrichmentBatches.previewHasCreate(parsed.previewId))
        throw new ApiError(
          409,
          "preview_already_used",
          "This preview already created a batch. Open the existing batch.",
        );
      if (new Date(stored.expiresAt).getTime() <= now().getTime())
        throw new ApiError(
          409,
          "preview_expired",
          "Preview expired. Preview your selection again.",
        );
      const options = optionsSchema.parse(stored.options) as unknown as Options;
      if (
        listingInputDigest({
          id: stored.id,
          workspaceId: input.workspaceId,
          actorId: stored.actorId,
          expiresAt: stored.expiresAt,
          options,
        }) !== stored.digest
      )
        throw new ApiError(
          409,
          "preview_digest_conflict",
          "Stored preview changed. Preview your selection again.",
        );
      for (
        let offset = 0;
        offset < options.selection.listingIds.length;
        offset += 100
      )
        await repos.platformProducts.lockMaintenanceListings(
          options.selection.listingIds.slice(offset, offset + 100),
        );
      for (
        let offset = 0;
        offset < options.selection.listingIds.length;
        offset += 100
      )
        await repos.platformProducts.lockMaintenanceBindings(
          options.selection.listingIds.slice(offset, offset + 100),
        );
      const rows = await hydrate(repos, options.selection.listingIds);
      if (
        rows.some(
          (row) =>
            listingInputDigest(row.fence) !==
              listingInputDigest(options.fences[row.listingId]) ||
            row.status !== options.statuses[row.listingId],
        )
      )
        throw new ApiError(
          409,
          "batch_content_stale",
          "Selected content or source changed. Preview the complete selection again.",
        );
      if (!options.eligibleIds.length)
        throw new ApiError(
          422,
          "empty_cohort",
          "No selected products are eligible.",
        );
      const batch = await repos.enrichmentBatches.create({
        label: options.label,
        budgetUsd: options.budgetUsd,
        waveSize: options.waveSize,
        createdBy: input.actorId,
        listingIds: options.eligibleIds,
        fields: options.selection.fields,
        contentFences: options.fences,
      });
      const result = {
        batchId: batch.id,
        selected: options.eligibleIds.length,
        budgetUsd: options.budgetUsd,
        waveSize: options.waveSize,
      };
      await repos.enrichmentBatches.recordPreviewCreate(
        parsed.idempotencyKey,
        requestDigest,
        result,
        parsed.previewId,
      );
      await repos.audit.write({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        entityId: batch.id,
        action: "enrichment_batch.created",
        metadata: {
          previewId: parsed.previewId,
          digest: parsed.digest,
          selected: result.selected,
          fields: options.selection.fields,
          budgetUsd: options.budgetUsd,
          waveSize: options.waveSize,
        },
      });
      return result;
    });
  }
  async function previewCohort(
    input: z.infer<typeof cohortPreviewInputSchema> & {
      workspaceId: string;
      actorId: string;
    },
  ): Promise<BatchPreviewResult> {
    const parsed = cohortPreviewInputSchema.parse({
      label: input.label,
      budgetUsd: input.budgetUsd,
      waveSize: input.waveSize,
      gap: input.gap,
      fields: input.fields,
      ...(input.continuation ? { continuation: input.continuation } : {}),
    });
    const observed = await deps
      .getDatabase()
      .forWorkspace(input.workspaceId, async (repos) => {
        const ids: string[] = [];
        const fences: Record<
          string,
          { fence: MaintenanceContentFence; status: string }
        > = {};
        let afterId = parsed.continuation;
        let scannedCount = 0;
        let totalMatching = 0;
        for (;;) {
          const page = await repos.platformProducts.scanMaintenancePage(
            afterId,
            100,
          );
          if (!page.length) break;
          scannedCount += page.length;
          for (const row of page) {
            const assessment = computeCurrentContentGaps({
              content: row.content,
              assessmentState: row.assessmentState,
            });
            if (runnable.has(row.status) && assessment.gaps?.[parsed.gap]) {
              totalMatching += 1;
              if (ids.length < 5000) {
                ids.push(row.listingId);
                fences[row.listingId] = {
                  fence: structuredClone(row.fence),
                  status: row.status,
                };
              }
            }
          }
          afterId = page.at(-1)!.listingId;
        }
        return {
          ids,
          fences,
          scope: {
            scannedCount,
            totalMatching,
            truncated: totalMatching > ids.length,
            continuation: totalMatching > ids.length ? ids.at(-1)! : null,
          },
        };
      });
    if (!observed.ids.length)
      throw new ApiError(
        422,
        "empty_cohort",
        "No current products match that gap.",
      );
    const result = await preview(
      {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        label: parsed.label,
        budgetUsd: parsed.budgetUsd,
        waveSize: parsed.waveSize,
        selection: {
          mode: "explicit",
          listingIds: observed.ids,
          fields: parsed.fields,
        },
      },
      observed.fences,
    );
    return { ...result, scope: observed.scope };
  }
  return { preview, previewCohort, create };
}
