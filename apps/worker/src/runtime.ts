import type { ConnectionOptions, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { AssetStore } from "@wukong/assets";
import { S3AssetStore as DefaultS3AssetStore } from "@wukong/assets";
import type { ListingAIProvider } from "@wukong/ai";
import { FakeListingProvider, OpenAIListingProvider } from "@wukong/ai";
import { createDatabase, type Database, type DatabaseOptions, type WorkspaceRepositories } from "@wukong/db";
import { createListingPipelineWorker, createListingQueue, type ListingQueuePort } from "./index.js";
import type { PipelineDependencies, PipelineRepositories } from "./listing-pipeline.js";

export type ListingWorkerRuntimeConfig = {
  databaseUrl?: string;
  migrationUrl?: string;
  redisUrl?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
  databaseFactory?: (url: string, options: DatabaseOptions) => Database;
  assetStoreFactory?: (bucket: string, config: { region?: string; endpoint?: string }) => AssetStore;
  providerFactory?: () => ListingAIProvider;
  redisFactory?: (url: string) => Redis;
  queueFactory?: (connection: ConnectionOptions) => Queue;
  workerFactory?: (connection: ConnectionOptions, dependencies: PipelineDependencies) => Worker;
};

export type ListingWorkerRuntime = {
  worker: Worker;
  queue: ListingQueuePort;
  dependencies: PipelineDependencies;
  close(): Promise<void>;
};

function required(value: string | undefined, name: string): string {
  const resolved = value ?? process.env[name];
  if (!resolved?.trim()) throw new Error(`${name} is required to start the listing worker`);
  return resolved;
}

function createProvider(config: ListingWorkerRuntimeConfig): ListingAIProvider {
  if (config.providerFactory) return config.providerFactory();
  const provider = process.env.AI_PROVIDER ?? "openai";
  if (provider === "fake") return new FakeListingProvider();
  if (provider !== "openai") throw new Error(`unsupported AI_PROVIDER: ${provider}`);
  required(undefined, "OPENAI_API_KEY");
  return new OpenAIListingProvider();
}
function mapRepositories(repositories: WorkspaceRepositories, assetStore: AssetStore, providerName: string): PipelineRepositories {
  return {
    listings: repositories.listings,
    workspaces: repositories.workspaces,
    pipelineRuns: repositories.pipelineRuns,
    audit: repositories.audit,
    aiRuns: {
      async append(run) {
        await repositories.aiRuns.append({ listingId: run.draftId, ...run, provider: providerName, input: { task: run.task }, output: {}, status: "succeeded" });
      },
    },
    sourceAssets: {
      async listForListing(id) {
        const assets = await repositories.sourceAssets.listForListing(id);
        return assets.map((asset) => ({ id: asset.id, mimeType: typeof asset.metadata === "object" && asset.metadata !== null && typeof (asset.metadata as { mimeType?: unknown }).mimeType === "string" ? (asset.metadata as { mimeType: string }).mimeType : asset.kind, storageKey: asset.storageKey }));
      },
    },
  };
}

export async function startListingPipelineWorker(config: ListingWorkerRuntimeConfig = {}): Promise<ListingWorkerRuntime> {
  const databaseUrl = required(config.databaseUrl, "DATABASE_URL");
  const redisUrl = required(config.redisUrl, "REDIS_URL");
  const bucket = required(config.s3Bucket, "S3_BUCKET");
  const migrationUrl = config.migrationUrl ?? process.env.DATABASE_ADMIN_URL;
  const database = (config.databaseFactory ?? ((url, options) => createDatabase(url, options)))(databaseUrl, { migrationUrl: migrationUrl });
  if (migrationUrl) await database.migrate();
  const assetStore = (config.assetStoreFactory ?? ((name, options) => DefaultS3AssetStore.fromConfig(name, { region: options.region, endpoint: options.endpoint })))(bucket, { region: config.s3Region ?? process.env.AWS_REGION, endpoint: config.s3Endpoint ?? process.env.S3_ENDPOINT });
  const provider = createProvider(config);
  const providerName = process.env.AI_PROVIDER === "fake" ? "fake" : "openai";
  const redis = (config.redisFactory ?? ((url) => new Redis(url, { maxRetriesPerRequest: null })))(redisUrl);
  const dependencies: PipelineDependencies = {
    async withWorkspace<T>(workspaceId: string, work: (repositories: PipelineRepositories) => Promise<T>) {
      return database.forWorkspace(workspaceId, async (repositories) => work(mapRepositories(repositories, assetStore, providerName)));
    },
    async assetInputs(assets) {
      return Promise.all(assets.map(async (asset) => { const read = await assetStore.createReadUrl(asset.storageKey.split("/")[1] ?? "", asset.storageKey); return { id: asset.id, mimeType: asset.mimeType, readUrl: read.url }; }));
    },
    ai: provider,
  };
  const queue = config.queueFactory ? config.queueFactory(redis as unknown as ConnectionOptions) : createListingQueue(redis as unknown as ConnectionOptions);
  const worker = config.workerFactory ? config.workerFactory(redis as unknown as ConnectionOptions, dependencies) : createListingPipelineWorker(redis as unknown as ConnectionOptions, dependencies);
  return {
    worker,
    queue,
    dependencies,
    async close() { await worker.close(); await queue.close(); await redis.quit(); await database.close(); },
  };
}