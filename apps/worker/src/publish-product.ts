import type {
  AuditContext,
  AuditWriter,
  CanonicalListing,
  ComplianceFlag,
  ListingStatus,
} from "@wukong/core";
import {
  evaluateDeliveryPolicy,
  type CommerceConnector,
  type ConnectorErrorCode,
  type DeliveryConnectionSnapshot,
  type DeliveryPolicyOutcome,
  type ShoplineProductPayload,
} from "@wukong/shopline";

export type PublishProductInput = {
  workspaceId: string;
  draftId: string;
  expectedVersionId: string;
  leaseToken: string;
  connectionId?: string;
  persistRetryableFailure?: boolean;
};

export type PublishListingSnapshot = {
  id: string;
  target: "shopline";
  status: ListingStatus;
  activeVersion: {
    id: string;
    sequence: number;
    content: CanonicalListing;
  } | null;
  flags: ComplianceFlag[];
};

export type PublishJobStatus =
  "pending_enqueue" | "queued" | "running" | "published" | "failed";

export type PublishJobRecord = {
  id: string;
  listingId: string;
  versionId: string;
  connectionId: string;
  status: PublishJobStatus;
  idempotencyKey: string;
  payloadDigest: string | null;
  remoteProductId: string | null;
  error: string | null;
  leaseToken?: string | null;
};

export type PublishRepositories = {
  listings: {
    requireForPublish(id: string): Promise<PublishListingSnapshot>;
    beginPublish(
      id: string,
      context: AuditContext,
      audit: AuditWriter,
    ): Promise<void>;
    markPublished(
      id: string,
      versionId: string,
      remoteProductId: string,
      payloadDigest: string,
      context: AuditContext,
      audit: AuditWriter,
    ): Promise<void>;
    markPublishFailed(
      id: string,
      versionId: string,
      errorCode: PublishErrorCode,
      context: AuditContext,
      audit: AuditWriter,
    ): Promise<void>;
  };
  publishJobs: {
    getByIdempotencyKey(key: string): Promise<PublishJobRecord | null>;
    markPublished(
      key: string,
      leaseToken: string,
      remoteProductId: string,
      payloadDigest: string,
    ): Promise<void>;
    markFailed(
      key: string,
      leaseToken: string,
      errorCode: PublishErrorCode,
    ): Promise<void>;
  };
  shoplineConnections: {
    getById(id: string): Promise<DeliveryConnectionSnapshot | null>;
  };
  audit: AuditWriter;
};

export type PublishDependencies = {
  connector: CommerceConnector;
  connectionId?: string;
  withWorkspace<T>(
    workspaceId: string,
    work: (repositories: PublishRepositories) => Promise<T>,
  ): Promise<T>;
  resolveImageUrls: (
    workspaceId: string,
    draftId: string,
    imageAssetIds: readonly string[],
  ) => Promise<readonly string[]>;
};

export type PublishErrorCode =
  | ConnectorErrorCode
  | "not_approved"
  | "blocking_flags"
  | "invalid_payload"
  | "invalid_connection"
  | "stale_plan";

export class PublishDeliveryError extends Error {
  readonly code: PublishErrorCode;

  constructor(code: PublishErrorCode, _cause?: string) {
    super(
      code === "blocking_flags"
        ? "Unresolved blocking compliance flags prevent delivery"
        : code === "not_approved"
          ? "Only the active approved version can be delivered"
          : code === "invalid_connection"
            ? "A valid tenant SHOPLINE connection is required"
            : code === "stale_plan"
              ? "The approved listing plan is no longer current"
              : `SHOPLINE publish failed: ${code}`,
    );
    this.name = "PublishDeliveryError";
    this.code = code;
  }
}

export const SHOPLINE_MAX_REMOTE_CALLS_PER_ATTEMPT = 4;

const PUBLISH_ACTOR_ID = "worker:shopline-publish";

function context(input: PublishProductInput): AuditContext {
  return {
    workspaceId: input.workspaceId,
    actorId: PUBLISH_ACTOR_ID,
    entityId: input.draftId,
  };
}

function normalizeConnectorError(error: unknown): PublishDeliveryError {
  if (error instanceof PublishDeliveryError) return error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === "invalid_credentials_or_permission" ||
      code === "validation_failed" ||
      code === "rate_limited" ||
      code === "remote_unavailable"
    ) {
      return new PublishDeliveryError(code);
    }
  }
  return new PublishDeliveryError("remote_unavailable");
}

function errorFromPolicy(
  outcome: Exclude<DeliveryPolicyOutcome, { kind: "ready" }>,
): PublishDeliveryError {
  switch (outcome.kind) {
    case "blocking_flags":
      return new PublishDeliveryError("blocking_flags");
    case "validation_error":
      return new PublishDeliveryError("invalid_payload");
    case "disconnected":
      return new PublishDeliveryError("invalid_connection");
    case "stale_plan":
      return new PublishDeliveryError("stale_plan");
    case "not_found":
    case "approval_required":
    case "already_published":
      return new PublishDeliveryError("not_approved");
  }
}

function policyAuditMetadata(
  outcome: Exclude<DeliveryPolicyOutcome, { kind: "ready" }>,
): Record<string, unknown> {
  return {
    ...outcome.auditFacts,
    ...(outcome.kind === "stale_plan"
      ? {
          expectedVersionId: outcome.expected.versionId,
          expectedPayloadDigest: outcome.expected.payloadDigest,
          observedVersionId: outcome.observed.versionId,
          observedPayloadDigest: outcome.observed.payloadDigest,
        }
      : {}),
  };
}

function existingResult(job: PublishJobRecord): PublishResult {
  if (
    job.status !== "published" ||
    !job.remoteProductId ||
    !job.payloadDigest
  ) {
    throw new Error("published job is missing its remote result");
  }
  return {
    status: "published",
    remoteProductId: job.remoteProductId,
    payloadDigest: job.payloadDigest,
    idempotencyKey: job.idempotencyKey,
  };
}

export type PublishResult = {
  status: "published";
  remoteProductId: string;
  payloadDigest: string;
  idempotencyKey: string;
};

export async function publishApprovedProduct(
  input: PublishProductInput,
  dependencies: PublishDependencies,
): Promise<PublishResult> {
  const connectionId = input.connectionId ?? dependencies.connectionId;
  if (
    !connectionId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      connectionId,
    )
  ) {
    throw new PublishDeliveryError("invalid_connection");
  }
  if (!input.expectedVersionId.trim() || !input.leaseToken.trim()) {
    throw new Error(
      "An expected version and active publish lease are required",
    );
  }

  const idempotencyKey = `${input.workspaceId}:${input.expectedVersionId}:shopline:create`;
  const prepared = await dependencies.withWorkspace(
    input.workspaceId,
    async (repositories) => {
      const listing = await repositories.listings.requireForPublish(
        input.draftId,
      );
      const existing =
        await repositories.publishJobs.getByIdempotencyKey(idempotencyKey);
      if (listing.status === "published") {
        if (existing?.status === "published") {
          return { result: existingResult(existing) };
        }
        throw new Error("published listing is missing its delivery record");
      }
      if (existing?.status === "published") {
        return { result: existingResult(existing) };
      }
      if (!existing || existing.versionId !== input.expectedVersionId) {
        throw new Error("claimed publish job is unavailable");
      }
      if (existing.connectionId !== connectionId) {
        const error = new PublishDeliveryError("invalid_connection");
        await repositories.publishJobs.markFailed(
          idempotencyKey,
          input.leaseToken,
          error.code,
        );
        return { terminalError: error };
      }

      const imageUrls = await dependencies.resolveImageUrls(
        input.workspaceId,
        input.draftId,
        listing.activeVersion?.content.imageAssetIds ?? [],
      );
      const connection = await repositories.shoplineConnections.getById(
        connectionId,
      );
      const outcome = evaluateDeliveryPolicy({
        method: "shopline_api",
        phase: "worker",
        listing: {
          ...listing,
          workspaceId: input.workspaceId,
          draftId: listing.id,
        },
        imageUrls,
        connection,
        job: existing,
      });
      if (outcome.kind !== "ready") {
        const error = errorFromPolicy(outcome);
        await repositories.publishJobs.markFailed(
          idempotencyKey,
          input.leaseToken,
          error.code,
        );
        await repositories.audit.write({
          workspaceId: input.workspaceId,
          actorId: PUBLISH_ACTOR_ID,
          entityId: input.draftId,
          action: "listing.publish_policy_rejected",
          metadata: policyAuditMetadata(outcome),
        });
        return { terminalError: error };
      }
      const { plan } = outcome;
      const auditContext = context(input);
      if (
        listing.status === "approved" ||
        listing.status === "publish_failed"
      ) {
        await repositories.listings.beginPublish(
          listing.id,
          auditContext,
          repositories.audit,
        );
      }
      return {
        listing,
        job: existing,
        payload: plan.payload,
        payloadDigest: plan.payloadDigest,
        versionId: plan.versionId,
        markListingOnFailure: true,
      };
    },
  );

  if ("terminalError" in prepared) {
    throw prepared.terminalError;
  }
  if ("result" in prepared && prepared.result !== undefined) {
    return prepared.result;
  }

  const {
    listing,
    job,
    payload,
    payloadDigest,
    versionId,
    markListingOnFailure,
  } = prepared;
  const auditContext = context(input);

  const complete = async (remoteProductId: string): Promise<PublishResult> => {
    await dependencies.withWorkspace(
      input.workspaceId,
      async (repositories) => {
        await repositories.publishJobs.markPublished(
          idempotencyKey,
          input.leaseToken,
          remoteProductId,
          payloadDigest,
        );
        await repositories.listings.markPublished(
          listing.id,
          versionId,
          remoteProductId,
          payloadDigest,
          auditContext,
          repositories.audit,
        );
      },
    );
    return {
      status: "published",
      remoteProductId,
      payloadDigest,
      idempotencyKey,
    };
  };

  const fail = async (error: PublishDeliveryError): Promise<never> => {
    await dependencies.withWorkspace(
      input.workspaceId,
      async (repositories) => {
        await repositories.publishJobs.markFailed(
          idempotencyKey,
          input.leaseToken,
          error.code,
        );
        if (markListingOnFailure) {
          await repositories.listings.markPublishFailed(
            listing.id,
            versionId,
            error.code,
            auditContext,
            repositories.audit,
          );
        }
      },
    );
    throw error;
  };

  if (job.remoteProductId) {
    try {
      const status = await dependencies.connector.getProductStatus(
        job.remoteProductId,
      );
      if (status.exists) return complete(job.remoteProductId);
    } catch (error) {
      const normalized = normalizeConnectorError(error);
      if (
        normalized.code !== "remote_unavailable" &&
        normalized.code !== "rate_limited"
      ) {
        return fail(normalized);
      }
      if (input.persistRetryableFailure) return fail(normalized);
      throw normalized;
    }
  }

  let createError: PublishDeliveryError | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const created = await dependencies.connector.createProduct(
        payload,
        idempotencyKey,
      );
      return complete(created.remoteProductId);
    } catch (error) {
      createError = normalizeConnectorError(error);
      if (createError.code !== "remote_unavailable") break;
      if (attempt === 0 && job.remoteProductId) {
        try {
          const status = await dependencies.connector.getProductStatus(
            job.remoteProductId,
          );
          if (status.exists) return complete(job.remoteProductId);
        } catch (statusError) {
          createError = normalizeConnectorError(statusError);
        }
      }
    }
  }

  const finalError =
    createError ?? new PublishDeliveryError("remote_unavailable");
  if (
    (finalError.code === "remote_unavailable" ||
      finalError.code === "rate_limited") &&
    !input.persistRetryableFailure
  ) {
    throw finalError;
  }
  return fail(finalError);
}
