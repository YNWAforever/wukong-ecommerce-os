import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queue, Worker } from "bullmq";
import type { AssetStore } from "@wukong/assets";
import { FakeListingProvider, type ListingAIProvider } from "@wukong/ai";
import type { Database } from "@wukong/db";
import { startListingPipelineWorker } from "./runtime.js";

const provider: ListingAIProvider = {
  async extract() {
    throw new Error("not called");
  },
  async generate() {
    throw new Error("not called");
  },
};
const assetStore: AssetStore = {
  async createUpload() {
    throw new Error("not called");
  },
  async createReadUrl() {
    return { url: "https://assets.test/read", expiresAt: new Date() };
  },
  async head() {
    return null;
  },
  async exists() {
    return false;
  },
};
const database = {
  migrate: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  forWorkspace: async () => {
    throw new Error("not called");
  },
} satisfies Database;

function stubS3RuntimeEnv() {
  vi.stubEnv("S3_BUCKET", "wukong-opak-prod-assets");
  vi.stubEnv("S3_ENDPOINT", "https://account.r2.cloudflarestorage.com");
  vi.stubEnv("S3_REGION", "auto");
  vi.stubEnv("S3_ACCESS_KEY_ID", "access-key");
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "secret-key");
  vi.stubEnv("S3_FORCE_PATH_STYLE", "false");
}

describe("startListingPipelineWorker", () => {
  beforeEach(() => {
    stubS3RuntimeEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("fails closed before constructing providers when required runtime config is missing", async () => {
    await expect(
      startListingPipelineWorker({ databaseUrl: "postgres://test" }),
    ).rejects.toThrow(/REDIS_URL is required/);
  });

  it("selects the explicit fake provider for local runs", async () => {
    vi.stubEnv("AI_PROVIDER", "fake");
    const runtime = await startListingPipelineWorker({
      databaseUrl: "postgres://test",
      redisUrl: "redis://test",
      databaseFactory: () => database,
      assetStoreFactory: () => assetStore,
      redisFactory: () => ({ quit: vi.fn(async () => "OK") }) as never,
      queueFactory: () =>
        ({ close: vi.fn(async () => undefined) }) as unknown as Queue,
      workerFactory: () =>
        ({ close: vi.fn(async () => undefined) }) as unknown as Worker,
    });
    expect(runtime.dependencies.ai).toBeInstanceOf(FakeListingProvider);
    await runtime.close();
  });

  it("composes injectable database, asset, provider, Redis, queue, and worker seams without migrations", async () => {
    const closeWorker = vi.fn(async () => undefined);
    const closeQueue = vi.fn(async () => undefined);
    const quitRedis = vi.fn(async () => "OK");
    const worker = { close: closeWorker } as unknown as Worker;
    const queue = { add: vi.fn(), close: closeQueue } as unknown as Queue;
    const redis = { quit: quitRedis } as never;
    const assetStoreFactory = vi.fn(() => assetStore);
    const runtime = await startListingPipelineWorker({
      databaseUrl: "postgres://test",
      redisUrl: "redis://test",
      databaseFactory: () => database,
      assetStoreFactory,
      providerFactory: () => provider,
      redisFactory: () => redis,
      queueFactory: () => queue,
      workerFactory: () => worker,
    });
    expect(runtime.worker).toBe(worker);
    expect(runtime.queue).toBe(queue);
    expect(database.migrate).not.toHaveBeenCalled();
    expect(assetStoreFactory).toHaveBeenCalledWith(
      "wukong-opak-prod-assets",
      expect.objectContaining({
        endpoint: "https://account.r2.cloudflarestorage.com",
        region: "auto",
        forcePathStyle: false,
        credentials: {
          accessKeyId: "access-key",
          secretAccessKey: "secret-key",
        },
      }),
    );
    await runtime.close();
    expect(closeWorker).toHaveBeenCalledOnce();
    expect(closeQueue).toHaveBeenCalledOnce();
    expect(quitRedis).toHaveBeenCalledOnce();
  });
});
