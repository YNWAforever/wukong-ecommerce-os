import type { AuditWriter } from "@wukong/core";
import type { WorkspaceRepositories } from "@wukong/db";
import { shoplinePublishJobSchema } from "@wukong/jobs";
import type { CommerceConnector } from "@wukong/shopline";

import { createCloudflareRuntime } from "./cloudflare-runtime.js";
import {
  PublishDeliveryError,
  publishApprovedProduct,
  type PublishRepositories,
} from "./publish-product.js";
import {
  createShoplineConnectorFactory,
  type ShoplineConnectorFactory,
} from "./shopline-runtime.js";
import type { WorkerEnv } from "./worker-env.js";

export type ShoplineConsumerOutcome = "ack" | { retryAfterSeconds: number };

export const SHOPLINE_MAX_ATTEMPTS = 4;
const RETRY_AFTER_SECONDS = 30;
const LEASE_MS = 30_000;

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
): PublishRepositories {
  return {
    listings: repositories.listings,
    publishJobs: repositories.publishJobs,
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
      error.code === "invalid_payload")
  );
}

export async function consumeShoplineMessage(
  payload: unknown,
  env: WorkerEnv,
  dependencies: ShoplineConsumerDependencies = {},
): Promise<ShoplineConsumerOutcome> {
  const parsed = shoplinePublishJobSchema.safeParse(payload);
  if (!parsed.success) return "ack";

  const attempt = dependencies.attempt ?? 1;
  const maxAttempts = dependencies.maxAttempts ?? SHOPLINE_MAX_ATTEMPTS;
  const finalAttempt = attempt >= maxAttempts;
  let runtime: ShoplineRuntime;
  try {
    runtime = (dependencies.createRuntime ?? createCloudflareRuntime)(env);
  } catch {
    return { retryAfterSeconds: RETRY_AFTER_SECONDS };
  }

  const idempotencyKey = `${parsed.data.workspaceId}:${parsed.data.versionId}:shopline:create`;
  try {
    const claimed = await runtime.database.forWorkspace(
      parsed.data.workspaceId,
      async (repositories) => {
        const claim = await repositories.publishJobs.claim({
          key: idempotencyKey,
          expectedVersionId: parsed.data.versionId,
          now: (dependencies.now ?? (() => new Date()))(),
          leaseMs: dependencies.leaseMs ?? LEASE_MS,
        });
        if (!claim.claimed || !claim.leaseToken) {
          return {
            claim,
            connection: null,
            terminalConnectionFailure: false,
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
          };
        }
        const connection = await repositories.shoplineConnections.getById(
          parsed.data.connectionId,
        );
        return {
          claim,
          connection,
          terminalConnectionFailure: false,
        };
      },
    );
    if (!claimed.claim.claimed || !claimed.claim.leaseToken) return "ack";
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
        persistRetryableFailure: finalAttempt,
      },
      {
        connector,
        async withWorkspace<T>(
          workspaceId: string,
          work: (repositories: PublishRepositories) => Promise<T>,
        ): Promise<T> {
          return runtime.database.forWorkspace(workspaceId, (repositories) =>
            work(publishRepositories(repositories)),
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
