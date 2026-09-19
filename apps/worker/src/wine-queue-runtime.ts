import { wineRuntimeConfiguration } from "./wine-runtime-configuration.js";
import { MAX_ASSET_SIZE, type AssetStore } from "@wukong/assets";
import type { Database } from "@wukong/db";
import { wineListingJobSchema, type WineListingJob } from "@wukong/jobs";
import {
  createWorkerDatabase,
  createAssetStore,
} from "./cloudflare-runtime.js";
import { createWineEvidenceStageHandlers } from "./wine-verification-handler.js";
import { createWineGenerationHandler } from "./wine-generation-handler.js";
import { createWineStageStore } from "./wine-enrichment-runtime.js";
import { projectWineCandidate } from "./wine-candidate-projection.js";
import { runWineStage } from "./wine-enrichment-pipeline.js";
import type { WineExtractionConfig } from "./wine-extraction-handler.js";
import type { WineOperationTransport } from "./wine-operation-ai.js";
import type { WorkerEnv } from "./worker-env.js";
export type WineQueueRuntimeConfig = {
  databaseFactory?: (env: WorkerEnv) => Database;
  assetStoreFactory?: (env: WorkerEnv) => AssetStore;
  transport?: WineOperationTransport;
  acquisitionFetch?: typeof fetch;
  now?: () => Date;
};
function required(value: string | undefined) {
  if (!value?.trim()) throw Error("wine_runtime_configuration_missing");
  return value;
}
/** Per-delivery runtime. Configuration flags affect admission, never accepted-run draining. */
export function createWineQueueRuntime(
  env: WorkerEnv,
  config: WineQueueRuntimeConfig = {},
) {
  const database = (config.databaseFactory ?? createWorkerDatabase)(env);
  let assets: AssetStore | undefined;
  const extraction: WineExtractionConfig = {
    database,
    env,
    transport: config.transport,
    async resolveImage(asset, binding) {
      assets ??= (config.assetStoreFactory ?? createAssetStore)(env);
      if (!assets.createWineImageSnapshot)
        throw Error("wine_snapshot_unavailable");
      const bytes = await assets.readObject(
        asset.workspaceId,
        asset.storageKey,
        { maxBytes: MAX_ASSET_SIZE },
      );
      return assets.createWineImageSnapshot({
        workspaceId: asset.workspaceId,
        runId: binding.runId,
        assetId: asset.id,
        expectedDigest: binding.digest,
        bytes,
        mimeType: asset.kind,
      });
    },
  };
  const generation = createWineGenerationHandler(extraction);
  let research: ReturnType<typeof createWineEvidenceStageHandlers> | undefined;
  function researchHandlers() {
    const ready = wineRuntimeConfiguration(env);
    if (
      (!config.assetStoreFactory && !ready.storageConfigured) ||
      !ready.documentConfigured
    )
      throw Error("wine_runtime_configuration_missing");
    return (research ??= createWineEvidenceStageHandlers({
      ...extraction,
      tavilyApiKey: required(env.TAVILY_API_KEY),
      websiteFetchBaseUrl: required(env.WEBSITE_FETCH_BASE_URL),
      queueSecret: required(env.QUEUE_INGRESS_SECRET),
      fetch: config.acquisitionFetch,
      now: config.now,
    }));
  }
  const store = createWineStageStore(database, {
    projectCandidate: projectWineCandidate,
    now: config.now,
  });
  return {
    database,
    async deliver(raw: WineListingJob) {
      const job = wineListingJobSchema.parse(raw);
      // Fail configuration before claiming a stage; Queue retry cannot manufacture an unknown paid call.
      const run = await database.forWorkspace(job.workspaceId, (r) =>
        r.pipelineRuns.getOperation(job.runId),
      );
      if (
        run?.execution.flowVersion === "wine-enrichment-v1" &&
        ["queued", "running"].includes(run.executionState)
      ) {
        required(env.OPENCODE_GO_API_KEY);
        if (["full", "research"].includes(String(run.execution.wineMode)))
          researchHandlers();
      }
      const outcome = await runWineStage(job, {
        store,
        execute: (c) =>
          ["copy", "section"].includes(String(c.run.execution.wineMode))
            ? generation(c)
            : researchHandlers().execute(c),
        afterCommit: (c) =>
          ["copy", "section"].includes(String(c.context.run.execution.wineMode))
            ? Promise.resolve()
            : researchHandlers().afterCommit(c),
      });
      // Durable outbox remains owed if send/mark fails. Redelivery runs only duplicate handling.
      if (outcome.status === "advanced" || outcome.status === "duplicate") {
        const rows = await database.forWorkspace(job.workspaceId, (r) =>
          r.dispatchOutbox.pending({
            olderThanSeconds: 0,
            maxRows: 10,
            wineRunId: job.runId,
          }),
        );
        for (const row of rows) {
          const next = wineListingJobSchema.parse(row.payload);
          if (next.workspaceId !== job.workspaceId || next.runId !== job.runId)
            throw Error("wine_outbox_binding_invalid");
          try {
            await env.LISTING_QUEUE.send(next);
          } catch {
            await database.forWorkspace(job.workspaceId, (r) =>
              r.dispatchOutbox.markAttempted([row.id]),
            );
            throw Error("wine_outbox_send_failed");
          }
          await database.forWorkspace(job.workspaceId, (r) =>
            r.dispatchOutbox.markDispatched([row.id]),
          );
        }
      }
      return outcome;
    },
    close: () => database.close(),
  };
}
