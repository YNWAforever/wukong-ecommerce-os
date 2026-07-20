import {
  S3AssetStore,
  readS3RuntimeConfig,
  type AssetStore,
} from "@wukong/assets";
import {
  FakeListingProvider,
  OpenAIListingProvider,
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
import type { WorkerEnv } from "./worker-env.js";

export type CloudflareRuntime = {
  database: Database;
  dependencies: PipelineDependencies;
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

function createAssetStore(env: WorkerEnv): AssetStore {
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
          storageKey: asset.storageKey,
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
  const ai = (config.providerFactory ?? createProvider)(env);
  const database = (config.databaseFactory ?? createWorkerDatabase)(env);
  const providerName = env.AI_PROVIDER === "fake" ? "fake" : "openai";
  const dependencies: PipelineDependencies = {
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
    close: () => database.close(),
  };
}

export function workerHealth(env: WorkerEnv) {
  return {
    buildSha: env.BUILD_SHA?.trim() || "unknown",
    adapterMode: env.SHOPLINE_ADAPTER === "mock" ? "mock" : "disabled",
    bindings: {
      hyperdrive: Boolean(env.HYPERDRIVE?.connectionString),
      listingQueue: typeof env.LISTING_QUEUE?.send === "function",
      shoplineQueue: typeof env.SHOPLINE_QUEUE?.send === "function",
      ingressSecret: Boolean(env.QUEUE_INGRESS_SECRET?.trim()),
    },
  } as const;
}
