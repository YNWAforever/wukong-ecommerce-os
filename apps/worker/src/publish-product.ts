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
  connectionId?: string;
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

export type PublishJobStatus = "queued" | "running" | "published" | "failed";

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
};

export type PublishRepositories = {
  listings: {
    requireForPublish(id: string): Promise<PublishListingSnapshot>;
    beginPublish(id: string, context: AuditContext, audit: AuditWriter): Promise<void>;
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
    ensure(input: {
      listingId: string;
      versionId: string;
      connectionId: string;
      idempotencyKey: string;
      payloadDigest: string;
    }): Promise<PublishJobRecord>;
    markRunning(key: string): Promise<void>;
    markPublished(key: string, remoteProductId: string, payloadDigest: string): Promise<void>;
    markFailed(key: string, errorCode: PublishErrorCode): Promise<void>;
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
  resolveImageUrls?: (
    workspaceId: string,
    imageAssetIds: readonly string[],
  ) => Promise<readonly string[]>;
};

export type PublishErrorCode = ConnectorErrorCode | "not_approved" | "blocking_flags" | "invalid_payload" | "invalid_connection";

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

const PUBLISH_ACTOR_ID = "worker:shopline-publish";

function context(input: PublishProductInput): AuditContext {
  return { workspaceId: input.workspaceId, actorId: PUBLISH_ACTOR_ID, entityId: input.draftId };
}

function digestPayload(payload: ShoplineProductPayload): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
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
  if (job.status !== "published" || !job.remoteProductId || !job.payloadDigest) {
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
  if (!connectionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId)) {
    throw new PublishDeliveryError("invalid_connection");
  }
  const prepared = await dependencies.withWorkspace(input.workspaceId, async (repositories) => {
    const listing = await repositories.listings.requireForPublish(input.draftId);
    if (listing.target !== "shopline" || !listing.activeVersion) {
      throw new PublishDeliveryError("not_approved");
    }

    const versionId = listing.activeVersion.id;
    const idempotencyKey = `${input.workspaceId}:${versionId}:shopline:create`;
    const existing = await repositories.publishJobs.getByIdempotencyKey(idempotencyKey);
    if (listing.flags.some(isUnresolvedBlockingFlag)) {
      throw new PublishDeliveryError("blocking_flags");
    }
    if (listing.status === "published") {
      if (existing?.status === "published") return { result: existingResult(existing) };
      throw new Error("published listing is missing its delivery record");
    }
    if (listing.status !== "approved" && listing.status !== "publishing" && listing.status !== "publish_failed") {
      throw new Error("Only the active approved version can be delivered");
    }
    if (existing?.status === "published") return { result: existingResult(existing) };
    const imageUrls = dependencies.resolveImageUrls
      ? await dependencies.resolveImageUrls(input.workspaceId, listing.activeVersion.content.imageAssetIds)
      : [];
    let payload: ShoplineProductPayload;
    try {
      payload = projectToShopline(listing.activeVersion.content, imageUrls);
    } catch {
      throw new PublishDeliveryError("invalid_payload");
    }
    const payloadDigest = digestPayload(payload);
    const job = await repositories.publishJobs.ensure({
      listingId: listing.id,
      versionId,
      connectionId,
      idempotencyKey,
      payloadDigest,
    });
    if (job.status === "published") return { result: existingResult(job) };

    const auditContext = context(input);
    if (listing.status === "approved" || listing.status === "publish_failed") {
      await repositories.listings.beginPublish(listing.id, auditContext, repositories.audit);
    }
    await repositories.publishJobs.markRunning(idempotencyKey);
    return { listing, job, payload, payloadDigest, idempotencyKey, versionId };
  });

  if ("result" in prepared && prepared.result !== undefined) return prepared.result;

  const { listing, job, payload, payloadDigest, idempotencyKey, versionId } = prepared;
  const auditContext = context(input);

  const complete = async (remoteProductId: string): Promise<PublishResult> => {
    await dependencies.withWorkspace(input.workspaceId, async (repositories) => {
      await repositories.publishJobs.markPublished(idempotencyKey, remoteProductId, payloadDigest);
      await repositories.listings.markPublished(
        listing.id,
        versionId,
        remoteProductId,
        payloadDigest,
        auditContext,
        repositories.audit,
      );
    });
    return { status: "published", remoteProductId, payloadDigest, idempotencyKey };
  };

  const fail = async (error: PublishDeliveryError): Promise<never> => {
    await dependencies.withWorkspace(input.workspaceId, async (repositories) => {
      await repositories.publishJobs.markFailed(idempotencyKey, error.code);
      await repositories.listings.markPublishFailed(listing.id, versionId, error.code, auditContext, repositories.audit);
    });
    throw error;
  };

  if (job.remoteProductId) {
    try {
      const status = await dependencies.connector.getProductStatus(job.remoteProductId);
      if (status.exists) return complete(job.remoteProductId);
    } catch (error) {
      const normalized = normalizeConnectorError(error);
      if (normalized.code !== "remote_unavailable") return fail(normalized);
    }
  }

  let createError: PublishDeliveryError | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const created = await dependencies.connector.createProduct(payload, idempotencyKey);
      return complete(created.remoteProductId);
    } catch (error) {
      createError = normalizeConnectorError(error);
      if (createError.code !== "remote_unavailable") return fail(createError);
      if (attempt === 0 && job.remoteProductId) {
        try {
          const status = await dependencies.connector.getProductStatus(job.remoteProductId);
          if (status.exists) return complete(job.remoteProductId);
        } catch (statusError) {
          createError = normalizeConnectorError(statusError);
        }
      }
    }
  }
  return fail(createError ?? new PublishDeliveryError("remote_unavailable"));
}
