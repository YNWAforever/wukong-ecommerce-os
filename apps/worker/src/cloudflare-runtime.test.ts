import { describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ createDatabase: vi.fn() }));

vi.mock("@wukong/db", () => ({ createDatabase: dbMocks.createDatabase }));

import {
  authenticatedWorkerHealth,
  createCloudflareRuntime,
  createWorkerDatabase,
} from "./cloudflare-runtime.js";
import { CHECK_IDS, CHECK_FIELDS } from "@wukong/ai";
import { unavailableVerification } from "./listing-verification-support.js";
import { usage } from "./pipeline-test-support.js";
import type { WorkerEnv } from "./worker-env.js";

function env(): WorkerEnv {
  return {
    HYPERDRIVE: { connectionString: "postgres://x" } as never,
    LISTING_QUEUE: { send: vi.fn(async () => undefined) } as never,
    SHOPLINE_QUEUE: { send: vi.fn(async () => undefined) } as never,
    QUEUE_INGRESS_SECRET: "q".repeat(32),
    BUILD_SHA: "abc123",
    SHOPLINE_ADAPTER: "disabled",
  };
}

describe("Cloudflare runtime", () => {
  it("creates a five-connection database only from Hyperdrive", () => {
    const database = { close: vi.fn() };
    dbMocks.createDatabase.mockReturnValue(database);

    expect(
      createWorkerDatabase({
        HYPERDRIVE: { connectionString: "opaque-connection-string" },
      } as never),
    ).toBe(database);
    expect(dbMocks.createDatabase).toHaveBeenCalledWith(
      "opaque-connection-string",
      { maxConnections: 5 },
    );
  });

  it("closes the Hyperdrive database through the Cloudflare runtime", async () => {
    const database = {
      close: vi.fn(async () => undefined),
      forWorkspace: vi.fn(),
    };
    const runtime = createCloudflareRuntime({ AI_PROVIDER: "fake" } as never, {
      databaseFactory: () => database as never,
      assetStoreFactory: () => ({}) as never,
      providerFactory: () => ({}) as never,
    });

    await runtime.close();

    expect(database.close).toHaveBeenCalledOnce();
  });

  it("resolves owned draft images inside the workspace database boundary", async () => {
    const sourceAssets = {
      getByIds: vi.fn(async () => [
        {
          id: "asset_a",
          workspaceId: "ws_opak",
          listingId: "draft_1",
          kind: "image/png",
          storageKey: "ws/ws_opak/sources/asset-a/a.png",
        },
      ]),
    };
    const repositories = { sourceAssets };
    const database = {
      close: vi.fn(async () => undefined),
      forWorkspace: vi.fn(
        async (
          _workspaceId: string,
          work: (value: typeof repositories) => Promise<unknown>,
        ) => work(repositories),
      ),
    };
    const createReadUrl = vi.fn(async () => ({
      url: "https://signed.example/asset-a",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    }));
    const runtime = createCloudflareRuntime({ AI_PROVIDER: "fake" } as never, {
      databaseFactory: () => database as never,
      assetStoreFactory: () => ({ createReadUrl }) as never,
      providerFactory: () => ({}) as never,
    });

    await expect(
      runtime.resolveImageUrls("ws_opak", "draft_1", ["asset_a"]),
    ).resolves.toEqual(["https://signed.example/asset-a"]);

    expect(database.forWorkspace).toHaveBeenCalledWith(
      "ws_opak",
      expect.any(Function),
    );
    expect(sourceAssets.getByIds).toHaveBeenCalledWith(["asset_a"]);
    // The pipeline resolves images for in-app use, so it asks for no explicit
    // lifetime and the asset store applies its own default. Only the CSV export
    // path requests the long one.
    expect(createReadUrl).toHaveBeenCalledWith(
      "ws_opak",
      "ws/ws_opak/sources/asset-a/a.png",
      { expiresInMs: undefined },
    );
  });
});

describe("authenticatedWorkerHealth", () => {
  it("reports a reachable database", async () => {
    const database = {
      ping: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    const health = await authenticatedWorkerHealth(env(), {
      createDatabase: () => database as never,
    });

    expect(health.authenticated).toBe(true);
    expect(health.checks.hyperdriveConnects).toBe(true);
    expect(database.close).toHaveBeenCalled();
  });

  it("reports an unreachable database without throwing", async () => {
    const database = {
      ping: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      close: vi.fn(async () => undefined),
    };

    const health = await authenticatedWorkerHealth(env(), {
      createDatabase: () => database as never,
    });

    expect(health.checks.hyperdriveConnects).toBe(false);
    expect(database.close).toHaveBeenCalled();
  });

  it("survives the database factory throwing", async () => {
    const health = await authenticatedWorkerHealth(env(), {
      createDatabase: () => {
        throw new Error("HYPERDRIVE binding is required");
      },
    });

    expect(health.authenticated).toBe(true);
    expect(health.checks.hyperdriveConnects).toBe(false);
  });

  it("survives close() rejecting after a successful ping", async () => {
    const database = {
      ping: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        throw new Error("socket already gone");
      }),
    };

    const health = await authenticatedWorkerHealth(env(), {
      createDatabase: () => database as never,
    });

    expect(health.checks.hyperdriveConnects).toBe(true);
  });
});

describe("verification runtime mapping", () => {
  function runtimeHarness(extra: Partial<WorkerEnv> = {}) {
    const append = vi.fn(async (_run: unknown) => undefined);
    const repositories = { aiRuns: { append } };
    const verifier = { verify: vi.fn() };
    const verifierFactory = vi.fn(() => verifier);
    const runtime = createCloudflareRuntime(
      { ...env(), ...extra },
      {
        databaseFactory: () =>
          ({
            forWorkspace: async (
              _id: string,
              work: (repos: unknown) => Promise<unknown>,
            ) => work(repositories),
          }) as never,
        assetStoreFactory: () => ({}) as never,
        providerFactory: () => ({}) as never,
        verifierFactory,
      },
    );
    return { runtime, append, verifierFactory, verifier };
  }
  it("gates the runtime verifier factory before construction", () => {
    const off = runtimeHarness({
      TYPESAFE_API_KEY: "secret",
      TYPESAFE_MODEL: "model",
    });
    expect(off.runtime.dependencies.verifier).toBeUndefined();
    expect(off.verifierFactory).not.toHaveBeenCalled();
    const on = runtimeHarness({
      TYPESAFE_VERIFICATION_MODE: "advisory",
      TYPESAFE_API_KEY: "secret",
      TYPESAFE_MODEL: "model",
    });
    expect(on.runtime.dependencies.verifier).toBe(on.verifier);
    expect(on.verifierFactory).toHaveBeenCalledTimes(1);
  });
  it("preserves the actual response model and complete successful output", async () => {
    const { runtime, append } = runtimeHarness();
    const record = {
      ...unavailableVerification("network", true),
      outcome: "completed" as const,
      reason: null,
      actualModel: "actual-response-model",
      requestedModel: "alias",
      checks: CHECK_IDS.map((id) => ({
        id,
        fields: CHECK_FIELDS[id],
        assessment: "assessed" as const,
        probability: 0.2,
      })),
      listingVersionId: "version1",
      contentDigest: "a".repeat(64),
      evidenceDigest: "b".repeat(64),
    };
    await runtime.dependencies.withWorkspace("ws", (repos) =>
      repos.aiRuns.appendVerification({
        draftId: "draft",
        idempotencyKey: "verify",
        record,
      }),
    );
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      model: "actual-response-model",
      provider: "typesafe",
      output: record,
      status: "succeeded",
      error: null,
    });
  });
  it.each(["unavailable", "skipped"] as const)(
    "maps %s without borrowing the generation provider or requested alias",
    async (outcome) => {
      const { runtime, append } = runtimeHarness();
      const record = {
        ...unavailableVerification("network", true),
        outcome,
        reason:
          outcome === "skipped"
            ? ("input_too_large" as const)
            : ("network" as const),
        requestedModel: "alias",
        listingVersionId: "version1",
        contentDigest: "a".repeat(64),
        evidenceDigest: "b".repeat(64),
      };
      await runtime.dependencies.withWorkspace("ws", async (repos) => {
        await repos.aiRuns.appendVerification({
          draftId: "draft",
          idempotencyKey: "verify-key",
          record,
        });
        await repos.aiRuns.append({
          ...usage,
          task: "generate",
          draftId: "draft",
          idempotencyKey: "generate-key",
          outcome: "succeeded",
        });
      });
      expect(append.mock.calls[0]?.[0]).toMatchObject({
        listingId: "draft",
        listingVersionId: "version1",
        task: "verify",
        provider: "typesafe",
        model: "unavailable",
        promptVersion: record.questionSetVersion,
        input: {},
        output: record,
        status: outcome === "unavailable" ? "failed" : "succeeded",
        error: record.reason,
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
      });
      expect(append.mock.calls[1]?.[0]).toMatchObject({
        task: "generate",
        provider: "openai",
        model: usage.model,
        input: { task: "generate" },
        output: {},
        status: "succeeded",
      });
    },
  );
});
