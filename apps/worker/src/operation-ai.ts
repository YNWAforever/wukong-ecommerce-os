import {
  FakeListingProvider,
  OpenAIListingProvider,
  OpenRouterListingProvider,
  OpenCodeGoListingProvider,
  ProviderApiError,
  EXTRACTION_PROMPT,
  GENERATION_PROMPT,
  type ListingAIProvider,
  type PhysicalInvocationObserver,
} from "@wukong/ai";
import {
  paidListingReservation,
  workspaceProfileSchema,
  LISTING_PROMPT_VERSIONS,
} from "@wukong/core";
import type { Database, ListingOperation } from "@wukong/db";
import type { WorkerEnv } from "./worker-env.js";

/** Every physical call gets its own committed pending row before network I/O. */
export function operationAI(
  database: Database,
  env: WorkerEnv,
  workspaceId: string,
  run: ListingOperation,
): ListingAIProvider {
  if (run.execution.provider === "fake" && env.AI_PROVIDER === "fake")
    return new FakeListingProvider();
  const policy = workspaceProfileSchema.shape.listingAi.parse(
    run.execution.aiPolicy,
  );
  if (
    !policy ||
    policy.provider !== (env.AI_PROVIDER ?? "openai") ||
    env.LISTING_PAID_OPERATIONS_ENABLED !== "true"
  )
    throw new ProviderApiError("Paid listing operations are not configured", {
      category: "missing_configuration",
      retryable: false,
      httpStatus: null,
      providerCode: null,
      requestId: null,
    });
  if (
    JSON.stringify(run.execution.promptVersions) !==
    JSON.stringify(LISTING_PROMPT_VERSIONS)
  )
    throw new ProviderApiError(
      "Accepted prompt versions are unavailable; start a new retry",
      {
        category: "missing_configuration",
        retryable: false,
        httpStatus: null,
        providerCode: null,
        requestId: null,
      },
    );
  paidListingReservation(policy);
  const provider = (stage: "extract" | "generate") => {
    const started = new Map<number, number>();
    const invocationObserver: PhysicalInvocationObserver = async (event) => {
      if (event.outcome === "started") {
        await database.forWorkspace(workspaceId, async (repos) => {
          // Serialize physical-call admission with cancellation and input edits.
          await repos.listings.lockReviewState(run.listingId);
          const current = await repos.pipelineRuns.getCurrentOperation(
            run.listingId,
          );
          if (
            current?.id !== run.id ||
            !["queued", "running"].includes(current.executionState)
          )
            throw new Error("operation no longer active");
          const claimed = await repos.aiRuns.beginInvocation({
            listingId: run.listingId,
            pipelineRunId: run.id,
            task: stage,
            stage,
            callOrdinal: event.ordinal,
            provider: policy.provider,
            model: policy.model,
            promptVersion:
              stage === "extract"
                ? EXTRACTION_PROMPT.version
                : GENERATION_PROMPT.version,
          });
          if (!claimed.claimed)
            throw new ProviderApiError(
              "Physical invocation already recorded; explicit retry required",
              {
                category: "internal",
                retryable: false,
                httpStatus: null,
                providerCode: null,
                requestId: null,
              },
            );
        });
        started.set(event.ordinal, Date.now());
        return;
      }
      const finalized = await database.forWorkspace(workspaceId, (repos) =>
        repos.aiRuns.finalizeInvocation({
          pipelineRunId: run.id,
          stage,
          callOrdinal: event.ordinal,
          status: event.outcome === "response" ? "succeeded" : "failed",
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          estimatedCostUsd:
            event.usage.costUsd === null
              ? null
              : event.usage.costUsd.toFixed(6),
          usageCertainty: event.usage.certainty,
          latencyMs: Math.max(
            0,
            Date.now() - (started.get(event.ordinal) ?? Date.now()),
          ),
          failureCategory:
            event.outcome === "response" ? null : event.diagnostic.category,
          httpStatus: event.diagnostic.httpStatus,
          providerCode: event.diagnostic.providerCode,
          providerRequestId: event.diagnostic.requestId,
        }),
      );
      if (finalized === false)
        throw new ProviderApiError(
          "Physical invocation terminal state was already recorded",
          {
            category: "internal",
            retryable: false,
            httpStatus: null,
            providerCode: null,
            requestId: null,
          },
        );
    };
    const config = {
      model: policy.model,
      maxOutputTokens: policy.maxOutputTokens,
      invocationObserver,
    };
    if (policy.provider === "opencode-go")
      return new OpenCodeGoListingProvider({
        ...config,
        apiKey: env.OPENCODE_GO_API_KEY ?? "",
        sessionId: run.id,
      });
    return policy.provider === "openrouter"
      ? new OpenRouterListingProvider({
          ...config,
          apiKey: env.OPENROUTER_API_KEY ?? "",
        })
      : new OpenAIListingProvider(undefined, {
          ...config,
          pricing: {
            inputUsdPerMillion: policy.inputUsdPerMillion,
            outputUsdPerMillion: policy.outputUsdPerMillion,
          },
          apiKey: env.OPENAI_API_KEY ?? "",
        });
  };
  return {
    extract: (request) => provider("extract").extract(request),
    generate: (request) => provider("generate").generate(request),
  };
}
