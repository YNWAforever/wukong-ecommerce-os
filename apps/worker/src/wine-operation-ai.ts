import {
  WineEnrichmentProvider,
  wineExecutionSnapshotSchema,
  ProviderApiError,
  type WineEnrichmentProviderConfig,
} from "@wukong/ai";
import {
  wineBudgetSnapshotSchema,
  wineEnrichmentPolicySchema,
} from "@wukong/core";
import { wineAcquisitionPolicySchema } from "@wukong/jobs";
import {
  createWineGoStore,
  type Database,
  type ListingOperation,
} from "@wukong/db";
import type { WorkerEnv } from "./worker-env.js";

export type WineOperationAI = Pick<
  WineEnrichmentProvider,
  "extract" | "verify" | "generate" | "check"
>;
export type WineOperationTransport = Pick<
  WineEnrichmentProviderConfig,
  "fetch" | "now" | "timeoutMs"
>;
function denied(message: string): never {
  throw new ProviderApiError(message, {
    category: "internal",
    retryable: false,
    httpStatus: null,
    providerCode: null,
    requestId: null,
  });
}
/** Only consumes immutable accepted policy. Live admission flags must not strand accepted runs. */
export function wineOperationAI(
  database: Pick<Database, "forWorkspace">,
  env: Pick<WorkerEnv, "OPENCODE_GO_API_KEY">,
  workspaceId: string,
  run: ListingOperation,
  transport: WineOperationTransport = {},
): WineOperationAI {
  const e = structuredClone(run.execution);
  const go = wineExecutionSnapshotSchema.parse(e.wineGo);
  const budget = wineBudgetSnapshotSchema.parse(e.wineBudget);
  const policy = wineEnrichmentPolicySchema.parse(e.wineEnrichment);
  const acquisition = wineAcquisitionPolicySchema.parse(e.wineAcquisition);
  const accepted = Date.parse(run.acceptedAt),
    deadline = Date.parse(acquisition.deadlineAt);
  if (
    e.schemaVersion !== 1 ||
    e.flowVersion !== "wine-enrichment-v1" ||
    e.wineMode !== budget.mode ||
    !policy.enabled ||
    (["full", "research"].includes(budget.mode) &&
      acquisition.allowedDomains.length === 0) ||
    !e.wineEnrichment ||
    Object.keys(policy).some((k) => !(k in (e.wineEnrichment as object))) ||
    go.rulesVersion !== policy.rulesVersion ||
    acquisition.rulesVersion !== policy.rulesVersion ||
    acquisition.policyVersion !== policy.policyVersion ||
    JSON.stringify([...acquisition.allowedDomains].sort()) !==
      JSON.stringify([...policy.allowedDomains].sort()) ||
    !Number.isFinite(accepted) ||
    deadline <= accepted ||
    deadline - accepted > 900000 ||
    !workspaceId ||
    !run.id ||
    !Number.isSafeInteger(run.inputRevision) ||
    run.inputRevision < 0
  )
    denied("Invalid accepted wine execution snapshot");
  const coordinates = Object.freeze({
    workspaceId,
    runId: run.id,
    inputRevision: run.inputRevision,
  });
  const store = createWineGoStore(database);
  const now = transport.now ?? Date.now;
  const provider = new WineEnrichmentProvider({
    ...transport,
    apiKey: env.OPENCODE_GO_API_KEY ?? "",
    sessionId: coordinates.runId,
    snapshot: go,
    observerFactory: (coordinate) => {
      const starts = new Map<number, number>();
      return async (event) => {
        if (event.ordinal !== 1 && event.ordinal !== 2)
          denied("Invalid wine invocation ordinal");
        const call = {
          stage: coordinate.stage,
          promptVersion: coordinate.promptVersion,
          callOrdinal: event.ordinal as 1 | 2,
        };
        if (event.outcome === "started") {
          // This promise resolves after COMMIT; HTTP remains outside the transaction.
          if (!(await store.admit(coordinates, call)).claimed)
            denied("Wine physical admission denied; replay is not allowed");
          starts.set(event.ordinal, now());
          return;
        }
        const elapsed = now() - (starts.get(event.ordinal) ?? now());
        if (
          !(await store.finish(coordinates, {
            ...call,
            status: event.outcome === "response" ? "succeeded" : "failed",
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            estimatedCostUsd:
              event.usage.costUsd === null
                ? null
                : event.usage.costUsd.toFixed(6),
            usageCertainty: event.usage.certainty,
            latencyMs: Number.isFinite(elapsed)
              ? Math.max(0, Math.round(elapsed))
              : 0,
            failureCategory:
              event.outcome === "response" ? null : event.diagnostic.category,
            httpStatus: event.diagnostic.httpStatus,
            providerCode: event.diagnostic.providerCode,
            providerRequestId: event.diagnostic.requestId,
            schemaRepairEligible: event.schemaRepairEligible === true,
          }))
        )
          denied("Wine physical terminal state already recorded");
      };
    },
  });
  function bound<
    T extends {
      binding: {
        workspaceId: string;
        operationId: string;
        inputRevision: number;
      };
    },
  >(input: T): T {
    const copy = structuredClone(input),
      b = copy.binding;
    if (
      b.workspaceId !== coordinates.workspaceId ||
      b.operationId !== coordinates.runId ||
      b.inputRevision !== coordinates.inputRevision
    )
      denied("Wine request binding does not match accepted operation");
    return copy;
  }
  return {
    extract: (input) => provider.extract(structuredClone(input)),
    verify: async (input) =>
      provider.verify({ ...input, context: bound(input.context) }),
    generate: async (input) => provider.generate(bound(input)),
    check: async (input) =>
      provider.check({
        request: bound(input.request),
        candidate: structuredClone(input.candidate),
      }),
  };
}
