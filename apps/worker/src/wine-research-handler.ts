import {
  listingInputDigest,
  type Database,
  type WorkspaceRepositories,
  type StageRecord,
} from "@wukong/db";
import type { QualityIssue } from "@wukong/core";
import { wineAcquisitionPolicySchema } from "@wukong/jobs";
import { createHash } from "node:crypto";
import {
  createWineEvidenceAcquisition,
  wineIdentityQueries,
  type EvidenceRequest,
} from "./wine-evidence-acquisition.js";
import {
  createWineCompleteEvidenceCache,
  type WineCacheOrigin,
} from "./wine-complete-evidence-cache.js";
import { readWineExtractionContext } from "./wine-extraction-handler.js";
import { wineStageDependencyDigest } from "./wine-stage-dependencies.js";
import {
  WINE_STAGE_ORDER,
  parseWineStageResult,
  type WineStageExecutor,
  type WineStageContext,
} from "./wine-enrichment-pipeline.js";
export type WineResearchConfig = Omit<
  Parameters<typeof createWineEvidenceAcquisition>[0],
  "cacheMode"
>;
class ResearchFenceError extends Error {}
function requireValid(value: unknown, code: string): asserts value {
  if (!value) throw new ResearchFenceError(code);
}
const same = (a: unknown, b: unknown) =>
  listingInputDigest(a) === listingInputDigest(b);
function succeeded(record: StageRecord) {
  const wrapper = record.output as {
    schemaVersion?: number;
    fresh?: boolean;
    result?: unknown;
  };
  requireValid(
    record.state === "succeeded" &&
      wrapper?.schemaVersion === 1 &&
      wrapper.fresh === true,
    "research_dependency_invalid",
  );
  const result = parseWineStageResult(wrapper.result, record.stage);
  requireValid(result.state === "succeeded", "research_dependency_invalid");
  return result;
}
async function fence(r: WorkspaceRepositories, c: WineStageContext) {
  requireValid(
    c.schemaVersion === 1 &&
      [
        "search_basic",
        "search_deep",
        "verification",
        "verification_deep",
      ].includes(c.job.stage),
    "research_context_invalid",
  );
  await r.pipelineRuns.lockOperation(c.job.runId);
  const run = await r.pipelineRuns.getOperation(c.job.runId);
  requireValid(
    run &&
      run.id === c.run.id &&
      run.listingId === c.run.listingId &&
      run.listingId === c.job.draftId &&
      run.inputRevision === c.job.inputRevision &&
      run.inputRevision === c.run.inputRevision &&
      run.activeVersionSequence === c.job.activeVersionSequence &&
      run.activeVersionSequence === c.run.activeVersionSequence &&
      run.baseVersionId === c.run.baseVersionId &&
      run.acceptedAt === c.run.acceptedAt &&
      same(run.execution, c.run.execution),
    "research_context_invalid",
  );
  const listing = await r.listings.getById(run.listingId),
    current = await r.pipelineRuns.getCurrentOperation(run.listingId);
  requireValid(
    ["queued", "running"].includes(run.executionState) &&
      listing?.inputRevision === run.inputRevision &&
      listing.activeVersionId === run.baseVersionId &&
      current?.id === run.id,
    "research_operation_stale",
  );
  const prefix: StageRecord[] = [];
  for (const name of WINE_STAGE_ORDER.slice(
    0,
    WINE_STAGE_ORDER.indexOf(c.job.stage),
  )) {
    const record = await r.wineEnrichment.readStage(run.id, name);
    requireValid(
      record &&
        record.runId === run.id &&
        record.inputDigest === run.execution.wineInputDigest &&
        record.dependencyDigest === wineStageDependencyDigest(run, prefix),
      "research_dependency_invalid",
    );
    succeeded(record);
    prefix.push(record);
  }
  requireValid(
    same(prefix, c.dependencies) &&
      c.dependencyDigest === wineStageDependencyDigest(run, prefix),
    "research_dependency_invalid",
  );
  const stage = await r.wineEnrichment.readStage(run.id, c.job.stage);
  requireValid(
    stage?.state === "started" &&
      stage.inputDigest === run.execution.wineInputDigest &&
      stage.dependencyDigest === c.dependencyDigest,
    "research_checkpoint_invalid",
  );
  if (["search_deep", "verification_deep"].includes(c.job.stage)) {
    const verification = prefix.find((s) => s.stage === "verification")!,
      result = succeeded(verification);
    requireValid(
      result.stage === "verification" &&
        result.needsDeepSearch &&
        same(
          (verification.output as { deepSearchDecision?: unknown })
            .deepSearchDecision,
          {
            schemaVersion: 1,
            required: true,
            reasons: result.deepSearchReasons,
          },
        ),
      "research_deep_not_required",
    );
  }
  const input = await r.listingInputs.getRevision(
      run.listingId,
      run.inputRevision,
    ),
    snapshot = run.execution.input as Record<string, unknown>;
  requireValid(
    input &&
      input.workspaceId === c.job.workspaceId &&
      input.inputDigest === run.execution.wineInputDigest &&
      listingInputDigest(input.sources) === run.execution.wineSourceDigest,
    "research_input_invalid",
  );
  for (const key of [
    "sources",
    "note",
    "workingContent",
    "fieldStates",
  ] as const)
    requireValid(same(input[key], snapshot[key]), "research_input_invalid");
  const p = wineAcquisitionPolicySchema.parse(run.execution.wineAcquisition);
  const coordinates = {
    workspaceId: c.job.workspaceId,
    runId: run.id,
    inputRevision: run.inputRevision,
    policyDigest: p.policyVersion,
    rulesVersion: p.rulesVersion,
    allowedDomains: p.allowedDomains,
  };
  const authorized = await r.wineAcquisition.authorizeAcquisition(coordinates);
  requireValid(authorized, "research_deadline_or_stale");
  return { run, input, now: authorized.now, coordinates };
}
const slots = ["basic_1", "basic_2", "advanced_1", "extract_1"] as const;
/** Exact repository pool plus original extraction provenance and current registry. No new trusted context or claim decision. Requires a genuine started research/verification checkpoint. */
export async function readWineResearchEvidence(
  database: Pick<Database, "forWorkspace">,
  raw: WineStageContext,
) {
  const c = structuredClone(raw);
  await database.forWorkspace(c.job.workspaceId, (r) => fence(r, c));
  const extraction = await readWineExtractionContext(database, c);
  return database.forWorkspace(c.job.workspaceId, async (r) => {
    const f = await fence(r, c);
    const evidence = await r.wineEnrichment.readEvidence(f.run.id),
      authorities = await r.wineEnrichment.readAuthorities();
    const calls = await Promise.all(
      slots.map((slot) => r.wineEnrichment.readSearchCall(f.run.id, slot)),
    );
    requireValid(
      !calls.some(
        (call) =>
          call &&
          (call.status === "started" ||
            call.status === "unknown" ||
            call.credits === null ||
            (call.status === "succeeded" && !call.output)),
      ),
      "research_outcome_unknown",
    );
    // A later reader must not silently replace the evidence represented by a committed search result.
    const previous = c.dependencies
      .filter((s) => s.stage === "search_basic" || s.stage === "search_deep")
      .at(-1);
    if (
      previous &&
      ["verification", "verification_deep"].includes(c.job.stage)
    ) {
      const saved = succeeded(previous);
      requireValid(
        (saved.stage === "search_basic" || saved.stage === "search_deep") &&
          same(
            [...saved.evidence].sort((a, b) => a.id.localeCompare(b.id)),
            [...evidence].sort((a, b) => a.id.localeCompare(b.id)),
          ),
        "research_evidence_checkpoint_invalid",
      );
    }
    await fence(r, c);
    return { ...f, extraction, evidence, authorities, calls };
  });
}
function issue(code: string): QualityIssue {
  return { code, path: "research", evidenceIds: [], blocking: false };
}
function documentId(sourceId: string) {
  const h = createHash("sha256")
    .update(sourceId + "document")
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Server configuration only. Invoke through the coordinator; no caller query, identity, credit or cache override. */
export function createWineResearchHandler(
  config: WineResearchConfig,
): WineStageExecutor {
  return async (raw) => {
    const c = structuredClone(raw),
      stage = c.job.stage;
    try {
      requireValid(
        stage === "search_basic" || stage === "search_deep",
        "research_context_invalid",
      );
      let current = await readWineResearchEvidence(config.database, c);
      const issues: QualityIssue[] = [...current.extraction.issues];
      // Preserve earlier diagnostics even when later acquisition succeeds.
      for (const dependency of c.dependencies) {
        const result = succeeded(dependency);
        if (result.stage !== "extraction" && "issues" in result)
          issues.push(...result.issues);
      }
      let cacheOrigin: WineCacheOrigin | undefined;
      const basic = c.dependencies.find((s) => s.stage === "search_basic");
      if (basic) {
        const result = succeeded(basic);
        if (result.stage === "search_basic") cacheOrigin = result.cacheOrigin;
      }
      const definitiveFailure = Boolean(
        current.calls.some((call) => call?.status === "failed"),
      );
      let partial =
        definitiveFailure ||
        Boolean(basic && (succeeded(basic) as { partial?: boolean }).partial);
      if (definitiveFailure) issues.push(issue("research_definitive_failure"));
      let hit = false;
      if (stage === "search_basic" && !definitiveFailure) {
        const reused = await createWineCompleteEvidenceCache({
          database: config.database,
        }).reuse(c);
        if (reused.status === "hit") {
          cacheOrigin = reused.cacheOrigin;
          hit = true;
        }
      }
      if (!hit && !definitiveFailure) {
        const input: EvidenceRequest = {
          ...current.coordinates,
          identity: current.extraction.context.identity,
          now: current.now,
          forceRefresh: current.run.execution.wineMode === "research",
        };
        let usable = true;
        try {
          wineIdentityQueries(input.identity);
        } catch {
          usable = false;
          partial = true;
          issues.push(issue("public_identity_required"));
        }
        if (usable) {
          const acquire = createWineEvidenceAcquisition({
            ...config,
            cacheMode: "complete_pool",
            fetch: async (...args) => {
              await config.database.forWorkspace(c.job.workspaceId, (r) =>
                fence(r, c),
              );
              return (config.fetch ?? fetch)(...args);
            },
          });
          const acquisition = await acquire(
            input,
            stage === "search_basic"
              ? { stage: "basic", slots: ["basic_1", "basic_2"] }
              : { stage: "deep" },
          );
          issues.push(...acquisition.warnings.map(issue));
          partial ||= acquisition.status !== "complete";
          current = await readWineResearchEvidence(config.database, c);
          requireValid(
            !acquisition.warnings.some((w) =>
              [
                "acquisition_blocked",
                "stale_acquisition",
                "deadline_expired",
                "outcome_unknown",
              ].includes(w),
            ),
            "research_acquisition_blocked",
          );
          // Documents are deterministic children of snippets. Only missing documents may use the one optional batch.
          const newLocations =
            stage === "search_basic"
              ? ["tavily:basic_1", "tavily:basic_2"]
              : ["tavily:advanced_1"];
          const candidates = current.evidence
            .filter(
              (s) =>
                s.kind === "web" &&
                s.contentScope === "snippet" &&
                newLocations.includes(s.location) &&
                !current.evidence.some(
                  (d) =>
                    d.id === documentId(s.id) &&
                    d.contentScope === "document" &&
                    d.excerpt.trim(),
                ),
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, 5);
          if (
            !current.calls.some((call) => call?.slot === "extract_1") &&
            candidates.length
          ) {
            const extra = await acquire(input, {
              stage: "extract",
              sourceIds: candidates.map((s) => s.id),
            });
            issues.push(...extra.warnings.map(issue));
            partial ||= extra.warnings.length > 0;
          }
        }
      }
      current = await readWineResearchEvidence(config.database, c);
      if (!current.evidence.some((s) => s.kind === "web" && s.excerpt.trim())) {
        partial = true;
        issues.push(issue("research_no_web_evidence"));
      }
      const unique = [
        ...new Map(
          issues.map((value) => [listingInputDigest(value), value]),
        ).values(),
      ];
      return {
        schemaVersion: 1,
        stage,
        state: "succeeded",
        evidence: current.evidence,
        partial,
        issues: unique,
        ...(cacheOrigin ? { cacheOrigin } : {}),
      };
    } catch (error) {
      const code =
        error instanceof ResearchFenceError
          ? error.message
          : "research_outcome_unknown";
      return {
        schemaVersion: 1,
        stage,
        state: code === "research_outcome_unknown" ? "unknown" : "blocked",
        code,
      };
    }
  };
}
