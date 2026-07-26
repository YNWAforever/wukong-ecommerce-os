import { createHash } from "node:crypto";

import type {
  AuditContext,
  AuditWriter,
  CanonicalListing,
  ComplianceFlag,
  ListingStatus,
} from "@wukong/core";
import {
  projectToShopline,
  type CommerceConnector,
  type ConnectorErrorCode,
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
    recordRemoteProduct(
      key: string,
      leaseToken: string,
      remoteProductId: string,
    ): Promise<void>;
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
  | "invalid_connection";

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

function digestPayload(payload: CanonicalListing): string {
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function isUnresolvedBlockingFlag(flag: ComplianceFlag): boolean {
  return flag.severity === "blocking" && flag.status === "open";
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
      if (
        listing.target !== "shopline" ||
        !listing.activeVersion ||
        listing.activeVersion.id !== input.expectedVersionId
      ) {
        const error = new PublishDeliveryError("not_approved");
        await repositories.publishJobs.markFailed(
          idempotencyKey,
          input.leaseToken,
          error.code,
        );
        return { terminalError: error };
      }

      const existing =
        await repositories.publishJobs.getByIdempotencyKey(idempotencyKey);
      if (listing.status === "published") {
        if (existing?.status === "published") {
          return { result: existingResult(existing) };
        }
        throw new Error("published listing is missing its delivery record");
      }
      if (
        listing.status !== "approved" &&
        listing.status !== "publishing" &&
        listing.status !== "publish_failed"
      ) {
        const error = new PublishDeliveryError("not_approved");
        await repositories.publishJobs.markFailed(
          idempotencyKey,
          input.leaseToken,
          error.code,
        );
        return { terminalError: error };
      }
      if (existing?.status === "published") {
        return { result: existingResult(existing) };
      }
      if (!existing || existing.versionId !== input.expectedVersionId) {
        throw new Error("claimed publish job is unavailable");
      }
      if (listing.flags.some(isUnresolvedBlockingFlag)) {
        const error = new PublishDeliveryError("blocking_flags");
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
        listing.activeVersion.content.imageAssetIds,
      );
      let payload: ShoplineProductPayload;
      try {
        payload = projectToShopline(listing.activeVersion.content, imageUrls);
      } catch {
        const error = new PublishDeliveryError("invalid_payload");
        await repositories.publishJobs.markFailed(
          idempotencyKey,
          input.leaseToken,
          error.code,
        );
        return { terminalError: error };
      }
      const payloadDigest = digestPayload(listing.activeVersion.content);
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
        payload,
        payloadDigest,
        versionId: input.expectedVersionId,
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
    let remoteProductExists = false;
    try {
      const status = await dependencies.connector.getProductStatus(
        job.remoteProductId,
      );
      remoteProductExists = status.exists;
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
    // Outside the try: a database failure while completing must not be
    // reclassified as a connector error and marked failed, because the remote
    // product genuinely exists at this point.
    if (remoteProductExists) return complete(job.remoteProductId);
  }

  let createError: PublishDeliveryError | null = null;
  let deliveredRemoteProductId: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Only the connector call belongs in this try. Anything else in here gets
      // laundered by normalizeConnectorError into `remote_unavailable`, which
      // does not break the loop -- so a failed database write after a successful
      // create would POST /products a second time.
      const created = await dependencies.connector.createProduct(
        payload,
        idempotencyKey,
      );
      deliveredRemoteProductId = created.remoteProductId;
      break;
    } catch (error) {
      createError = normalizeConnectorError(error);
      if (createError.code !== "remote_unavailable") break;
      if (attempt === 0 && job.remoteProductId) {
        try {
          const status = await dependencies.connector.getProductStatus(
            job.remoteProductId,
          );
          if (status.exists) {
            deliveredRemoteProductId = job.remoteProductId;
            break;
          }
        } catch (statusError) {
          createError = normalizeConnectorError(statusError);
        }
      }
    }
  }

  if (deliveredRemoteProductId) {
    const remoteProductId = deliveredRemoteProductId;
    // Commit the remote id on its own before the wider completion write. This
    // keeps the unreconcilable window down to one small UPDATE, and it is what
    // makes the reconciliation reads above reachable on a later delivery.
    await dependencies.withWorkspace(input.workspaceId, (repositories) =>
      repositories.publishJobs.recordRemoteProduct(
        idempotencyKey,
        input.leaseToken,
        remoteProductId,
      ),
    );
    return complete(remoteProductId);
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
