import { listingInputDigest, WineEvidenceAuthorizationError } from "@wukong/db";
import {
  wineGenerationCandidateSchema,
  WineArtifactValidationError,
} from "@wukong/core";
import type { WineExtractionConfig } from "./wine-extraction-handler.js";
import type { WineStageExecutor } from "./wine-enrichment-pipeline.js";
import { wineOperationAI } from "./wine-operation-ai.js";
import {
  readWineGenerationRequest,
  authorizeWineFrozenQuality,
  committedGeneration,
  WineGenerationFenceError,
} from "./wine-generation-context.js";
export type WineGenerationConfig = Pick<
  WineExtractionConfig,
  "database" | "env" | "transport"
>;
/** Actual Go generation and mandatory quality. There is no rewriting loop or fallback.
 * Returned artifacts are uncommitted proposals: callers MUST use createWineStageStore.finish,
 * which reauthorizes after HTTP under registry serialization before adoption/next-stage outbox.
 * Keeping that check at the commit boundary preserves inspectable stale provider responses. */
export function createWineGenerationHandler(
  config: WineGenerationConfig,
): WineStageExecutor {
  return async (raw) => {
    const c = structuredClone(raw),
      stage = c.job.stage;
    if (stage !== "generation" && stage !== "quality_check")
      return {
        schemaVersion: 1,
        stage,
        state: "blocked",
        code: "generation_stage_invalid",
      };
    try {
      const { request } = await readWineGenerationRequest(config.database, c);
      const ai = wineOperationAI(
        config.database,
        config.env,
        c.job.workspaceId,
        c.run,
        config.transport,
      );
      if (stage === "generation") {
        const result = await ai.generate(request);
        const candidate = wineGenerationCandidateSchema.parse({
          schemaVersion: result.schemaVersion,
          content: result.content,
          annotations: result.annotations,
        });
        const output = {
          schemaVersion: 1 as const,
          stage,
          state: "succeeded" as const,
          content: candidate.content,
          issues: [],
          frozenQuality: { schemaVersion: 1 as const, request, candidate },
        };
        return output;
      }
      const frozen = authorizeWineFrozenQuality(
        committedGeneration(c),
        request,
      );
      const checked = await ai.check(frozen);
      return {
        schemaVersion: 1,
        stage,
        state: "succeeded",
        contentDigest: listingInputDigest(frozen.candidate.content),
        issues: checked.issues,
        outcome: checked.issues.some((i) => i.blocking)
          ? "needs_info"
          : "ready",
      };
    } catch (error) {
      const known =
        error instanceof WineGenerationFenceError ||
        error instanceof WineEvidenceAuthorizationError ||
        error instanceof WineArtifactValidationError ||
        (error instanceof Error && error.name === "ZodError");
      return {
        schemaVersion: 1,
        stage,
        state: known ? "blocked" : "unknown",
        code:
          error instanceof WineGenerationFenceError ||
          error instanceof WineEvidenceAuthorizationError
            ? error.message
            : known
              ? "generation_artifact_invalid"
              : "generation_outcome_unknown",
      };
    }
  };
}
