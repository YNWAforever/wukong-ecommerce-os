import { createHash } from "node:crypto";
import {
  wineIdentityCoordinatesSchema,
  wineIdentitySelectionSchema,
  wineIdentityAssertionText,
  WINE_IDENTITY_ASSERTION_TITLE,
  type WineIdentitySelection,
  type WineIdentityAssertion,
} from "@wukong/core";
import type { WorkspaceRepositories } from "./client.js";
import {
  listingInputDigest,
  type ListingInputSnapshot,
} from "./repositories/listing-inputs.js";
import { wineStageDependencyDigest } from "./wine-stage-dependencies.js";
import {
  WINE_STAGE_ORDER,
  parseWineStageResult,
} from "./wine-stage-artifacts.js";
import type { StageRecord } from "./repositories/wine-enrichment.js";
import { authorizeWineVerifiedEvidence } from "./wine-verified-evidence.js";
function requireSelection(ok: unknown): asserts ok {
  if (!ok) throw Error("wine_identity_selection_invalid");
}
const same = (a: unknown, b: unknown) =>
  listingInputDigest(a) === listingInputDigest(b);
function validInputDigest(input: ListingInputSnapshot) {
  return (
    input.inputDigest ===
    listingInputDigest({
      note: input.note,
      sources: input.sources,
      workingContent: input.workingContent,
      fieldStates: input.fieldStates,
    })
  );
}
export type WineIdentityReference = {
  sourceRunId: string;
  sourceStage: "verification" | "verification_deep";
  sourceId: string;
};
export function wineSelectionContextDigest(
  input: Pick<
    ListingInputSnapshot,
    "note" | "sources" | "workingContent" | "fieldStates" | "baseVersionId"
  >,
) {
  // Compatible edits may refresh AI baseline values from the active review. Only
  // human-owned identity inputs are merchant assertions; preserve them exactly.
  const fields = [
    "producer",
    "productType",
    "vintage",
    "volumeMl",
    "packQuantity",
    "abvPercent",
    "country",
    "region",
    "grapeVarieties",
  ] as const;
  const identity = Object.fromEntries(
    fields
      .filter(
        (k) =>
          input.fieldStates[k]?.owner === "operator" ||
          input.fieldStates[k]?.locked,
      )
      .map((k) => [
        k,
        {
          value: input.workingContent[k],
          owner: input.fieldStates[k]?.owner,
          locked: input.fieldStates[k]?.locked,
        },
      ]),
  );
  return listingInputDigest({
    note: input.note,
    sources: input.sources,
    baseVersionId: input.baseVersionId,
    identity,
  });
}
/** Authority comes from persisted semantic checkpoints, never the sanitized progress DTO. */
export async function readWineIdentityCandidate(
  r: WorkspaceRepositories,
  args: WineIdentityReference & { workspaceId: string; listingId: string },
  now: string,
) {
  const run = await r.pipelineRuns.getOperation(args.sourceRunId);
  requireSelection(
    run &&
      run.listingId === args.listingId &&
      run.execution.flowVersion === "wine-enrichment-v1" &&
      ["full", "research"].includes(String(run.execution.wineMode)),
  );
  const input = await r.listingInputs.getRevision(
    run.listingId,
    run.inputRevision,
  );
  requireSelection(
    input &&
      validInputDigest(input) &&
      input.workspaceId === args.workspaceId &&
      input.inputDigest === run.execution.wineInputDigest &&
      same(
        input.sources,
        (run.execution.input as ListingInputSnapshot).sources,
      ),
  );
  requireSelection(
    same(
      {
        note: input.note,
        sources: input.sources,
        workingContent: input.workingContent,
        fieldStates: input.fieldStates,
      },
      {
        note: (run.execution.input as ListingInputSnapshot).note,
        sources: (run.execution.input as ListingInputSnapshot).sources,
        workingContent: (run.execution.input as ListingInputSnapshot)
          .workingContent,
        fieldStates: (run.execution.input as ListingInputSnapshot).fieldStates,
      },
    ),
  );
  const prefix: StageRecord[] = [];
  let chosen: ReturnType<typeof parseWineStageResult> | undefined;
  let chosenRow: StageRecord | undefined;
  for (const stage of WINE_STAGE_ORDER.slice(
    0,
    WINE_STAGE_ORDER.indexOf(args.sourceStage) + 1,
  )) {
    const row = await r.wineEnrichment.readStage(run.id, stage);
    requireSelection(
      row &&
        row.runId === run.id &&
        row.inputDigest === input.inputDigest &&
        row.dependencyDigest === wineStageDependencyDigest(run, prefix),
    );
    const wrapper = row.output as {
      schemaVersion?: number;
      fresh?: boolean;
      result?: unknown;
    };
    requireSelection(
      row.state === "succeeded" &&
        wrapper.schemaVersion === 1 &&
        wrapper.fresh === true,
    );
    const result = parseWineStageResult(wrapper.result, stage);
    requireSelection(result.state === "succeeded");
    prefix.push(row);
    chosen = result;
    chosenRow = row;
  }
  requireSelection(
    chosen?.state === "succeeded" &&
      (chosen.stage === "verification" ||
        chosen.stage === "verification_deep") &&
      chosen.frozenVerification,
  );
  if (args.sourceStage === "verification") {
    const deep = await r.wineEnrichment.readStage(run.id, "verification_deep");
    requireSelection(!deep || deep.state === "skipped");
  }
  const frozen = chosen.frozenVerification;
  requireSelection(
    same(frozen.binding, {
      workspaceId: args.workspaceId,
      operationId: run.id,
      inputRevision: run.inputRevision,
    }) && same(frozen.identity, chosen.identity),
  );
  await r.wineEnrichment.lockAuthorities();
  await authorizeWineVerifiedEvidence(r, {
    workspaceId: args.workspaceId,
    run,
    input,
    frozen,
    claims: chosen.claims.filter((c) => c.state === "accepted"),
    now,
  });
  const source = frozen.sources.find((s) => s.id === args.sourceId);
  requireSelection(
    source &&
      source.kind === "web" &&
      source.identity &&
      !source.truncated &&
      Date.parse(source.capturedAt) <= Date.parse(now) &&
      Date.parse(now) - Date.parse(source.capturedAt) < 7 * 86400000,
  );
  requireSelection(
    Object.values({
      ...source.identity.observations,
      ...source.identity.category,
    }).every((o) => !o || o.state !== "conflict"),
  );
  const identity = wineIdentityCoordinatesSchema.parse(
    Object.fromEntries(
      Object.keys(wineIdentityCoordinatesSchema.shape).map((k) => [
        k,
        (source.identity as unknown as Record<string, unknown>)[k],
      ]),
    ),
  );
  return { run, input, source, identity, stage: chosenRow!, frozen };
}
export function createWineIdentityAssertion(
  selection: WineIdentitySelection,
  runId: string,
): WineIdentityAssertion {
  const checked = wineIdentitySelectionSchema.parse(selection);
  const h = listingInputDigest({
    type: "wine-identity-selection@1",
    runId,
    selection: checked,
  });
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const excerpt = wineIdentityAssertionText(checked.selectedIdentity);
  return {
    identity: checked.selectedIdentity,
    source: {
      schemaVersion: 1,
      id,
      kind: "merchant",
      assetId: null,
      url: null,
      domain: null,
      title: WINE_IDENTITY_ASSERTION_TITLE,
      capturedAt: checked.selectedAt,
      excerpt,
      location: `wine:identity-selection:${runId}`,
      documentDigest:
        "sha256:" + createHash("sha256").update(excerpt).digest("hex"),
      contentScope: "note",
      truncated: false,
      identity: null,
      trust: "unverified",
      independenceKey: `merchant-selection:${checked.listingId}:${checked.selectedInputRevision}`,
    },
  };
}
/** Historical validation deliberately does not require the originating run to remain current. */
export async function readWineIdentitySelection(
  r: WorkspaceRepositories,
  input: ListingInputSnapshot,
  runId: string,
) {
  const raw = input.workingContent.wineIdentitySelection;
  if (raw === undefined) return undefined;
  const s = wineIdentitySelectionSchema.parse(raw);
  requireSelection(validInputDigest(input));
  requireSelection(
    s.workspaceId === input.workspaceId &&
      s.listingId === input.listingId &&
      s.sourceInputRevision < s.selectedInputRevision &&
      s.selectedInputRevision <= input.revision &&
      s.contextDigest === wineSelectionContextDigest(input),
  );
  const selectedInput = await r.listingInputs.getRevision(
    input.listingId,
    s.selectedInputRevision,
  );
  requireSelection(
    selectedInput &&
      selectedInput.actorId === s.selectedBy &&
      same(selectedInput.workingContent.wineIdentitySelection, s),
  );
  const origin = await readWineIdentityCandidate(
    r,
    { ...s, workspaceId: input.workspaceId, listingId: input.listingId },
    s.selectedAt,
  );
  requireSelection(
    origin.run.inputRevision === s.sourceInputRevision &&
      origin.input.inputDigest === s.sourceInputDigest &&
      origin.run.baseVersionId === s.sourceBaseVersionId &&
      listingInputDigest(origin.stage) === s.sourceStageDigest &&
      listingInputDigest(origin.source.identity) === s.identityDigest &&
      same(origin.identity, s.selectedIdentity),
  );
  return createWineIdentityAssertion(s, runId);
}
