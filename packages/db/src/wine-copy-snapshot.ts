import {
  wineCopySnapshotSchema,
  WINE_COPY_LIMITS,
  wineEnrichmentPolicySchema,
  wineExecutionSnapshotSchema,
  wineContentSchema,
  wineFrozenContextSchema,
  supportedClaimSchema,
  wineTextPaths,
  type WineCopySnapshot,
  type SupportedClaim,
  type WineEnrichmentPolicy,
  type WineExecutionSnapshot,
  type SectionKey,
} from "@wukong/core";
import type {
  AdoptedWineDependencies,
  ValidatedWineOrigin,
} from "./wine-adopted-dependencies.js";
import type { WineGenerationOwnership } from "./wine-generation-ownership.js";
import type { ListingInputSnapshot } from "./repositories/listing-inputs.js";
import { listingInputDigest as hash } from "./repositories/listing-inputs.js";
export class WineCopyDependencyError extends Error {
  readonly code = "evidence_refresh_required";
  constructor() {
    super("evidence_refresh_required");
    this.name = "WineCopyDependencyError";
  }
}
function requireCopy(value: unknown): asserts value {
  if (!value) throw new WineCopyDependencyError();
}
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
type Available = Extract<AdoptedWineDependencies, { status: "available" }>;
export type WineCopySnapshotInput = {
  adopted: AdoptedWineDependencies;
  input: Pick<
    ListingInputSnapshot,
    "workspaceId" | "listingId" | "revision" | "inputDigest" | "sources"
  >;
  ownership: WineGenerationOwnership;
  policy: WineEnrichmentPolicy;
  model: WineExecutionSnapshot;
  mode: "copy" | "section";
  section: SectionKey | null;
};
/** Excludes only live-read audit provenance and its own digest. Frozen original time remains bound. */
export function wineCopyDependencyDigest(snapshot: WineCopySnapshot) {
  const {
    adoptedProvenanceDigest: _audit,
    dependencyDigest: _digest,
    ...stable
  } = snapshot;
  return hash(stable);
}
/** Pure SERVER builder, not an admission token or current-time evidence authorization.
 * Caller must obtain dependencies/ownership inside the actual admission/runtime transaction.
 * No source pools are persisted; selected claims are returned separately for a newly bound request. */
export function buildWineCopySnapshot(raw: WineCopySnapshotInput): {
  snapshot: WineCopySnapshot;
  claims: SupportedClaim[];
} {
  try {
    return build(raw);
  } catch {
    throw new WineCopyDependencyError();
  }
}
function build(raw: WineCopySnapshotInput) {
  const { input, ownership: own, mode, section } = raw;
  const policy = wineEnrichmentPolicySchema.parse(raw.policy),
    model = wineExecutionSnapshotSchema.parse(raw.model);
  requireCopy(raw.adopted.status === "available" && own.status === "available");
  const d: Available = raw.adopted;
  requireCopy(
    d.schemaVersion === 1 &&
      d.outcome === "complete" &&
      d.current &&
      own.prior.kind === "structured",
  );
  const current = wineContentSchema.parse(d.current),
    adopted = wineContentSchema.parse(d.adopted);
  requireCopy(
    policy.enabled &&
      policy.rulesVersion === model.rulesVersion &&
      d.inputRevision === input.revision &&
      own.binding.workspaceId === input.workspaceId &&
      own.binding.listingId === input.listingId &&
      own.binding.baseVersionId === d.versionId &&
      own.binding.inputRevision === input.revision &&
      own.provenance.inputDigest === input.inputDigest &&
      same(own.prior.current, current),
  );
  requireCopy(
    d.origins.length > 0 &&
      d.origins.length <= WINE_COPY_LIMITS.origins &&
      d.supports.length <= WINE_COPY_LIMITS.supports &&
      d.unavailableSections.length <= WINE_COPY_LIMITS.paths,
  );
  requireCopy(
    (mode === "section") === (section !== null) &&
      ["copy", "section"].includes(mode),
  );
  requireCopy(
    new Set(current.sections.map((s) => s.key)).size ===
      current.sections.length && current.sections.length <= 6,
  );
  const protectedPath = (path: string) =>
    own.lockedPaths.some((p) => path === p || path.startsWith(p + ".")) ||
    current.sections.some(
      (s) =>
        (s.locked || s.owner === "operator") &&
        path.startsWith(`sections.${s.key}.`),
    );
  const paths = wineTextPaths(current);
  const targetPaths = (
    section
      ? ["en", "zh-Hant"].map((lang) => `sections.${section}.${lang}`)
      : [...paths.keys()].filter((p) => !protectedPath(p))
  ).sort();
  requireCopy(
    targetPaths.length > 0 &&
      targetPaths.every((p) => paths.has(p) && !protectedPath(p)),
  );
  requireCopy(!d.unavailableSections.some((s) => targetPaths.includes(s.path)));
  const origins = new Map<string, ValidatedWineOrigin>();
  for (const origin of d.origins) {
    requireCopy(
      !origins.has(origin.runId) &&
        origin.workspaceId === input.workspaceId &&
        origin.listingId === input.listingId,
    );
    const p = wineEnrichmentPolicySchema.parse(origin.policy),
      g = wineExecutionSnapshotSchema.parse(origin.modelPolicy),
      frozen = wineFrozenContextSchema.parse(origin.frozenVerification);
    requireCopy(
      ["full", "research"].includes(origin.mode) &&
        p.policyVersion === policy.policyVersion &&
        p.rulesVersion === policy.rulesVersion &&
        same(g, model) &&
        frozen.binding.workspaceId === input.workspaceId &&
        frozen.binding.operationId === origin.runId &&
        frozen.binding.inputRevision === origin.inputRevision,
    );
    requireCopy(
      origin.claims.length <= WINE_COPY_LIMITS.claims &&
        new Set(origin.claims.map((c) => c.id)).size === origin.claims.length &&
        new Set(frozen.sources.map((s) => s.id)).size === frozen.sources.length,
    );
    origins.set(origin.runId, origin);
  }
  type Selected = {
    claim: SupportedClaim;
    origin: ValidatedWineOrigin;
    sources: WineCopySnapshot["claims"][number]["sources"];
  };
  const claims = new Map<string, Selected>();
  function addClaim(
    origin: ValidatedWineOrigin,
    id: string,
    seen = new Set<string>(),
  ): Selected {
    requireCopy(!seen.has(id));
    const claim = supportedClaimSchema.parse(
      origin.claims.find((c) => c.id === id),
    );
    requireCopy(claim.state === "accepted");
    const existing = claims.get(id);
    // Ambiguous original namespaces never get silently remapped.
    requireCopy(
      !existing ||
        (existing.origin.runId === origin.runId &&
          existing.origin.versionId === origin.versionId &&
          same(existing.claim, claim)),
    );
    if (existing) return existing;
    requireCopy(claims.size < WINE_COPY_LIMITS.claims);
    const sourceIds = new Set(claim.evidenceIds);
    for (const premise of claim.premiseClaimIds) {
      const p = addClaim(origin, premise, new Set(seen).add(id));
      requireCopy(p.claim.kind === "fact");
      p.sources.forEach((s) => sourceIds.add(s.id));
    }
    const sources = [...sourceIds].sort().map((id) => {
      const source = origin.frozenVerification.sources.find((s) => s.id === id);
      requireCopy(source);
      if (source.kind === "web")
        requireCopy(
          source.domain &&
            source.url &&
            new URL(source.url).hostname === source.domain &&
            policy.allowedDomains.includes(source.domain),
        );
      return { id, digest: hash(source) };
    });
    requireCopy(sources.length <= WINE_COPY_LIMITS.sourcesPerClaim);
    const result = { claim, origin, sources };
    claims.set(id, result);
    return result;
  }
  const supports: WineCopySnapshot["supports"] = [];
  for (const support of d.supports.filter((s) =>
    targetPaths.includes(s.path),
  )) {
    requireCopy(
      support.valid &&
        support.invalidReason === null &&
        support.text === paths.get(support.path) &&
        support.text.includes(support.span) &&
        support.span.length > 0,
    );
    const origin = origins.get(support.originRunId);
    requireCopy(
      origin &&
        origin.versionId === support.originVersionId &&
        origin.inputRevision === support.originInputRevision,
    );
    const c = addClaim(origin, support.claimId);
    requireCopy(
      same(c.claim, support.claim) &&
        same(c.claim.evidenceIds, support.evidenceIds) &&
        same(c.claim.premiseClaimIds, support.premiseClaimIds),
    );
    requireCopy(
      same(
        c.sources,
        support.sources
          .map((s) => ({ id: s.id, digest: hash(s) }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
    );
    supports.push({
      path: support.path,
      claimId: support.claimId,
      originRunId: origin.runId,
      originVersionId: origin.versionId,
      textDigest: hash(support.text),
      spanDigest: hash(support.span),
    });
  }
  requireCopy(
    targetPaths.every(
      (p) => !paths.get(p)!.trim() || supports.some((s) => s.path === p),
    ),
  );
  for (const s of current.sections) {
    const selectedPaths = targetPaths.filter((p) =>
      p.startsWith(`sections.${s.key}.`),
    );
    if (selectedPaths.length)
      requireCopy(
        s.claimIds.every((id) =>
          supports.some(
            (a) => selectedPaths.includes(a.path) && a.claimId === id,
          ),
        ),
      );
  }
  const selected = [...claims.values()].sort((a, b) =>
    a.claim.id.localeCompare(b.claim.id),
  );
  const used = [...new Set(selected.map((c) => c.origin.runId))]
    .sort()
    .map((id) => origins.get(id)!);
  const snapshot = wineCopySnapshotSchema.parse({
    schemaVersion: 1,
    mode,
    section,
    workspaceId: input.workspaceId,
    listingId: input.listingId,
    baseVersionId: d.versionId,
    adoptedRunId: d.originRunId,
    inputRevision: input.revision,
    inputDigest: input.inputDigest,
    sourceDigest: hash(input.sources),
    currentContentDigest: hash(current),
    adoptedContentDigest: hash(adopted),
    ownershipDigest: hash({
      prior: own.prior,
      lockedPaths: [...own.lockedPaths].sort(),
      provenance: own.provenance,
    }),
    policyDigest: hash(policy),
    modelDigest: hash(model),
    targetPaths,
    origins: used.map((o) => ({
      runId: o.runId,
      versionId: o.versionId,
      inputRevision: o.inputRevision,
      inputDigest: o.inputDigest,
      sourceDigest: o.sourceDigest,
      acceptedAt: o.acceptedAt,
      policyDigest: hash(o.policy),
      modelDigest: hash(o.modelPolicy),
      identityDigest: hash(o.frozenVerification.identity),
      frozenContextDigest: hash(o.frozenVerification),
    })),
    claims: selected.map((c) => ({
      claimId: c.claim.id,
      originRunId: c.origin.runId,
      originVersionId: c.origin.versionId,
      claimDigest: hash(c.claim),
      premiseClaimIds: [...c.claim.premiseClaimIds].sort(),
      sources: c.sources,
    })),
    supports: supports.sort((a, b) => hash(a).localeCompare(hash(b))),
    adoptedProvenanceDigest: d.provenanceDigest,
    dependencyDigest: "0".repeat(64),
  });
  snapshot.dependencyDigest = wineCopyDependencyDigest(snapshot);
  return { snapshot, claims: selected.map((c) => structuredClone(c.claim)) };
}
