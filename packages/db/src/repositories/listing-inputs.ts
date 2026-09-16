import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  applyWorkingChanges,
  editWineSections,
  inheritWineOwnership,
  type WineSectionChange,
  workingBaselineForReview,
  emptyWorkingListing,
  sourceSelectionSchema,
  workingListingSchema,
  workingFields,
  readWorkingField,
  transitionListing,
  type AuditContext,
  type AuditWriter,
  type WorkingListing,
  type WorkingFieldStates,
  type WorkingChange,
  type WorkingField,
  type SourceSelection,
  type ResolvedSourceSelection,
  type ListingStatus,
} from "@wukong/core";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import {
  listingDrafts,
  listingInputRevisions,
  listingVersions,
  sourceAssets,
} from "../schema.js";
export class ListingInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ListingInputError";
  }
}
export type ListingInputSnapshot = typeof listingInputRevisions.$inferSelect;
export type InitializeListingInput = {
  listingId: string;
  actorId: string;
  note?: string | null;
  sources?: SourceSelection[];
  workingContent?: WorkingListing;
};
export type SaveListingInput = {
  listingId: string;
  actorId: string;
  expectedInputRevision: number;
  baseVersionId: string | null;
  operationKey: string;
  requestDigest: string;
  note?: string | null;
  sources?: SourceSelection[];
  changes: WorkingChange[];
  reviewContent?: WorkingListing;
  sectionChanges?: WineSectionChange[];
  websiteEvidenceRefsByField?: Partial<Record<WorkingField, string[]>>;
  candidateLineage?: {
    runId: string;
    inputRevision: number;
    evidenceRefsByField: Record<string, string[]>;
  };
};
export type ListingInputRepository = {
  getByOperationKey(
    listingId: string,
    operationKey: string,
  ): Promise<ListingInputSnapshot | null>;
  getCurrent(listingId: string): Promise<ListingInputSnapshot | null>;
  getRevision(
    listingId: string,
    revision: number,
  ): Promise<ListingInputSnapshot | null>;
  initialize(
    input: InitializeListingInput,
    context: AuditContext,
    audit: AuditWriter,
  ): Promise<ListingInputSnapshot>;
  save(
    input: SaveListingInput,
    context: AuditContext,
    audit: AuditWriter,
  ): Promise<ListingInputSnapshot & { replayed: boolean }>;
};
function stable(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(stable)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, stable(v)]),
        )
      : value;
}
export function listingInputDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
export function createListingInputRepository(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ListingInputRepository {
  const draftWhere = (id: string) =>
    and(eq(listingDrafts.workspaceId, workspaceId), eq(listingDrafts.id, id));
  const inputWhere = (id: string) =>
    and(
      eq(listingInputRevisions.workspaceId, workspaceId),
      eq(listingInputRevisions.listingId, id),
    );
  async function lock(id: string) {
    scope.assertOpen();
    const [row] = await tx
      .select()
      .from(listingDrafts)
      .where(draftWhere(id))
      .for("update");
    if (!row) throw new ListingInputError("listing_not_found");
    return row;
  }
  async function resolveSources(
    listingId: string,
    selections: SourceSelection[],
  ): Promise<ResolvedSourceSelection[]> {
    const parsed = selections.map((x) => sourceSelectionSchema.parse(x));
    if (
      parsed.length > 11 ||
      new Set(parsed.map((x) => x.assetId)).size !== parsed.length ||
      parsed.filter((x) => x.hero).length > 1
    )
      throw new ListingInputError("invalid_sources");
    const assets = parsed.length
      ? await tx
          .select()
          .from(sourceAssets)
          .where(
            and(
              eq(sourceAssets.workspaceId, workspaceId),
              inArray(
                sourceAssets.id,
                parsed.map((x) => x.assetId),
              ),
            ),
          )
          .for("update")
      : [];
    if (
      assets.filter((a) => a.kind.startsWith("image/")).length > 10 ||
      assets.filter((a) => a.kind === "application/pdf").length > 1
    )
      throw new ListingInputError("invalid_sources");
    const result = parsed.map((source) => {
      const asset = assets.find((x) => x.id === source.assetId);
      if (!asset || (asset.listingId !== null && asset.listingId !== listingId))
        throw new ListingInputError("source_not_found");
      const meta = asset.metadata as Record<string, unknown>;
      const digest = meta.sha256 ?? meta.clientSha256;
      if (
        typeof digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(digest) ||
        typeof meta.size !== "number" ||
        meta.size <= 0
      )
        throw new ListingInputError("source_not_finalized");
      if (
        !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(
          asset.kind,
        )
      )
        throw new ListingInputError("invalid_sources");
      const image = asset.kind.startsWith("image/");
      if (
        (source.role === "supplier_document") === image ||
        (source.hero && !image)
      )
        throw new ListingInputError("invalid_sources");
      return { ...source, digest };
    });
    const unbound = assets.filter((x) => x.listingId === null).map((x) => x.id);
    if (unbound.length)
      await tx
        .update(sourceAssets)
        .set({ listingId })
        .where(
          and(
            eq(sourceAssets.workspaceId, workspaceId),
            inArray(sourceAssets.id, unbound),
            isNull(sourceAssets.listingId),
          ),
        );
    return result;
  }
  async function persist(
    input: {
      listingId: string;
      revision: number;
      baseVersionId: string | null;
      note: string | null;
      sources: ResolvedSourceSelection[];
      workingContent: WorkingListing;
      fieldStates: WorkingFieldStates;
      actorId: string;
      operationKey?: string;
      requestDigest?: string;
    },
    context: AuditContext,
    audit: AuditWriter,
  ) {
    const inputDigest = listingInputDigest({
      note: input.note,
      sources: input.sources,
      workingContent: input.workingContent,
      fieldStates: input.fieldStates,
    });
    const [created] = await tx
      .insert(listingInputRevisions)
      .values({ ...input, workspaceId, inputDigest })
      .returning();
    if (!created) throw new Error("input insert returned no row");
    await tx
      .update(listingDrafts)
      .set({
        inputRevision: input.revision,
        note: input.note,
        updatedAt: new Date(),
      })
      .where(draftWhere(input.listingId));
    await audit.write({
      ...context,
      action: "listing.inputs_saved",
      metadata: {
        inputRevision: input.revision,
        baseVersionId: input.baseVersionId,
        sourceCount: input.sources.length,
      },
    });
    return created;
  }
  const repository: ListingInputRepository = {
    async getByOperationKey(id, key) {
      scope.assertOpen();
      const [row] = await tx
        .select()
        .from(listingInputRevisions)
        .where(and(inputWhere(id), eq(listingInputRevisions.operationKey, key)))
        .limit(1);
      return row ?? null;
    },
    async getRevision(id, revision) {
      scope.assertOpen();
      const [row] = await tx
        .select()
        .from(listingInputRevisions)
        .where(
          and(inputWhere(id), eq(listingInputRevisions.revision, revision)),
        )
        .limit(1);
      return row ?? null;
    },
    async getCurrent(id) {
      scope.assertOpen();
      const [draft] = await tx
        .select({ revision: listingDrafts.inputRevision })
        .from(listingDrafts)
        .where(draftWhere(id));
      return draft ? repository.getRevision(id, draft.revision) : null;
    },
    async initialize(input, context, audit) {
      if (input.workingContent?.wineOwnership !== undefined)
        throw new ListingInputError("wine_ownership_server_only");
      const draft = await lock(input.listingId);
      const current = await repository.getCurrent(input.listingId);
      if (current) return current;
      let content = input.workingContent ?? emptyWorkingListing();
      const states: WorkingFieldStates = Object.fromEntries(
        workingFields.map((field) => [
          field,
          {
            owner: ["sku", "priceHkd", "stockQuantity"].includes(field)
              ? "operator"
              : "ai",
            state: "unknown",
            locked: false,
            evidenceRefs: [],
          },
        ]),
      ) as WorkingFieldStates;
      if (draft.activeVersionId && !input.workingContent) {
        const [version] = await tx
          .select()
          .from(listingVersions)
          .where(
            and(
              eq(listingVersions.workspaceId, workspaceId),
              eq(listingVersions.listingId, input.listingId),
              eq(listingVersions.id, draft.activeVersionId),
            ),
          );
        if (version) content = workingListingSchema.parse(version.content);
        // Legacy provenance is uncertain. Protect existing values conservatively.
        for (const field of workingFields)
          if (
            readWorkingField(content, field) !== null &&
            readWorkingField(content, field) !== ""
          )
            states[field] = {
              owner: "operator",
              state: "manual",
              locked: false,
              evidenceRefs: [],
            };
      }
      if (input.workingContent) {
        for (const field of workingFields) {
          const value = readWorkingField(content, field);
          if (
            value !== null &&
            value !== "" &&
            !(Array.isArray(value) && value.length === 0)
          )
            states[field] = {
              owner: "operator",
              state: "manual",
              locked: false,
              evidenceRefs: [],
            };
        }
      } else if (draft.activeVersionId) {
        for (const field of workingFields)
          if (states[field]?.state === "manual")
            states[field] = { ...states[field]!, provenanceUncertain: true };
      }
      const assets =
        input.sources === undefined
          ? await tx
              .select()
              .from(sourceAssets)
              .where(
                and(
                  eq(sourceAssets.workspaceId, workspaceId),
                  eq(sourceAssets.listingId, input.listingId),
                ),
              )
          : [];
      const selections =
        input.sources ??
        assets
          .filter(
            (x) =>
              !["product_shot_cutout", "product_shot_candidate"].includes(
                (x.metadata as Record<string, unknown>)?.role as string,
              ),
          )
          .map((x) => ({
            assetId: x.id,
            role: x.kind.startsWith("image/")
              ? ("other_image" as const)
              : ("supplier_document" as const),
            use: "analyse" as const,
            hero: false,
          }));
      const sources = await resolveSources(input.listingId, selections);
      content = workingListingSchema.parse(content);
      content.imageAssetIds = sources
        .filter((x) => x.role !== "supplier_document")
        .map((x) => x.assetId);
      return persist(
        {
          listingId: input.listingId,
          revision: 1,
          baseVersionId: draft.activeVersionId,
          note: input.note ?? draft.note,
          sources,
          workingContent: content,
          fieldStates: states,
          actorId: input.actorId,
        },
        context,
        audit,
      );
    },
    async save(input, context, audit) {
      const draft = await lock(input.listingId);
      const [replay] = await tx
        .select()
        .from(listingInputRevisions)
        .where(
          and(
            inputWhere(input.listingId),
            eq(listingInputRevisions.operationKey, input.operationKey),
          ),
        );
      if (replay) {
        if (replay.requestDigest !== input.requestDigest)
          throw new ListingInputError("idempotency_conflict");
        return { ...replay, replayed: true };
      }
      if (draft.inputRevision !== input.expectedInputRevision)
        throw new ListingInputError("input_revision_conflict");
      if (draft.activeVersionId !== input.baseVersionId)
        throw new ListingInputError("base_version_conflict");
      if (draft.status === "publishing")
        throw new ListingInputError("listing_busy");
      let current = await repository.getCurrent(input.listingId);
      if (!current)
        current = await repository.initialize(
          { listingId: input.listingId, actorId: input.actorId },
          context,
          audit,
        );
      const sources =
        input.sources === undefined
          ? current.sources
          : await resolveSources(input.listingId, input.sources);
      const [activeVersion] = draft.activeVersionId
        ? await tx
            .select({ content: listingVersions.content })
            .from(listingVersions)
            .where(
              and(
                eq(listingVersions.workspaceId, workspaceId),
                eq(listingVersions.listingId, input.listingId),
                eq(listingVersions.id, draft.activeVersionId),
              ),
            )
            .limit(1)
        : [];
      const baseline = workingBaselineForReview(
        current.workingContent,
        current.fieldStates,
        activeVersion?.content,
      );
      if (
        input.sectionChanges?.length &&
        input.changes.some((c) => c.field.startsWith("description."))
      )
        throw new ListingInputError("wine_description_edit_conflict");
      const changed = applyWorkingChanges(
        input.reviewContent
          ? inheritWineOwnership(
              baseline.workingContent,
              workingListingSchema.parse(input.reviewContent),
            )
          : baseline.workingContent,
        baseline.fieldStates,
        input.changes,
      );
      if (input.sectionChanges?.length)
        changed.content = editWineSections(
          changed.content,
          input.sectionChanges,
        );
      if (input.websiteEvidenceRefsByField)
        for (const change of input.changes)
          changed.fieldStates[change.field] = {
            ...changed.fieldStates[change.field]!,
            evidenceRefs: input.websiteEvidenceRefsByField[change.field] ?? [],
          };
      if (input.candidateLineage)
        for (const change of input.changes)
          changed.fieldStates[change.field] = {
            ...changed.fieldStates[change.field]!,
            candidateRunId: input.candidateLineage.runId,
            candidateInputRevision: input.candidateLineage.inputRevision,
            evidenceRefs:
              input.candidateLineage.evidenceRefsByField[change.field] ?? [],
          };
      if (!input.reviewContent)
        changed.content.imageAssetIds = sources
          .filter((x) => x.role !== "supplier_document")
          .map((x) => x.assetId);
      const superseded = await tx.execute(
        sql`update listing_pipeline_runs set execution_state='superseded',status='succeeded',error_code='input_superseded',updated_at=now() where workspace_id=${workspaceId} and listing_id=${input.listingId}::uuid and execution_state in ('queued','running') returning id`,
      );
      for (const run of superseded)
        await audit.write({
          ...context,
          action: "listing.processing_superseded",
          metadata: {
            runId: String(run.id),
            inputRevision: current.revision + 1,
          },
        });
      const next = await transitionListing(
        draft.status as ListingStatus,
        "save_inputs",
        context,
        audit,
      );
      await tx
        .update(listingDrafts)
        .set({ status: next })
        .where(draftWhere(input.listingId));
      if (["approved", "published", "publish_failed"].includes(draft.status))
        await audit.write({
          ...context,
          action: "listing.approval_invalidated",
          metadata: {
            cause: "inputs_changed",
            fromStatus: draft.status,
            versionId: draft.activeVersionId,
          },
        });
      const sourceContextChanged =
        listingInputDigest({ note: current.note, sources: current.sources }) !==
        listingInputDigest({
          note: input.note === undefined ? current.note : input.note,
          sources,
        });
      if (draft.activeVersionId && sourceContextChanged) {
        const invalidated = await tx.execute(
          sql`update review_confirmations set field_confirmations='{}'::jsonb,negative_confirmations='{}'::jsonb,field_records=null,revision=revision+1,updated_at=now() where workspace_id=${workspaceId} and listing_id=${input.listingId}::uuid and version_id=${draft.activeVersionId}::uuid returning id`,
        );
        if (invalidated.length)
          await audit.write({
            ...context,
            action: "review_confirmation.invalidated",
            metadata: {
              cause: "working_sources_changed",
              versionId: draft.activeVersionId,
              inputRevision: current.revision + 1,
            },
          });
      }
      const created = await persist(
        {
          listingId: input.listingId,
          revision: current.revision + 1,
          baseVersionId: input.baseVersionId,
          note: input.note === undefined ? current.note : input.note,
          sources,
          workingContent: changed.content,
          fieldStates: changed.fieldStates,
          actorId: input.actorId,
          operationKey: input.operationKey,
          requestDigest: input.requestDigest,
        },
        context,
        audit,
      );
      return { ...created, replayed: false };
    },
  };
  return repository;
}
