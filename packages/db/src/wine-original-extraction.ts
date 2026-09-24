import {
  readWineIdentitySelection,
  type WineSelectionAncestry,
} from "./wine-identity-selection.js";
import { createHash } from "node:crypto";
import { groundWineEvidence } from "@wukong/core";
import type { WorkspaceRepositories } from "./client.js";
import type { ListingOperation } from "./repositories/listing-operations.js";
import type { StageRecord } from "./repositories/wine-enrichment.js";
import { listingInputDigest } from "./repositories/listing-inputs.js";
import type { WineStageResult } from "./wine-stage-artifacts.js";
export const WINE_EXTRACTION_CONTEXT_KEY = "wine-extraction@1";
function sha(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
function requireValid(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
export function wineExtractionSourceId(runId: string, index: number) {
  const h = sha(`wine-extraction@1:${runId}:${index}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Original immutable extraction only; caller owns operation/stage authorization and transaction. */
export async function readWineOriginalExtraction(
  r: WorkspaceRepositories,
  workspaceId: string,
  run: ListingOperation,
  stage: StageRecord,
  result: Extract<WineStageResult, { stage: "extraction"; state: "succeeded" }>,
  ancestry: WineSelectionAncestry = { sourceRunIds: [] },
) {
  const input = await r.listingInputs.getRevision(
    run.listingId,
    run.inputRevision,
  );
  requireValid(
    input &&
      input.workspaceId === workspaceId &&
      input.inputDigest === stage.inputDigest &&
      listingInputDigest(input.sources) === run.execution.wineSourceDigest,
    "extraction_input_invalid",
  );
  const identitySelection = await readWineIdentitySelection(
    r,
    input,
    run.id,
    ancestry,
  );
  requireValid(
    Boolean(identitySelection) === Boolean(result.originalIdentity),
    "extraction_selection_binding_invalid",
  );
  const saved = await r.wineEnrichment.readTrustedContext(
    run.id,
    WINE_EXTRACTION_CONTEXT_KEY,
    stage.inputDigest,
  );
  requireValid(
    saved &&
      saved.policyVersion ===
        (run.execution.wineAcquisition as { policyVersion: string })
          .policyVersion &&
      listingInputDigest(saved.identity) ===
        listingInputDigest(result.identity),
    "extraction_trusted_context_invalid",
  );
  const rows = await r.wineEnrichment.readEvidence(run.id),
    binding = {
      workspaceId: workspaceId,
      operationId: run.id,
      inputRevision: run.inputRevision,
    };
  const assets = input.sources
    .filter((s) => s.use === "analyse" && s.role !== "supplier_document")
    .map((s) => ({ id: s.assetId, digest: s.digest }));
  const records = result.evidence.map((source, index) => {
    const row = rows.find((s) => s.id === source.id);
    if (identitySelection && source.id === identitySelection.source.id) {
      requireValid(
        index === result.evidence.length - 1 &&
          row &&
          listingInputDigest(row) ===
            listingInputDigest(identitySelection.source) &&
          listingInputDigest(source) === listingInputDigest(row),
        "extraction_selection_binding_invalid",
      );
      return {
        binding,
        assetDigest: null,
        documentDigest: row.documentDigest,
        source: row,
      };
    }
    requireValid(
      row &&
        listingInputDigest(row) === listingInputDigest(source) &&
        row.id === wineExtractionSourceId(run.id, index) &&
        row.kind !== "web" &&
        row.url === null &&
        row.domain === null &&
        row.capturedAt === result.observedAt &&
        row.documentDigest === "sha256:" + sha(row.excerpt) &&
        row.location === `wine:extraction:${run.id}:transcript:${index}`,
      "extraction_source_checkpoint_invalid",
    );
    const asset =
      row.kind === "photo" ? assets.find((a) => a.id === row.assetId) : null;
    requireValid(row.kind !== "photo" || asset, "extraction_asset_invalid");
    requireValid(
      row.independenceKey ===
        (row.kind === "photo"
          ? `asset:${asset!.digest}`
          : `merchant:${run.id}`),
      "extraction_source_checkpoint_invalid",
    );
    return {
      binding,
      assetDigest: asset?.digest ?? null,
      documentDigest: row.documentDigest,
      source: row,
    };
  });
  requireValid(
    Date.parse(result.observedAt) >= Date.parse(run.acceptedAt) &&
      Date.parse(result.observedAt) <
        Date.parse(
          (run.execution.wineAcquisition as { deadlineAt: string }).deadlineAt,
        ),
    "extraction_observation_time_invalid",
  );
  const lockedFields = Object.entries(input.fieldStates)
    .filter(([, v]) => v?.locked || v?.owner === "operator")
    .map(([key]) => key);
  const rebuilt = groundWineEvidence({
    accepted: {
      binding,
      assets,
      note: input.note,
      lockedFields,
      verifiedAliases: saved.verifiedAliases,
      identitySelection,
    },
    extraction: {
      binding,
      identity: result.originalIdentity ?? result.identity,
    },
    records,
    authorities: saved.authorities,
    now: result.observedAt,
  });
  for (const key of [
    "supports",
    "reliableSourceIds",
    "trustedObservationSourceIds",
    "acceptedPremises",
  ] as const)
    requireValid(
      listingInputDigest(
        saved[key].map((v) => listingInputDigest(v)).sort(),
      ) ===
        listingInputDigest(
          rebuilt.context[key].map((v) => listingInputDigest(v)).sort(),
        ),
      "extraction_trusted_context_invalid",
    );
  requireValid(
    listingInputDigest(rebuilt.context.identity) ===
      listingInputDigest(result.identity),
    "extraction_trusted_context_invalid",
  );
  // Re-grounding sanitized observations cannot regenerate invalid raw hints: preserve committed diagnostics exactly.
  return { context: rebuilt.context, issues: structuredClone(result.issues) };
}
