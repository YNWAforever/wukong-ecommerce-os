import type { AuditWriter } from "@wukong/core";
import type { WorkspaceRepositories } from "@wukong/db";
import { shoplinePublishJobSchema } from "@wukong/jobs";
import {
  SHOPLINE_REQUEST_TIMEOUT_MS,
  type CommerceConnector,
} from "@wukong/shopline";

import { createCloudflareRuntime } from "./cloudflare-runtime.js";
import {
  PublishDeliveryError,
  publishApprovedProduct,
  SHOPLINE_MAX_REMOTE_CALLS_PER_ATTEMPT,
  type PublishRepositories,
} from "./publish-product.js";
import {
  createShoplineConnectorFactory,
  type ShoplineConnectorFactory,
} from "./shopline-runtime.js";
import type { WorkerEnv } from "./worker-env.js";

export type ShoplineConsumerOutcome = "ack" | { retryAfterSeconds: number };

export const SHOPLINE_MAX_ATTEMPTS = 4;
export const SHOPLINE_LEASE_MARGIN_MS = 60_000;
export const SHOPLINE_QUEUE_WALL_MS = 15 * 60_000;
export const SHOPLINE_LEASE_MS = 300_000;
const RETRY_AFTER_SECONDS = 30;

if (
  SHOPLINE_LEASE_MS <=
    SHOPLINE_REQUEST_TIMEOUT_MS * SHOPLINE_MAX_REMOTE_CALLS_PER_ATTEMPT +
      SHOPLINE_LEASE_MARGIN_MS ||
  SHOPLINE_LEASE_MS >= SHOPLINE_QUEUE_WALL_MS
) {
  throw new Error("SHOPLINE publish lease budget is unsafe");
}

type ShoplineRuntime = {
  database: {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: WorkspaceRepositories) => Promise<T>,
    ): Promise<T>;
  };
  resolveImageUrls(
    workspaceId: string,
    draftId: string,
    imageAssetIds: readonly string[],
  ): Promise<readonly string[]>;
  close(): Promise<void>;
};

export type ShoplineConsumerDependencies = {
  attempt?: number;
  maxAttempts?: number;
  now?: () => Date;
  leaseMs?: number;
  createRuntime?: (env: WorkerEnv) => ShoplineRuntime;
  connectorFactory?: ShoplineConnectorFactory;
};

function publishRepositories(
  repositories: WorkspaceRepositories,
  workspaceId: string,
): PublishRepositories {
  return {
    listings: repositories.listings,
    publishJobs: repositories.publishJobs,
    shoplineConnections: {
      async getById(id) {
        const connection = await repositories.shoplineConnections.getById(id);
        return connection
          ? { id: connection.id, workspaceId, verified: true }
          : null;
      },
    },
    platformProducts: repositories.platformProducts,
    audit: repositories.audit as AuditWriter,
  };
}

function terminalConnector(): CommerceConnector {
  const reject = async (): Promise<never> => {
    throw new PublishDeliveryError("invalid_credentials_or_permission");
  };
  return {
    verifyConnection: reject,
    createProduct: reject,
    updateProduct: reject,
    getProductStatus: reject,
  };
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof PublishDeliveryError &&
    (error.code === "rate_limited" || error.code === "remote_unavailable")
  );
}

function isTerminal(error: unknown): boolean {
  return (
    error instanceof PublishDeliveryError &&
    (error.code === "invalid_credentials_or_permission" ||
      error.code === "validation_failed" ||
      error.code === "not_approved" ||
      error.code === "blocking_flags" ||
      error.code === "invalid_payload" ||
      error.code === "stale_plan")
  );
}

export async function consumeShoplineMessage(
  payload: unknown,
  env: WorkerEnv,
  dependencies: ShoplineConsumerDependencies = {},
): Promise<ShoplineConsumerOutcome> {
  const parsed = shoplinePublishJobSchema.safeParse(payload);
  if (!parsed.success) return "ack";

  let runtime: ShoplineRuntime;
  try {
    runtime = (dependencies.createRuntime ?? createCloudflareRuntime)(env);
  } catch {
    return { retryAfterSeconds: RETRY_AFTER_SECONDS };
  }

  const idempotencyKey = `${parsed.data.workspaceId}:${parsed.data.versionId}:shopline:create`;
  const claimNow = (dependencies.now ?? (() => new Date()))();
  try {
    const claimed = await runtime.database.forWorkspace(
      parsed.data.workspaceId,
      async (repositories) => {
        const claim = await repositories.publishJobs.claim({
          key: idempotencyKey,
          expectedVersionId: parsed.data.versionId,
          now: claimNow,
          leaseMs: dependencies.leaseMs ?? SHOPLINE_LEASE_MS,
        });
        if (!claim.claimed || !claim.leaseToken) {
          const authoritative =
            await repositories.publishJobs.getByIdempotencyKey(idempotencyKey);
          const busyLeaseExpiresAt =
            authoritative?.versionId === parsed.data.versionId &&
            authoritative.status === "running" &&
            authoritative.leaseExpiresAt instanceof Date &&
            authoritative.leaseExpiresAt.getTime() > claimNow.getTime()
              ? authoritative.leaseExpiresAt
              : null;
          return {
            claim,
            connection: null,
            terminalConnectionFailure: false,
            busyLeaseExpiresAt,
          };
        }
        if (claim.job?.connectionId !== parsed.data.connectionId) {
          await repositories.publishJobs.markFailed(
            idempotencyKey,
            claim.leaseToken,
            "invalid_credentials_or_permission",
          );
          return {
            claim,
            connection: null,
            terminalConnectionFailure: true,
            busyLeaseExpiresAt: null,
          };
        }
        const connection = await repositories.shoplineConnections.getById(
          parsed.data.connectionId,
        );
        return {
          claim,
          connection,
          terminalConnectionFailure: false,
          busyLeaseExpiresAt: null,
        };
      },
    );
    if (!claimed.claim.claimed || !claimed.claim.leaseToken) {
      if (claimed.busyLeaseExpiresAt) {
        return {
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              (claimed.busyLeaseExpiresAt.getTime() - claimNow.getTime()) /
                1_000,
            ),
          ),
        };
      }
      return "ack";
    }
    if (claimed.terminalConnectionFailure) return "ack";

    let connector: CommerceConnector | null = null;
    try {
      const connectorFactory =
        dependencies.connectorFactory ?? createShoplineConnectorFactory(env);
      connector = await connectorFactory(claimed.connection ?? undefined);
    } catch {
      connector = null;
    }
    if (!connector) connector = terminalConnector();

    await publishApprovedProduct(
      {
        workspaceId: parsed.data.workspaceId,
        draftId: parsed.data.draftId,
        expectedVersionId: parsed.data.versionId,
        connectionId: parsed.data.connectionId,
        leaseToken: claimed.claim.leaseToken,
        persistRetryableFailure: true,
        // Stub: always "create" for now. Task 6 replaces this with a real
        // platformProducts.getByListingId lookup, done before claim() so the
        // same lookup result decides both the claimed idempotency key and
        // this input -- see docs/superpowers/plans/2026-08-21-shopline-update-after-publish.md, Task 6.
        existingLink: null,
      },
      {
        connector,
        async withWorkspace<T>(
          workspaceId: string,
          work: (repositories: PublishRepositories) => Promise<T>,
        ): Promise<T> {
          return runtime.database.forWorkspace(workspaceId, (repositories) =>
            work(publishRepositories(repositories, workspaceId)),
          );
        },
        resolveImageUrls: (workspaceId, draftId, imageAssetIds) =>
          runtime.resolveImageUrls(workspaceId, draftId, imageAssetIds),
      },
    );
    return "ack";
  } catch (error) {
    if (isTerminal(error)) return "ack";
    if (isRetryable(error)) {
      return { retryAfterSeconds: RETRY_AFTER_SECONDS };
    }
    return { retryAfterSeconds: RETRY_AFTER_SECONDS };
  } finally {
    try {
      await runtime.close();
    } catch {
      // Cleanup must not override the classified queue outcome.
    }
  }
}
