import { describe, expect, it, vi } from "vitest";

import {
  SHOPLINE_REQUEST_TIMEOUT_MS,
  hashCanonicalListing,
  type CommerceConnector,
} from "@wukong/shopline";
import {
  listing as canonicalListing,
  workspaceId,
} from "./pipeline-test-support.js";
import {
  PublishDeliveryError,
  SHOPLINE_MAX_REMOTE_CALLS_PER_ATTEMPT,
} from "./publish-product.js";
import {
  consumeShoplineMessage,
  SHOPLINE_LEASE_MARGIN_MS,
  SHOPLINE_LEASE_MS,
  SHOPLINE_MAX_ATTEMPTS,
  SHOPLINE_QUEUE_WALL_MS,
} from "./shopline-consumer.js";
import { handleQueue } from "./queue-consumer.js";

const draftId = "00000000-0000-4000-8000-000000000101";
const versionId = "00000000-0000-4000-8000-000000000201";
const connectionId = "00000000-0000-4000-8000-000000000301";
const key = `${workspaceId}:${versionId}:shopline:create`;
const payload = { workspaceId, draftId, versionId, connectionId };
const now = new Date("2026-07-22T00:00:00.000Z");

function makeHarness(
  options: {
    createError?: unknown;
    resolveImageError?: unknown;
    missingJob?: boolean;
    jobVersionId?: string;
    status?: "pending_enqueue" | "queued" | "running" | "published" | "failed";
    error?: string | null;
    leaseToken?: string | null;
    leaseExpiresAt?: Date | null;
    attemptCount?: number;
    missingConnection?: boolean;
  } = {},
) {
  const audits: any[] = [];
  const listing: any = {
    id: draftId,
    target: "shopline",
    status: "approved",
    activeVersion: { id: versionId, sequence: 1, content: canonicalListing },
    flags: [],
  };
  const job: any = {
    id: "job_1",
    listingId: draftId,
    versionId: options.jobVersionId ?? versionId,
    connectionId,
    status: options.status ?? "pending_enqueue",
    idempotencyKey: key,
    payloadDigest: hashCanonicalListing(canonicalListing),
    remoteProductId: null,
    error: options.error ?? null,
    leaseToken: options.leaseToken ?? null,
    leaseExpiresAt: options.leaseExpiresAt ?? null,
    attemptCount: options.attemptCount ?? 0,
  };
  const connector: CommerceConnector = {
    verifyConnection: vi.fn(async () => ({ merchantId: "merchant_1" })),
    createProduct: vi.fn(async () => {
      await Promise.resolve();
      if (options.createError) throw options.createError;
      return { remoteProductId: "remote_123" };
    }),
    updateProduct: vi.fn(async () => undefined),
    getProductStatus: vi.fn(async () => ({ exists: false, status: null })),
  };
  const activeLease = (leaseToken: string) => {
    if (job.status !== "running" || job.leaseToken !== leaseToken) {
      throw new Error("publish job lease is not active");
    }
  };
  const repositories: any = {
    listings: {
      async requireForPublish() {
        return listing;
      },
      async beginPublish() {
        listing.status = "publishing";
      },
      async markPublished(
        _id: string,
        expectedVersionId: string,
        remoteProductId: string,
        payloadDigest: string,
        _context: unknown,
        audit: any,
      ) {
        if (listing.activeVersion.id !== expectedVersionId) {
          throw new Error("active version changed");
        }
        listing.status = "published";
        await audit.write({
          workspaceId,
          actorId: "worker:shopline-publish",
          entityId: draftId,
          action: "listing.published",
          metadata: { remoteProductId, payloadDigest },
        });
      },
      async markPublishFailed(
        _id: string,
        _versionId: string,
        errorCode: string,
        _context: unknown,
        audit: any,
      ) {
        listing.status = "publish_failed";
        await audit.write({
          workspaceId,
          actorId: "worker:shopline-publish",
          entityId: draftId,
          action: "listing.publish_failed",
          metadata: { errorCode },
        });
      },
    },
    publishJobs: {
      async getByIdempotencyKey(inputKey: string) {
        return inputKey === key && !options.missingJob ? job : null;
      },
      async claim(input: {
        key: string;
        expectedVersionId: string;
        now: Date;
        leaseMs: number;
      }) {
        if (options.missingJob)
          return { claimed: false, job: null, leaseToken: null };
        const reclaimable =
          job.status === "pending_enqueue" ||
          job.status === "queued" ||
          (job.status === "failed" &&
            (job.error === "remote_unavailable" ||
              job.error === "rate_limited")) ||
          (job.status === "running" &&
            job.leaseExpiresAt instanceof Date &&
            job.leaseExpiresAt.getTime() <= input.now.getTime());
        if (
          input.key !== key ||
          input.expectedVersionId !== job.versionId ||
          !reclaimable
        ) {
          return { claimed: false, job: null, leaseToken: null };
        }
        job.attemptCount += 1;
        job.status = "running";
        job.leaseToken = `lease_${job.attemptCount}`;
        job.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
        return {
          claimed: true,
          job: { ...job },
          leaseToken: job.leaseToken,
        };
      },
      async recordRemoteProduct(
        inputKey: string,
        leaseToken: string,
        remoteProductId: string,
      ) {
        if (inputKey !== key) throw new Error("wrong publish key");
        activeLease(leaseToken);
        // Mirrors the repository: the job stays `running` and keeps its lease,
        // so only the remote id lands.
        Object.assign(job, { remoteProductId });
      },
      async markPublished(
        inputKey: string,
        leaseToken: string,
        remoteProductId: string,
        payloadDigest: string,
      ) {
        if (inputKey !== key) throw new Error("wrong publish key");
        activeLease(leaseToken);
        Object.assign(job, {
          status: "published",
          remoteProductId,
          payloadDigest,
          error: null,
          leaseToken: null,
          leaseExpiresAt: null,
        });
      },
      async markFailed(
        inputKey: string,
        leaseToken: string,
        errorCode: string,
      ) {
        if (inputKey !== key) throw new Error("wrong publish key");
        activeLease(leaseToken);
        Object.assign(job, {
          status: "failed",
          error: errorCode,
          leaseToken: null,
          leaseExpiresAt: null,
        });
      },
    },
    shoplineConnections: {
      async getById(id: string) {
        return id === connectionId && !options.missingConnection
          ? {
              id: connectionId,
              shopDomain: "merchant.example",
              encryptedAccessToken: "ciphertext-only",
            }
          : null;
      },
    },
    platformProducts: {
      // No test in this file asserts on platform_products rows -- the
      // stubbed `existingLink: null` in shopline-consumer.ts means every
      // delivery here takes the create path, and this fake just has to
      // satisfy the widened `PublishRepositories.platformProducts` shape.
      async getByListingId() {
        return null;
      },
      async upsert() {},
    },
    audit: {
      async write(event: any) {
        audits.push(event);
      },
    },
  };
  const runtime = {
    database: {
      async forWorkspace<T>(
        _workspaceId: string,
        work: (value: typeof repositories) => Promise<T>,
      ): Promise<T> {
        return work(repositories);
      },
    },
    resolveImageUrls: vi.fn(async () => {
      if (options.resolveImageError) throw options.resolveImageError;
      return [];
    }),
    close: vi.fn(async () => undefined),
  };
  const dependencies = {
    attempt: 1,
    maxAttempts: SHOPLINE_MAX_ATTEMPTS,
    now: () => now,
    leaseMs: 30_000,
    createRuntime: () => runtime,
    connectorFactory: vi.fn(async () => connector),
  };
  return {
    audits,
    listing,
    job,
    connector,
    repositories,
    runtime,
    dependencies,
  };
}

describe("consumeShoplineMessage", () => {
  it("claims concurrent duplicates once and reschedules the active duplicate", async () => {
    const harness = makeHarness();

    const outcomes = await Promise.all([
      consumeShoplineMessage(payload, {} as never, harness.dependencies),
      consumeShoplineMessage(payload, {} as never, harness.dependencies),
    ]);

    expect(outcomes).toEqual(["ack", { retryAfterSeconds: 30 }]);
    expect(harness.connector.createProduct).toHaveBeenCalledTimes(1);
    expect(harness.job).toMatchObject({
      status: "published",
      remoteProductId: "remote_123",
      attemptCount: 1,
      leaseToken: null,
    });
    expect(harness.listing.status).toBe("published");
  });

  it("fails a stale active version before connector work", async () => {
    const harness = makeHarness();
    harness.listing.activeVersion.id = "00000000-0000-4000-8000-000000000202";

    await expect(
      consumeShoplineMessage(payload, {} as never, harness.dependencies),
    ).resolves.toBe("ack");

    expect(harness.connector.createProduct).not.toHaveBeenCalled();
    expect(harness.job).toMatchObject({
      status: "failed",
      error: "stale_plan",
    });
    expect(harness.listing.status).toBe("approved");
  });

  it("retries invalid_connection instead of classifying it as terminal", async () => {
    const harness = makeHarness({ missingConnection: true });

    await expect(
      consumeShoplineMessage(payload, {} as never, harness.dependencies),
    ).resolves.toEqual({ retryAfterSeconds: 30 });

    expect(harness.connector.createProduct).not.toHaveBeenCalled();
    expect(harness.job).toMatchObject({
      status: "failed",
      error: "invalid_connection",
    });
  });

  it("rejects a queue connection that differs from the claimed job", async () => {
    const harness = makeHarness();
    const otherConnectionId = "00000000-0000-4000-8000-000000000302";

    await expect(
      consumeShoplineMessage(
        { ...payload, connectionId: otherConnectionId },
        {} as never,
        harness.dependencies,
      ),
    ).resolves.toBe("ack");

    expect(harness.dependencies.connectorFactory).not.toHaveBeenCalled();
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
    expect(harness.job).toMatchObject({
      status: "failed",
      error: "invalid_credentials_or_permission",
    });
  });

  it("persists a disabled real adapter as a terminal credential outcome", async () => {
    const harness = makeHarness();
    const { connectorFactory: _connectorFactory, ...dependencies } =
      harness.dependencies;

    await expect(
      consumeShoplineMessage(
        payload,
        {
          SHOPLINE_ADAPTER: "real",
          SHOPLINE_PUBLISH_ENABLED: "false",
        } as never,
        dependencies,
      ),
    ).resolves.toBe("ack");

    expect(harness.connector.createProduct).not.toHaveBeenCalled();
    expect(harness.job).toMatchObject({
      status: "failed",
      error: "invalid_credentials_or_permission",
    });
  });

  it("persists terminal credential failure with the claimed lease then acks", async () => {
    const harness = makeHarness({
      createError: new PublishDeliveryError(
        "invalid_credentials_or_permission",
      ),
    });

    await expect(
      consumeShoplineMessage(payload, {} as never, harness.dependencies),
    ).resolves.toBe("ack");

    expect(harness.job).toMatchObject({
      status: "failed",
      error: "invalid_credentials_or_permission",
      leaseToken: null,
    });
    expect(harness.listing.status).toBe("publish_failed");
  });

  it("persists a transient timeout and reclaims it on the 30 second redelivery", async () => {
    const harness = makeHarness({
      createError: new DOMException("request timed out", "AbortError"),
    });

    await expect(
      consumeShoplineMessage(payload, {} as never, harness.dependencies),
    ).resolves.toEqual({ retryAfterSeconds: 30 });

    expect(harness.job).toMatchObject({
      status: "failed",
      error: "remote_unavailable",
      attemptCount: 1,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(harness.listing.status).toBe("publish_failed");

    vi.mocked(harness.connector.createProduct).mockResolvedValue({
      remoteProductId: "remote_retry",
    });
    await expect(
      consumeShoplineMessage(payload, {} as never, {
        ...harness.dependencies,
        now: () => new Date(now.getTime() + 30_000),
        attempt: 2,
      }),
    ).resolves.toBe("ack");
    expect(harness.job).toMatchObject({
      status: "published",
      remoteProductId: "remote_retry",
      attemptCount: 2,
      leaseToken: null,
    });
    expect(harness.listing.status).toBe("published");
  });

  it("persists retryable failure on the final Cloudflare attempt for DLQ", async () => {
    const harness = makeHarness({
      createError: new DOMException("request timed out", "AbortError"),
    });

    await expect(
      consumeShoplineMessage(payload, {} as never, {
        ...harness.dependencies,
        attempt: SHOPLINE_MAX_ATTEMPTS,
      }),
    ).resolves.toEqual({ retryAfterSeconds: 30 });

    expect(harness.job).toMatchObject({
      status: "failed",
      error: "remote_unavailable",
      leaseToken: null,
    });
    expect(harness.listing.status).toBe("publish_failed");

    vi.mocked(harness.connector.createProduct).mockResolvedValue({
      remoteProductId: "remote_dlq_replay",
    });
    await expect(
      consumeShoplineMessage(payload, {} as never, {
        ...harness.dependencies,
        attempt: 1,
        now: () => new Date(now.getTime() + 60_000),
      }),
    ).resolves.toBe("ack");
    expect(harness.job).toMatchObject({
      status: "published",
      remoteProductId: "remote_dlq_replay",
      attemptCount: 2,
      leaseToken: null,
    });
  });

  it("keeps the in-flight lease beyond the bounded call budget", () => {
    expect(SHOPLINE_LEASE_MS).toBeGreaterThan(
      SHOPLINE_REQUEST_TIMEOUT_MS * SHOPLINE_MAX_REMOTE_CALLS_PER_ATTEMPT +
        SHOPLINE_LEASE_MARGIN_MS,
    );
    expect(SHOPLINE_LEASE_MS).toBeLessThan(SHOPLINE_QUEUE_WALL_MS);
  });

  it("reschedules an active same-version lease until it can be reclaimed", async () => {
    const leaseExpiresAt = new Date(now.getTime() + 270_000);
    const harness = makeHarness({
      status: "running",
      leaseToken: "lease_active",
      leaseExpiresAt,
      attemptCount: 1,
    });
    await expect(
      consumeShoplineMessage(payload, {} as never, harness.dependencies),
    ).resolves.toEqual({ retryAfterSeconds: 270 });
    expect(harness.job.attemptCount).toBe(1);
    expect(harness.dependencies.connectorFactory).not.toHaveBeenCalled();
  });

  it("survives a post-claim failure through redelivery and lease-expiry reclaim", async () => {
    const harness = makeHarness({
      resolveImageError: new Error("image store unavailable"),
    });
    const { leaseMs: _leaseMs, ...productionDependencies } =
      harness.dependencies;
    await expect(
      consumeShoplineMessage(payload, {} as never, productionDependencies),
    ).resolves.toEqual({ retryAfterSeconds: 30 });
    expect(harness.job).toMatchObject({ status: "running", attemptCount: 1 });
    const leaseExpiresAt = harness.job.leaseExpiresAt as Date;
    expect(leaseExpiresAt.getTime() - now.getTime()).toBe(SHOPLINE_LEASE_MS);

    await expect(
      consumeShoplineMessage(payload, {} as never, {
        ...productionDependencies,
        attempt: 2,
        now: () => new Date(now.getTime() + 30_000),
      }),
    ).resolves.toEqual({ retryAfterSeconds: 270 });
    expect(harness.job.attemptCount).toBe(1);

    vi.mocked(harness.runtime.resolveImageUrls).mockResolvedValue([]);
    await expect(
      consumeShoplineMessage(payload, {} as never, {
        ...productionDependencies,
        attempt: 3,
        now: () => leaseExpiresAt,
      }),
    ).resolves.toBe("ack");
    expect(harness.job).toMatchObject({
      status: "published",
      attemptCount: 2,
      remoteProductId: "remote_123",
      leaseToken: null,
    });
  });

  it.each([
    { name: "published", options: { status: "published" as const } },
    {
      name: "wrong-version running",
      options: {
        status: "running" as const,
        jobVersionId: "00000000-0000-4000-8000-000000000299",
        leaseToken: "lease_other",
        leaseExpiresAt: new Date(now.getTime() + 270_000),
      },
    },
    { name: "missing", options: { missingJob: true } },
  ])("acks an authoritative $name unclaimable job", async ({ options }) => {
    const harness = makeHarness(options);
    await expect(
      consumeShoplineMessage(payload, {} as never, harness.dependencies),
    ).resolves.toBe("ack");
    expect(harness.dependencies.connectorFactory).not.toHaveBeenCalled();
  });
  it("does not reclaim a terminal failed job", async () => {
    const harness = makeHarness({
      status: "failed",
      error: "invalid_credentials_or_permission",
      attemptCount: 1,
    });
    await expect(
      consumeShoplineMessage(payload, {} as never, harness.dependencies),
    ).resolves.toBe("ack");
    expect(harness.job).toMatchObject({
      status: "failed",
      error: "invalid_credentials_or_permission",
      attemptCount: 1,
    });
    expect(harness.dependencies.connectorFactory).not.toHaveBeenCalled();
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });

  it("reclaims an expired lease and rejects its stale terminal token", async () => {
    const staleToken = "lease_stale";
    const harness = makeHarness({
      status: "running",
      leaseToken: staleToken,
      leaseExpiresAt: new Date("2026-07-21T23:59:00.000Z"),
      attemptCount: 1,
    });

    await expect(
      consumeShoplineMessage(payload, {} as never, harness.dependencies),
    ).resolves.toBe("ack");

    expect(harness.job).toMatchObject({
      status: "published",
      attemptCount: 2,
      remoteProductId: "remote_123",
    });
    await expect(
      harness.repositories.publishJobs.markFailed(
        key,
        staleToken,
        "remote_unavailable",
      ),
    ).rejects.toThrow(/lease/i);
  });

  it("acks malformed payloads before database or credentials", async () => {
    const harness = makeHarness();

    await expect(
      consumeShoplineMessage(
        { ...payload, accessToken: "must-not-cross-queue" },
        {} as never,
        harness.dependencies,
      ),
    ).resolves.toBe("ack");

    expect(harness.dependencies.connectorFactory).not.toHaveBeenCalled();
    expect(harness.runtime.close).not.toHaveBeenCalled();
  });
});

describe("SHOPLINE queue outcomes", () => {
  it("acks terminal outcomes and retries transient/final outcomes", async () => {
    const env = {} as never;
    const makeMessage = (attempts: number) => ({
      body: payload,
      attempts,
      ack: vi.fn(),
      retry: vi.fn(),
    });
    const terminal = makeMessage(1);
    await handleQueue(
      {
        queue: "wukong-shopline-preview",
        messages: [terminal],
      } as never,
      env,
      undefined,
      {
        consumeShoplineMessage: vi.fn(async (): Promise<"ack"> => "ack"),
      },
    );
    expect(terminal.ack).toHaveBeenCalledOnce();
    expect(terminal.retry).not.toHaveBeenCalled();

    const transient = makeMessage(1);
    await handleQueue(
      {
        queue: "wukong-shopline-preview",
        messages: [transient],
      } as never,
      env,
      undefined,
      {
        consumeShoplineMessage: vi.fn(async () => ({
          retryAfterSeconds: 30,
        })),
      },
    );
    expect(transient.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(transient.ack).not.toHaveBeenCalled();

    const finalAttempt = makeMessage(SHOPLINE_MAX_ATTEMPTS);
    await handleQueue(
      {
        queue: "wukong-shopline-preview",
        messages: [finalAttempt],
      } as never,
      env,
      undefined,
      {
        consumeShoplineMessage: vi.fn(async () => ({
          retryAfterSeconds: 30,
        })),
      },
    );
    expect(finalAttempt.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(finalAttempt.ack).not.toHaveBeenCalled();
  });

  it("retries an active lease outcome instead of acknowledging it", async () => {
    const harness = makeHarness({
      status: "running",
      leaseToken: "lease_busy",
      leaseExpiresAt: new Date(now.getTime() + 270_000),
      attemptCount: 1,
    });
    const message = {
      body: payload,
      attempts: 2,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await handleQueue(
      { queue: "wukong-shopline-preview", messages: [message] } as never,
      {} as never,
      undefined,
      {
        consumeShoplineMessage: (body, env, attempt) =>
          consumeShoplineMessage(body, env, {
            ...harness.dependencies,
            ...attempt,
          }),
      },
    );
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 270 });
    expect(message.ack).not.toHaveBeenCalled();
  });
  it("fails closed for an unknown queue before ack or retry", async () => {
    const message = {
      body: payload,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await expect(
      handleQueue(
        { queue: "wrong-shopline-queue", messages: [message] } as never,
        {} as never,
      ),
    ).rejects.toThrow("unknown queue name");
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
