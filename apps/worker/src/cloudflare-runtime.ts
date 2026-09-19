import { wineRuntimeConfiguration } from "./wine-runtime-configuration.js";
import { wineCapabilitySchema } from "@wukong/jobs";
import { operationAI } from "./operation-ai.js";
import { productImagePublicationForDelivery } from "./shopline-runtime.js";
import { createHash } from "node:crypto";
import type { ProductShotPipelineDeps } from "./product-shot-pipeline.js";
import {
  S3AssetStore,
  readS3RuntimeConfig,
  type AssetStore,
} from "@wukong/assets";
import {
  WINE_EXECUTION_SNAPSHOT,
  FakeListingProvider,
  PhotoroomProductShotProvider,
  PHOTOROOM_ESTIMATED_COST_USD,
  ProductShotProviderError,
  OpenAIListingProvider,
  OpenRouterListingProvider,
  type ListingAIProvider,
} from "@wukong/ai";
import {
  createDatabase,
  type Database,
  type WorkspaceRepositories,
} from "@wukong/db";

import type {
  PipelineDependencies,
  PipelineRepositories,
} from "./listing-pipeline.js";
import { resolveListingImageUrls } from "./image-resolver.js";
import type { WorkerEnv } from "./worker-env.js";

export type CloudflareRuntime = {
  database: Database;
  dependencies: PipelineDependencies;
  resolveImageUrls(
    workspaceId: string,
    draftId: string,
    imageAssetIds: readonly string[],
    versionId?: string,
    scopedRepositories?: Pick<
      WorkspaceRepositories,
      "sourceAssets" | "productShots"
    >,
  ): Promise<readonly string[]>;
  close(): Promise<void>;
};

export type CloudflareRuntimeConfig = {
  databaseFactory?: (env: WorkerEnv) => Database;
  assetStoreFactory?: (env: WorkerEnv) => AssetStore;
  providerFactory?: (env: WorkerEnv) => ListingAIProvider;
};

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

export function createWorkerDatabase(env: WorkerEnv): Database {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString?.trim()) {
    throw new Error("HYPERDRIVE binding is required");
  }
  return createDatabase(connectionString, { maxConnections: 5 });
}

export function createAssetStore(env: WorkerEnv): AssetStore {
  const storage = readS3RuntimeConfig({
    S3_BUCKET: env.S3_BUCKET,
    S3_ENDPOINT: env.S3_ENDPOINT,
    S3_REGION: env.S3_REGION,
    S3_FORCE_PATH_STYLE: env.S3_FORCE_PATH_STYLE,
    S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
  });
  return S3AssetStore.fromConfig(storage.bucket, storage.client);
}

function createProvider(env: WorkerEnv): ListingAIProvider {
  const provider = env.AI_PROVIDER ?? "openai";
  if (provider === "fake") return new FakeListingProvider();
  if (provider === "opencode-go")
    throw new Error(
      "OpenCode Go requires an immutable listing operation; start a new retry",
    );
  if (provider === "openrouter") {
    return new OpenRouterListingProvider({
      apiKey: required(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY"),
      model: required(env.OPENROUTER_LISTING_MODEL, "OPENROUTER_LISTING_MODEL"),
    });
  }
  if (provider !== "openai") throw new Error("unsupported AI provider");
  return new OpenAIListingProvider(undefined, {
    apiKey: required(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
  });
}

function mapRepositories(
  repositories: WorkspaceRepositories,
  providerName: string,
): PipelineRepositories {
  return {
    operations: {
      async reusableExtraction(run) {
        if (!run.retryOfRunId || !run.execution.promptVersions) return null;
        const parent = await repositories.pipelineRuns.getOperation(
          run.retryOfRunId,
        );
        const digest = (
          run.execution.input as { inputDigest?: string } | undefined
        )?.inputDigest;
        if (
          !parent ||
          parent.listingId !== run.listingId ||
          !digest ||
          digest !==
            (parent.execution.input as { inputDigest?: string } | undefined)
              ?.inputDigest ||
          JSON.stringify(parent.execution.aiPolicy) !==
            JSON.stringify(run.execution.aiPolicy) ||
          JSON.stringify(parent.execution.promptVersions) !==
            JSON.stringify(run.execution.promptVersions)
        )
          return null;
        const checkpoint = (
          await repositories.pipelineRuns.getState(parent.idempotencyKey)
        )?.steps.get("extracted");
        return checkpoint?.state === "completed" ? checkpoint.output : null;
      },
      retainCandidate: (id, candidate) =>
        repositories.pipelineRuns.retainOperationCandidate(id, candidate),
      get: (id) => repositories.pipelineRuns.getOperation(id),
      async matches(run) {
        await repositories.listings.lockReviewState(run.listingId);
        const listing = await repositories.listings.getById(run.listingId);
        const current = await repositories.pipelineRuns.getCurrentOperation(
          run.listingId,
        );
        return Boolean(
          listing &&
          listing.inputRevision === run.inputRevision &&
          listing.activeVersionId === run.baseVersionId &&
          current?.id === run.id &&
          ["queued", "running"].includes(current.executionState),
        );
      },
      mark: (...args) => repositories.pipelineRuns.setOperationState(...args),
    },
    listings: repositories.listings,
    workspaces: repositories.workspaces,
    pipelineRuns: repositories.pipelineRuns,
    audit: repositories.audit,
    aiRuns: {
      async append(run) {
        await repositories.aiRuns.append({
          listingId: run.draftId,
          ...run,
          provider: providerName,
          input: { task: run.task },
          output: {},
          status: "succeeded",
        });
      },
    },
    sourceAssets: {
      async listForListing(id) {
        const assets = await repositories.sourceAssets.listForListing(id);
        return assets.map((asset) => ({
          id: asset.id,
          mimeType:
            typeof asset.metadata === "object" &&
            asset.metadata !== null &&
            typeof (asset.metadata as { mimeType?: unknown }).mimeType ===
              "string"
              ? (asset.metadata as { mimeType: string }).mimeType
              : asset.kind,
          storageKey:
            typeof (asset.metadata as { normalizedStorageKey?: unknown } | null)
              ?.normalizedStorageKey === "string"
              ? (asset.metadata as { normalizedStorageKey: string })
                  .normalizedStorageKey
              : asset.storageKey,
        }));
      },
    },
  };
}

export function createCloudflareRuntime(
  env: WorkerEnv,
  config: CloudflareRuntimeConfig = {},
): CloudflareRuntime {
  const assetStore = (config.assetStoreFactory ?? createAssetStore)(env);
  const ai = config.providerFactory
    ? config.providerFactory(env)
    : {
        extract: (request: Parameters<ListingAIProvider["extract"]>[0]) =>
          createProvider(env).extract(request),
        generate: (request: Parameters<ListingAIProvider["generate"]>[0]) =>
          createProvider(env).generate(request),
      };
  const database = (config.databaseFactory ?? createWorkerDatabase)(env);
  const providerName = env.AI_PROVIDER ?? "openai";
  const dependencies: PipelineDependencies = {
    aiForOperation: (workspaceId, run) =>
      operationAI(database, env, workspaceId, run),
    settleOperation: async (workspaceId, runId) => {
      await database.forWorkspace(workspaceId, (repos) =>
        repos.aiBudgetReservations.settleFromInvocations(runId),
      );
    },
    async withWorkspace<T>(
      workspaceId: string,
      work: (repositories: PipelineRepositories) => Promise<T>,
    ): Promise<T> {
      return database.forWorkspace(workspaceId, async (repositories) =>
        work(mapRepositories(repositories, providerName)),
      );
    },
    async assetInputs(assets) {
      return Promise.all(
        assets.map(async (asset) => {
          const workspaceId = asset.storageKey.split("/")[1] ?? "";
          const read = await assetStore.createReadUrl(
            workspaceId,
            asset.storageKey,
          );
          return { id: asset.id, mimeType: asset.mimeType, readUrl: read.url };
        }),
      );
    },
    ai,
  };

  return {
    database,
    dependencies,
    resolveImageUrls: (
      workspaceId,
      draftId,
      imageAssetIds,
      versionId,
      scopedRepositories,
    ) => {
      const resolve = async (
        repositories: Pick<
          WorkspaceRepositories,
          "sourceAssets" | "productShots"
        >,
      ) =>
        resolveListingImageUrls({
          workspaceId,
          draftId,
          imageAssetIds,
          publication: await productImagePublicationForDelivery(repositories, {
            listingId: draftId,
            versionId,
            provider: env.PRODUCT_SHOT_PROVIDER,
          }),
          sourceAssets: repositories.sourceAssets,
          assetStore,
        });
      return scopedRepositories
        ? resolve(scopedRepositories)
        : database.forWorkspace(workspaceId, resolve);
    },
    close: () => database.close(),
  };
}

function safeBuildSha(value: string | undefined) {
  return /^[a-f0-9]{7,40}$/.test(value?.trim() ?? "")
    ? value!.trim()
    : "unknown";
}
// Task8c: real local Queue/HTTP copy and full-mode dispatch are verified; admission flags remain separate.
export const WINE_CONSUMER_SUPPORTED = true;
export function workerHealth(env: WorkerEnv) {
  return {
    aiProvider: ["fake", "openai", "openrouter", "opencode-go"].includes(
      env.AI_PROVIDER ?? "openai",
    )
      ? (env.AI_PROVIDER ?? "openai")
      : "unknown",
    productShotProvider: ["disabled", "fake", "photoroom"].includes(
      env.PRODUCT_SHOT_PROVIDER ?? "disabled",
    )
      ? (env.PRODUCT_SHOT_PROVIDER ?? "disabled")
      : "unknown",
    buildSha: safeBuildSha(env.BUILD_SHA),
    adapterMode:
      env.SHOPLINE_ADAPTER === "mock" || env.SHOPLINE_ADAPTER === "real"
        ? env.SHOPLINE_ADAPTER
        : "disabled",
    bindings: {
      hyperdrive: Boolean(env.HYPERDRIVE?.connectionString),
      listingQueue: typeof env.LISTING_QUEUE?.send === "function",
      shoplineQueue: typeof env.SHOPLINE_QUEUE?.send === "function",
      ingressSecret: Boolean(env.QUEUE_INGRESS_SECRET?.trim()),
    },
  } as const;
}

type HealthDeps = {
  createDatabase?: (env: WorkerEnv) => Database;
};

export async function authenticatedWorkerHealth(
  env: WorkerEnv,
  deps: HealthDeps = {},
) {
  const create = deps.createDatabase ?? createWorkerDatabase;
  let hyperdriveConnects = false;
  let listingRecoveryReady = false;
  let wineDatabaseReady = false;
  let wineRuntimeDatabaseReady = false;
  let database: Database | undefined;
  try {
    database = create(env);
    await database.ping();
    hyperdriveConnects = true;
    listingRecoveryReady =
      (await database.inspectListingRecoveryCompatibility?.())?.ready === true;
    const wine = await database.inspectWineEnrichmentCompatibility?.();
    const runtime = await database.inspectWineRuntimeCompatibility?.();
    wineRuntimeDatabaseReady =
      runtime?.ready === true && runtime.version === "wine-runtime-0043-v1";
    wineDatabaseReady =
      wine?.ready === true && wine.version === "wine-enrichment-0042-v1";
  } catch {
    // A health probe reports the failure; it must never propagate it, or the
    // caller learns "the worker is down" instead of "the database is down".
    hyperdriveConnects = false;
  } finally {
    await database?.close().catch(() => undefined);
  }
  return {
    ...workerHealth(env),
    authenticated: true,
    fullResearchConfigured:
      wineRuntimeConfiguration(env).fullResearchConfigured,
    wineRuntime: {
      ...wineRuntimeConfiguration(env),
      databaseReady: wineRuntimeDatabaseReady,
    },
    checks: { hyperdriveConnects, listingRecoveryReady },
    wine: wineCapabilitySchema.parse({
      schemaVersion: 1,
      execution: WINE_EXECUTION_SNAPSHOT,
      databaseSchemaVersion: "wine-enrichment-0042-v1",
      buildSha: safeBuildSha(env.BUILD_SHA),
      consumerSupported: WINE_CONSUMER_SUPPORTED,
      goConfigured: Boolean(env.OPENCODE_GO_API_KEY?.trim()),
      tavilyConfigured: Boolean(env.TAVILY_API_KEY?.trim()),
      queueReady: typeof env.LISTING_QUEUE?.send === "function",
      databaseReady:
        hyperdriveConnects &&
        listingRecoveryReady &&
        wineDatabaseReady &&
        wineRuntimeDatabaseReady,
    }),
  } as const;
}

export function readProductShotRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
): { providerName: "disabled" | "fake" | "photoroom"; dailyLimit: number } {
  const providerName = env.PRODUCT_SHOT_PROVIDER?.trim() || "disabled";
  if (
    providerName !== "disabled" &&
    providerName !== "fake" &&
    providerName !== "photoroom"
  )
    throw new Error("PRODUCT_SHOT_PROVIDER is invalid");
  const budget = env.PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY?.trim();
  const dailyLimit = budget
    ? Number(budget)
    : providerName === "fake"
      ? 100
      : 0;
  if (
    (budget || providerName === "photoroom") &&
    (!Number.isSafeInteger(dailyLimit) ||
      dailyLimit <= 0 ||
      dailyLimit > 2_147_483_647)
  )
    throw new Error(
      "PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY must be an integer from 1 to 2147483647",
    );
  if (providerName === "photoroom")
    required(env.PHOTOROOM_API_KEY, "PHOTOROOM_API_KEY");
  return { providerName, dailyLimit };
}

/** Image consumption never constructs a listing AI provider. */
export function createProductShotRuntime(
  env: WorkerEnv,
  config: CloudflareRuntimeConfig = {},
) {
  const syntheticScenariosRaw = (
    env as WorkerEnv & { PRODUCT_SHOT_SYNTHETIC_SCENARIO?: string }
  ).PRODUCT_SHOT_SYNTHETIC_SCENARIO?.trim();
  if (
    syntheticScenariosRaw &&
    (env.PRODUCT_SHOT_PROVIDER !== "fake" || env.BUILD_SHA !== "local-e2e")
  )
    throw new Error("PRODUCT_SHOT_SYNTHETIC_SCENARIO is test-only");
  let syntheticScenarios: Record<
    string,
    "definitive_failure" | "ambiguous_completion"
  > = {};
  if (syntheticScenariosRaw) {
    const parsed: unknown = JSON.parse(syntheticScenariosRaw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("PRODUCT_SHOT_SYNTHETIC_SCENARIO is invalid");
    for (const [sourceDigest, scenario] of Object.entries(parsed)) {
      if (
        !/^[a-f0-9]{64}$/.test(sourceDigest) ||
        !["definitive_failure", "ambiguous_completion"].includes(
          String(scenario),
        )
      )
        throw new Error("PRODUCT_SHOT_SYNTHETIC_SCENARIO is invalid");
      syntheticScenarios[sourceDigest] = scenario as
        "definitive_failure" | "ambiguous_completion";
    }
  }
  const settings = readProductShotRuntimeConfig({
    PRODUCT_SHOT_PROVIDER: env.PRODUCT_SHOT_PROVIDER,
    PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY:
      env.PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY,
    PHOTOROOM_API_KEY: env.PHOTOROOM_API_KEY,
  });
  const assetStore = (config.assetStoreFactory ?? createAssetStore)(env);
  const database = (config.databaseFactory ?? createWorkerDatabase)(env);
  const dependencies: ProductShotPipelineDeps = {
    ...settings,
    estimatedCostUsd:
      settings.providerName === "photoroom" ? PHOTOROOM_ESTIMATED_COST_USD : 0,
    assetStore,
    forWorkspace: database.forWorkspace.bind(database),
    now: () => new Date(),
    providerFor(identity) {
      if (settings.providerName === "disabled")
        throw new Error("product_shot_disabled");
      if (
        identity.providerVersion !== `${settings.providerName}:1.0.0` ||
        identity.renderVersion !== "white-v1"
      )
        throw new ProductShotProviderError("rejected");
      if (settings.providerName === "fake")
        return {
          async generateProductShot() {
            const syntheticScenario = syntheticScenarios[identity.sourceDigest];
            if (syntheticScenario === "definitive_failure")
              throw new ProductShotProviderError("rejected");
            if (syntheticScenario === "ambiguous_completion")
              throw new ProductShotProviderError("outcome_unknown");
            return {
              cutoutPng: new Uint8Array(
                Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAgCAYAAAAbifjMAAAAKUlEQVR4nGPQCKhgoAQzDE8D/hPAowaMGjBqwKgBowaMLAMYSMHDwAAAzPqfX45/w+sAAAAASUVORK5CYII=",
                  "base64",
                ),
              ),
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                estimatedCostUsd: 0,
                latencyMs: 0,
                model: "fake-product-shot",
                promptVersion: "1.0.0",
              },
            };
          },
        };
      return new PhotoroomProductShotProvider({
        apiKey: required(env.PHOTOROOM_API_KEY, "PHOTOROOM_API_KEY"),
        fetch: globalThis.fetch,
        now: Date.now,
        async readSource(assetId) {
          if (assetId !== identity.sourceAssetId)
            throw new ProductShotProviderError("rejected");
          const [asset] = await database.forWorkspace(
            identity.workspaceId,
            (r) => r.sourceAssets.getByIds([assetId]),
          );
          if (
            !asset ||
            asset.listingId !== identity.listingId ||
            asset.workspaceId !== identity.workspaceId
          )
            throw new ProductShotProviderError("rejected");
          const bytes = await assetStore.readObject(
            identity.workspaceId,
            asset.storageKey,
          );
          if (
            createHash("sha256").update(bytes).digest("hex") !==
            identity.sourceDigest
          )
            throw new ProductShotProviderError("rejected");
          return { bytes, mimeType: asset.kind };
        },
      });
    },
  };
  return { dependencies, close: () => database.close() };
}
