import { createHash } from "node:crypto";
import { listingInputDigest } from "@wukong/db";
import {
  decideWineClaim,
  sameWineValue,
  type SupportedClaim,
  type QualityIssue,
} from "@wukong/core";
import type { WineFrozenContext } from "@wukong/ai";
import {
  createWineExtractionHandler,
  type WineExtractionConfig,
} from "./wine-extraction-handler.js";
import {
  createWineResearchHandler,
  readWineResearchEvidence,
  type WineResearchConfig,
} from "./wine-research-handler.js";
import {
  groundWineEvidence,
  type WineGroundingInput,
} from "./wine-evidence-grounding.js";
import { wineOperationAI } from "./wine-operation-ai.js";
import { createWineCompleteEvidenceCache } from "./wine-complete-evidence-cache.js";
import { wineStageDependencyDigest } from "./wine-stage-dependencies.js";
import {
  parseWineStageResult,
  type WineStageExecutor,
  type WineAfterCommit,
} from "./wine-enrichment-pipeline.js";

export type WineVerificationConfig = Pick<
  WineExtractionConfig,
  "database" | "env" | "transport"
>;
const requiredIdentity = [
  "producer",
  "productName",
  "volumeMl",
  "packQuantity",
];
const majorFields = new Set([
  ...requiredIdentity,
  "vintage",
  "abvPercent",
  "cuvee",
  "marketVariant",
  "barcode",
  "batch",
  "brewingYear",
]);
const same = (a: unknown, b: unknown) =>
  listingInputDigest(a) === listingInputDigest(b);
class VerificationFenceError extends Error {}
function requireProof(
  value: unknown,
  code = "verification_context_changed",
): asserts value {
  if (!value) throw new VerificationFenceError(code);
}
function groundingInput(
  read: Awaited<ReturnType<typeof readWineResearchEvidence>>,
): WineGroundingInput {
  const binding = read.extraction.context.binding;
  const assets = read.input.sources
    .filter((s) => s.use === "analyse" && s.role !== "supplier_document")
    .map((s) => ({ id: s.assetId, digest: s.digest }));
  return {
    accepted: {
      binding,
      assets,
      note: read.input.note,
      lockedFields: read.extraction.context.lockedFields,
      verifiedAliases: read.extraction.context.verifiedAliases,
    },
    extraction: { binding, identity: read.extraction.context.identity },
    records: read.evidence.map((source) => ({
      binding,
      assetDigest:
        source.kind === "photo"
          ? (assets.find((a) => a.id === source.assetId)?.digest ?? null)
          : null,
      documentDigest: source.documentDigest,
      source,
    })),
    authorities: read.authorities,
    now: read.now,
  };
}
function adjudicate(c: WineFrozenContext, claim: SupportedClaim) {
  return decideWineClaim({
    identity: c.identity,
    claim: { ...claim, state: "unknown", reason: "untrusted_proposal" },
    sources: c.sources,
    lockedFields: new Set(c.lockedFields),
    context: {
      ...c,
      reliableSourceIds: new Set(c.reliableSourceIds),
      trustedObservationSourceIds: new Set(c.trustedObservationSourceIds),
    },
  });
}
/** Canonical facts come from all independent server supports even when a model omits contrary facts. */
function facts(c: WineFrozenContext): SupportedClaim[] {
  const groups: SupportedClaim[] = [];
  for (const support of c.supports) {
    let group = groups.find(
      (g) => g.field === support.field && sameWineValue(g.value, support.value),
    );
    if (!group) {
      const h = createHash("sha256")
        .update(listingInputDigest([c.binding, support.field, support.value]))
        .digest("hex");
      group = {
        id: `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`,
        field: support.field,
        value: support.value,
        kind: "fact",
        scope: "product",
        evidenceIds: [],
        premiseClaimIds: [],
        state: "unknown",
        reason: "server_support",
      };
      groups.push(group);
    }
    if (!group.evidenceIds.includes(support.sourceId))
      group.evidenceIds.push(support.sourceId);
  }
  return groups.map((g) => adjudicate(c, g));
}
function uniqueIssues(issues: QualityIssue[]) {
  return [...new Map(issues.map((i) => [listingInputDigest(i), i])).values()];
}
/** Requires the coordinator's started checkpoint. Every Go call retains the reviewed durable admission guard. */
export function createWineVerificationHandler(
  config: WineVerificationConfig,
): WineStageExecutor {
  return async (raw) => {
    const c = structuredClone(raw),
      stage = c.job.stage;
    if (stage !== "verification" && stage !== "verification_deep")
      return {
        schemaVersion: 1,
        stage,
        state: "blocked",
        code: "verification_stage_invalid",
      };
    try {
      const read = await readWineResearchEvidence(config.database, c),
        input = groundingInput(read),
        grounded = groundWineEvidence(input);
      const canonical = facts(grounded.context);
      const frozen: WineFrozenContext = {
        ...structuredClone(grounded.context),
        acceptedPremises: canonical.filter(
          (v) =>
            v.state === "accepted" &&
            v.kind === "fact" &&
            v.scope === "product",
        ),
      };
      const verified = await wineOperationAI(
        config.database,
        config.env,
        c.job.workspaceId,
        read.run,
        config.transport,
      ).verify({ context: frozen, stage });
      // Reload after HTTP: cancellation/revision/deadline and registry/evidence changes cannot produce fresh claims.
      const final = await readWineResearchEvidence(config.database, c);
      requireProof(
        same(read.evidence, final.evidence) &&
          same(read.authorities, final.authorities),
      );
      const hints = groundWineEvidence({
        ...input,
        proposals: verified.supportProposals,
      });
      const claims = [...canonical];
      for (const proposal of verified.claims) {
        if (
          claims.some(
            (claim) =>
              claim.field === proposal.field &&
              claim.kind === proposal.kind &&
              claim.scope === proposal.scope &&
              sameWineValue(claim.value, proposal.value),
          )
        )
          continue;
        requireProof(
          !claims.some((claim) => claim.id === proposal.id),
          "verification_claim_id_collision",
        );
        claims.push(adjudicate(frozen, proposal));
      }
      const covered = (field: string) =>
        canonical.some(
          (claim) => claim.field === field && claim.state === "accepted",
        );
      // Operator-owned fields are preserved downstream, never adopted from evidence or treated as missing because locked.
      const missing = requiredIdentity.filter(
        (field) => !covered(field) && !frozen.lockedFields.includes(field),
      );
      const identityGap =
        frozen.identity.status !== "matched" || missing.length > 0;
      const originalIssues = read.extraction.issues;
      const conflict =
        canonical.some(
          (claim) => claim.state === "conflict" && majorFields.has(claim.field),
        ) ||
        [...originalIssues, ...grounded.issues].some(
          (issue) =>
            issue.blocking &&
            /conflict|ambiguous|binding_invalid/.test(issue.code),
        );
      const coreGap =
        !covered("abvPercent") && !frozen.lockedFields.includes("abvPercent");
      const reasons: Array<"identity_gap" | "core_fact_gap" | "conflict"> = [];
      if (stage === "verification") {
        if (identityGap) reasons.push("identity_gap");
        if (
          coreGap &&
          !canonical.some(
            (claim) =>
              claim.field === "abvPercent" && claim.state === "conflict",
          )
        )
          reasons.push("core_fact_gap");
        if (conflict) reasons.push("conflict");
      }
      const issues: QualityIssue[] = [
        ...originalIssues,
        ...grounded.issues,
        ...hints.issues,
      ];
      // Research diagnostics survive; older verification decisions are recomputed from the complete current pool.
      for (const dependency of c.dependencies) {
        if (
          dependency.stage !== "search_basic" &&
          dependency.stage !== "search_deep"
        )
          continue;
        const result = parseWineStageResult(
          (dependency.output as { result: unknown }).result,
          dependency.stage,
        );
        if (result.state === "succeeded" && "issues" in result)
          issues.push(...result.issues.filter((i) => i.path === "research"));
      }
      for (const claim of claims)
        if (claim.state !== "accepted")
          issues.push({
            path: `claims.${claim.id}`,
            code: claim.reason,
            blocking:
              claim.state === "conflict" && majorFields.has(claim.field),
            evidenceIds: claim.evidenceIds,
          });
      if (identityGap)
        issues.push({
          path: "identity",
          code: "verification_identity_unresolved",
          blocking: true,
          evidenceIds: [],
        });
      if (coreGap)
        issues.push({
          path: "identity.abvPercent",
          code: "verification_core_fact_missing",
          blocking: false,
          evidenceIds: [],
        });
      // Provider issue names/booleans are advisory, never paid admission or deterministic needs_info authority.
      issues.push(
        ...verified.issues.map((issue) => ({
          ...issue,
          code: `model_advisory:${issue.code}`,
          blocking: false,
        })),
      );
      return {
        schemaVersion: 1,
        stage,
        state: "succeeded",
        identity: frozen.identity,
        claims,
        needsDeepSearch: reasons.length > 0,
        deepSearchReasons: reasons,
        issues: uniqueIssues(issues),
        frozenVerification: structuredClone(frozen),
      };
    } catch (error) {
      const known =
        error instanceof VerificationFenceError ||
        (error instanceof Error &&
          /^(research|extraction)_[a-z_]+$/.test(error.message));
      return {
        schemaVersion: 1,
        stage,
        state:
          known &&
          !(error instanceof Error && error.message.endsWith("outcome_unknown"))
            ? "blocked"
            : "unknown",
        code:
          known && error instanceof Error
            ? error.message
            : "verification_outcome_unknown",
      };
    }
  };
}
/** Optional cache work; the reviewed publisher independently re-reads ALL committed prerequisites and evidence. */
export function createWineVerificationCacheHook(
  config: Pick<WineVerificationConfig, "database">,
): WineAfterCommit {
  const cache = createWineCompleteEvidenceCache(config);
  return async (raw) => {
    const { context: c, result } = structuredClone(raw);
    if (
      (result.stage !== "verification" &&
        result.stage !== "verification_deep") ||
      result.needsDeepSearch
    )
      return;
    const allowed = await config.database.forWorkspace(
      c.job.workspaceId,
      async (r) => {
        await r.pipelineRuns.lockOperation(c.job.runId);
        const run = await r.pipelineRuns.getOperation(c.job.runId),
          listing = run && (await r.listings.getById(run.listingId)),
          current =
            run && (await r.pipelineRuns.getCurrentOperation(run.listingId));
        if (
          !run ||
          run.id !== c.run.id ||
          !same(run.execution, c.run.execution) ||
          run.inputRevision !== c.job.inputRevision ||
          run.listingId !== c.job.draftId ||
          run.activeVersionSequence !== c.job.activeVersionSequence ||
          run.baseVersionId !== c.run.baseVersionId ||
          run.acceptedAt !== c.run.acceptedAt ||
          !["queued", "running"].includes(run.executionState) ||
          current?.id !== run.id ||
          listing?.inputRevision !== run.inputRevision ||
          listing.activeVersionId !== run.baseVersionId
        )
          return false;
        const persisted = [];
        for (const dependency of c.dependencies) {
          const row = await r.wineEnrichment.readStage(
            run.id,
            dependency.stage,
          );
          if (!row || !same(row, dependency)) return false;
          persisted.push(row);
        }
        const row = await r.wineEnrichment.readStage(run.id, result.stage);
        if (
          !row ||
          row.state !== "succeeded" ||
          row.inputDigest !== run.execution.wineInputDigest ||
          row.dependencyDigest !== c.dependencyDigest ||
          row.dependencyDigest !== wineStageDependencyDigest(run, persisted) ||
          !same(row.output, { schemaVersion: 1, fresh: true, result })
        )
          return false;
        const policy = run.execution.wineAcquisition as { deadlineAt: string };
        return (
          Date.parse(await r.pipelineRuns.acceptanceTimestamp()) <
          Date.parse(policy.deadlineAt)
        );
      },
    );
    if (!allowed) return { code: "post_commit_skipped" };
    const published = await cache.publish({
      workspaceId: c.job.workspaceId,
      runId: c.run.id,
    });
    if (published.status === "skipped")
      return {
        code:
          published.code === "cache_pool_oversized"
            ? "post_commit_oversized"
            : "post_commit_skipped",
      };
  };
}
/** Evidence-stage composition only. Runtime activation and ownership-dependent generation/check remain separate. */
export function createWineEvidenceStageHandlers(
  config: WineExtractionConfig & Omit<WineResearchConfig, "database">,
) {
  const extraction = createWineExtractionHandler(config),
    research = createWineResearchHandler(config),
    verification = createWineVerificationHandler(config);
  const execute: WineStageExecutor = async (c) => {
    switch (c.job.stage) {
      case "extraction":
        return extraction(c);
      case "search_basic":
      case "search_deep":
        return research(c);
      case "verification":
      case "verification_deep":
        return verification(c);
      default:
        return {
          schemaVersion: 1,
          stage: c.job.stage,
          state: "blocked",
          code:
            c.job.stage === "generation"
              ? "generation_ownership_unavailable"
              : c.job.stage === "quality_check"
                ? "quality_handler_unavailable"
                : "candidate_projection_unavailable",
        };
    }
  };
  return { execute, afterCommit: createWineVerificationCacheHook(config) };
}
