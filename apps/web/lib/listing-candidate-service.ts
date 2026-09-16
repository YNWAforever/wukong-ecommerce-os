import { z } from "zod";
import {
  fieldEvidenceSchema,
  listingFactsSchema,
  workingListingSchema,
  workingFields,
  readWorkingField,
  type WorkingField,
} from "@wukong/core";
import {
  listingInputDigest,
  type ListingInputSnapshot,
  type ListingOperation,
  type WorkspaceRepositories,
} from "@wukong/db";
import { ApiError } from "./route-support";
const evidenceSchema = z
  .array(fieldEvidenceSchema.extend({ excerpt: z.string().min(1).max(2000) }))
  .max(200);
const identity: WorkingField[] = [
  "producer",
  "productType",
  "country",
  "region",
  "vintage",
  "volumeMl",
  "packQuantity",
];
export type CandidateDiff = {
  inputRevision: number;
  baseVersionId: string | null;
  fields: Array<{
    field: WorkingField;
    value: unknown;
    currentValue: unknown;
    eligible: boolean;
    reason: string | null;
    evidence: z.infer<typeof fieldEvidenceSchema>[];
  }>;
};
export function candidateDifferences(
  run: ListingOperation,
  current: ListingInputSnapshot,
): CandidateDiff | null {
  const stored = run.execution.candidate;
  if (!stored || JSON.stringify(stored).length > 256000) return null;
  const envelope = stored as {
    content?: unknown;
    evidence?: unknown;
    stage?: unknown;
  };
  const candidate = workingListingSchema.safeParse(envelope.content ?? stored);
  const original = run.execution.input as ListingInputSnapshot | undefined;
  const originalContent = workingListingSchema.safeParse(
    original?.workingContent,
  );
  if (!candidate.success || !originalContent.success || !original) return null;
  const evidence = evidenceSchema.safeParse(envelope.evidence ?? []);
  const sourceIds = new Set(
    original.sources.filter((s) => s.use === "analyse").map((s) => s.assetId),
  );
  const validEvidence = evidence.success
    ? evidence.data.filter(
        (e) => e.sourceAssetId === "note" || sourceIds.has(e.sourceAssetId),
      )
    : [];
  const compatible =
    listingInputDigest({ note: original.note, sources: original.sources }) ===
      listingInputDigest({ note: current.note, sources: current.sources }) &&
    identity.every(
      (field) =>
        JSON.stringify(readWorkingField(originalContent.data, field)) ===
        JSON.stringify(readWorkingField(current.workingContent, field)),
    );
  const fields = workingFields.flatMap((field) => {
    const value = readWorkingField(candidate.data, field);
    if (
      envelope.stage === "extract" &&
      (!(field in listingFactsSchema.shape) ||
        ["sku", "priceHkd", "stockQuantity"].includes(field) ||
        value === null ||
        value === "")
    )
      return [];
    const currentValue = readWorkingField(current.workingContent, field);
    if (JSON.stringify(value) === JSON.stringify(currentValue)) return [];
    const reason = !compatible
      ? "candidate_incompatible"
      : ["sku", "priceHkd", "stockQuantity"].includes(field)
        ? "merchant_field"
        : current.fieldStates[field]?.locked
          ? "field_locked"
          : null;
    return [
      {
        field,
        value,
        currentValue,
        eligible: reason === null,
        reason,
        evidence: validEvidence.filter(
          (e) => e.field.replace(/^facts\./, "") === field,
        ),
      },
    ];
  });
  return {
    inputRevision: run.inputRevision,
    baseVersionId: run.baseVersionId,
    fields,
  };
}
export async function adoptListingCandidate(
  repos: WorkspaceRepositories,
  input: {
    workspaceId: string;
    listingId: string;
    runId: string;
    actorId: string;
    expectedInputRevision: number;
    baseVersionId: string | null;
    operationKey: string;
    selectedFieldPaths: WorkingField[];
  },
) {
  await repos.listings.lockReviewState(input.listingId);
  const run = await repos.pipelineRuns.getOperation(input.runId);
  if (!run || run.listingId !== input.listingId)
    throw new ApiError(404, "run_not_found", "Run not found.");
  const requestDigest = listingInputDigest({
    action: "adopt_candidate",
    runId: input.runId,
    expectedInputRevision: input.expectedInputRevision,
    baseVersionId: input.baseVersionId,
    selectedFieldPaths: [...input.selectedFieldPaths].sort(),
  });
  const replay = await repos.listingInputs.getByOperationKey(
    input.listingId,
    input.operationKey,
  );
  if (replay) {
    if (replay.requestDigest !== requestDigest)
      throw new ApiError(
        409,
        "idempotency_conflict",
        "The operation key was already used.",
      );
    return replay;
  }
  const current = await repos.listingInputs.getCurrent(input.listingId);
  if (!current)
    throw new ApiError(
      409,
      "candidate_incompatible",
      "Save the working inputs before adopting a candidate.",
    );
  const listing = await repos.listings.getById(input.listingId);
  if (current.revision !== input.expectedInputRevision)
    throw new ApiError(
      409,
      "input_revision_conflict",
      "Reload inputs before adopting.",
    );
  if (listing?.activeVersionId !== input.baseVersionId)
    throw new ApiError(
      409,
      "base_version_conflict",
      "Reload the current version before adopting.",
    );
  const extractionCandidate =
    (run.execution.candidate as { stage?: unknown } | undefined)?.stage ===
    "extract";
  if (
    !["superseded", "succeeded"].includes(run.executionState) &&
    !(run.executionState === "failed" && extractionCandidate)
  )
    throw new ApiError(
      409,
      "candidate_incompatible",
      "The candidate is not available for adoption.",
    );
  const candidate = candidateDifferences(run, current);
  if (
    !candidate ||
    new Set(input.selectedFieldPaths).size !== input.selectedFieldPaths.length
  )
    throw new ApiError(
      409,
      "candidate_incompatible",
      "The candidate does not match current inputs.",
    );
  const selected = input.selectedFieldPaths.map((field) =>
    candidate.fields.find((f) => f.field === field),
  );
  if (selected.some((field) => field?.reason === "field_locked"))
    throw new ApiError(
      409,
      "field_locked",
      "Unlock the field through a deliberate edit before adopting.",
    );
  if (selected.some((field) => !field?.eligible))
    throw new ApiError(
      409,
      "candidate_incompatible",
      "The selected candidate fields no longer match current inputs.",
    );
  const context = {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    entityId: input.listingId,
  };
  const saved = await repos.listingInputs.save(
    {
      listingId: input.listingId,
      actorId: input.actorId,
      expectedInputRevision: input.expectedInputRevision,
      baseVersionId: input.baseVersionId,
      operationKey: input.operationKey,
      requestDigest,
      changes: selected.map((field) => ({
        field: field!.field,
        value: field!.value,
      })),
      candidateLineage: {
        runId: run.id,
        inputRevision: run.inputRevision,
        evidenceRefsByField: Object.fromEntries(
          selected.map((field) => [
            field!.field,
            field!.evidence.map(
              (_, index) => `run:${run.id}:${field!.field}:${index}`,
            ),
          ]),
        ),
      },
    },
    context,
    repos.audit,
  );
  await repos.audit.write({
    ...context,
    action: "listing.candidate_adopted",
    metadata: {
      runId: run.id,
      inputRevision: saved.revision,
      selectedFields: input.selectedFieldPaths,
    },
  });
  return saved;
}
