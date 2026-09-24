import {
  createWineIdentityAssertion,
  type WineSelectionAncestry,
} from "./wine-identity-selection.js";
import {
  groundWineEvidence,
  decideWineClaim,
  type WineFrozenContext,
  type SupportedClaim,
  type EvidenceSource,
} from "@wukong/core";
import type { WorkspaceRepositories } from "./client.js";
import type { ListingOperation } from "./repositories/listing-operations.js";
import {
  listingInputDigest,
  type ListingInputSnapshot,
} from "./repositories/listing-inputs.js";
import { parseWineStageResult } from "./wine-stage-artifacts.js";
import { readWineOriginalExtraction } from "./wine-original-extraction.js";
export class WineEvidenceAuthorizationError extends Error {}
function requireEvidence(value: unknown, code: string): asserts value {
  if (!value) throw new WineEvidenceAuthorizationError(code);
}
const same = (a: unknown, b: unknown) =>
  listingInputDigest(a) === listingInputDigest(b);
const provenance = (sources: EvidenceSource[]) =>
  sources
    .map(({ identity: _i, trust: _t, ...s }) => s)
    .sort((a, b) => a.id.localeCompare(b.id));
type VerifiedEvidenceArguments = {
  workspaceId: string;
  run: ListingOperation;
  input: ListingInputSnapshot;
  frozen: WineFrozenContext;
  claims: SupportedClaim[];
  now: string;
};
/** Current factual authorization retains the live registry equality gate. */
export async function authorizeWineVerifiedEvidence(
  r: WorkspaceRepositories,
  args: VerifiedEvidenceArguments,
  ancestry: WineSelectionAncestry = { sourceRunIds: [] },
): Promise<void> {
  const registry = await r.wineEnrichment.readAuthorities();
  requireEvidence(
    same(registry, args.frozen.authorities),
    "adopted_authority_changed",
  );
  await reconstructWineVerifiedEvidence(r, args, ancestry);
}
/** Internal immutable proof reconstruction. Historical selection callers load and
 * bind the persisted stage first; this is not a current factual authorization. */
export async function reconstructWineVerifiedEvidence(
  r: WorkspaceRepositories,
  args: VerifiedEvidenceArguments,
  ancestry: WineSelectionAncestry,
): Promise<void> {
  const { workspaceId, run, input, frozen, claims, now } = args;
  const accepted = Date.parse(run.acceptedAt),
    deadline = Date.parse(
      (run.execution.wineAcquisition as { deadlineAt: string }).deadlineAt,
    ),
    time = Date.parse(now);
  const binding = {
    workspaceId,
    operationId: run.id,
    inputRevision: run.inputRevision,
  };
  const registry = frozen.authorities;
  const sources = await r.wineEnrichment.readEvidence(run.id);
  requireEvidence(
    same(provenance(sources), provenance(frozen.sources)),
    "adopted_authority_changed",
  );
  requireEvidence(
    Date.parse(frozen.now) >= accepted &&
      Date.parse(frozen.now) < deadline &&
      Date.parse(frozen.now) <= time,
    "adopted_frozen_time_invalid",
  );
  requireEvidence(
    frozen.sources.every(
      (s) =>
        Date.parse(s.capturedAt) <= time &&
        (s.kind !== "web" || time - Date.parse(s.capturedAt) < 7 * 86400000),
    ),
    "evidence_refresh_required",
  );
  requireEvidence(
    frozen.acceptedPremises.every(
      (p) =>
        p.state === "accepted" &&
        p.kind === "fact" &&
        p.scope === "product" &&
        claims.some((x) => same(x, p)),
    ),
    "adopted_claim_invalid",
  );
  const extractionRow = await r.wineEnrichment.readStage(run.id, "extraction");
  const extraction =
    extractionRow?.state === "succeeded"
      ? parseWineStageResult(
          (extractionRow.output as { result: unknown }).result,
          "extraction",
        )
      : null;
  requireEvidence(
    extraction?.stage === "extraction" &&
      extraction.state === "succeeded" &&
      extractionRow,
    "adopted_extraction_unavailable",
  );
  const original = await readWineOriginalExtraction(
    r,
    workspaceId,
    run,
    extractionRow,
    extraction,
    ancestry,
  );
  const assets = input.sources
    .filter((s) => s.use === "analyse" && s.role !== "supplier_document")
    .map((s) => ({ id: s.assetId, digest: s.digest }));
  const grounding = {
    accepted: {
      binding,
      assets,
      note: input.note,
      lockedFields: original.context.lockedFields,
      verifiedAliases: original.context.verifiedAliases,
      identitySelection: input.workingContent.wineIdentitySelection
        ? createWineIdentityAssertion(
            input.workingContent.wineIdentitySelection,
            run.id,
          )
        : undefined,
    },
    extraction: { binding, identity: original.context.identity },
    records: sources.map((source) => ({
      binding,
      assetDigest:
        source.kind === "photo"
          ? (assets.find((a) => a.id === source.assetId)?.digest ?? null)
          : null,
      documentDigest: source.documentDigest,
      source,
    })),
    authorities: registry,
  };
  const derived = groundWineEvidence({ ...grounding, now: frozen.now }).context;
  const setDigest = (values: unknown[]) =>
    listingInputDigest(values.map((value) => listingInputDigest(value)).sort());
  for (const key of [
    "sources",
    "supports",
    "reliableSourceIds",
    "trustedObservationSourceIds",
    "verifiedAliases",
    "lockedFields",
  ] as const)
    requireEvidence(
      setDigest(derived[key]) === setDigest(frozen[key]),
      "adopted_grounding_invalid",
    );
  requireEvidence(
    same(derived.identity, frozen.identity) &&
      same(derived.binding, frozen.binding),
    "adopted_grounding_invalid",
  );
  // Historical authorization is immutable. Current trust is derived again at DB time,
  // including review expiry even when no registry row has changed.
  const current = groundWineEvidence({ ...grounding, now }).context;
  const context = {
    ...current,
    acceptedPremises: frozen.acceptedPremises,
    reliableSourceIds: new Set(current.reliableSourceIds),
    trustedObservationSourceIds: new Set(current.trustedObservationSourceIds),
  };
  for (const claim of claims) {
    const decision = decideWineClaim({
      identity: frozen.identity,
      claim,
      sources: current.sources,
      lockedFields: new Set(current.lockedFields),
      context,
    });
    requireEvidence(
      decision.state === "accepted" &&
        same([...decision.evidenceIds].sort(), [...claim.evidenceIds].sort()),
      "adopted_claim_invalid",
    );
  }
}
