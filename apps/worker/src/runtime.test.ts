import { describe, expect, it, vi } from "vitest";
import type { Queue, Worker } from "bullmq";
import type { AssetStore } from "@wukong/assets";
import { FakeListingProvider, type ListingAIProvider } from "@wukong/ai";
import type { Database } from "@wukong/db";
import { startListingPipelineWorker } from "./runtime.js";

const provider: ListingAIProvider = { async extract() { throw new Error("not called"); }, async generate() { throw new Error("not called"); } };
const assetStore: AssetStore = { async createUpload() { throw new Error("not called"); }, async createReadUrl() { return { url: "https://assets.test/read", expiresAt: new Date() }; }, async head() { return null; }, async exists() { return false; } };
const database: Database = { async migrate() {}, async close() {}, async forWorkspace() { throw new Error("not called"); } };

describe("startListingPipelineWorker", () => {
  it("fails closed before constructing providers when required runtime config is missing", async () => {
    await expect(startListingPipelineWorker({ databaseUrl: "postgres://test" })).rejects.toThrow(/REDIS_URL is required/);
  });

  it("selects the explicit fake provider for local runs", async () => {
    vi.stubEnv("AI_PROVIDER", "fake");
    const runtime = await startListingPipelineWorker({
      databaseUrl: "postgres://test",
      redisUrl: "redis://test",
      s3Bucket: "bucket",
      databaseFactory: () => database,
      assetStoreFactory: () => assetStore,
      redisFactory: () => ({ quit: vi.fn(async () => "OK") } as never),
      queueFactory: () => ({ close: vi.fn(async () => undefined) } as unknown as Queue),
      workerFactory: () => ({ close: vi.fn(async () => undefined) } as unknown as Worker),
    });
    expect(runtime.dependencies.ai).toBeInstanceOf(FakeListingProvider);
    await runtime.close();
    vi.unstubAllEnvs();
  });
  it("composes injectable database, asset, provider, Redis, queue, and worker seams without network calls", async () => {
    const closeWorker = vi.fn(async () => undefined);
    const closeQueue = vi.fn(async () => undefined);
    const quitRedis = vi.fn(async () => "OK");
    const worker = { close: closeWorker } as unknown as Worker;
    const queue = { add: vi.fn(), close: closeQueue } as unknown as Queue;
    const redis = { quit: quitRedis } as never;
    const runtime = await startListingPipelineWorker({
      databaseUrl: "postgres://test",
      redisUrl: "redis://test",
      s3Bucket: "bucket",
      databaseFactory: () => database,
      assetStoreFactory: () => assetStore,
      providerFactory: () => provider,
      redisFactory: () => redis,
      queueFactory: () => queue,
      workerFactory: () => worker,
    });
    expect(runtime.worker).toBe(worker);
    expect(runtime.queue).toBe(queue);
    await runtime.close();
    expect(closeWorker).toHaveBeenCalledOnce();
    expect(closeQueue).toHaveBeenCalledOnce();
    expect(quitRedis).toHaveBeenCalledOnce();
  });
});