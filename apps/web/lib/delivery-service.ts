import type {
  CanonicalListing,
  ComplianceFlag,
  ListingStatus,
} from "@wukong/core";
import {
  createShoplineCsv,
  evaluateDeliveryPolicy,
  SHOPLINE_CSV_SPEC_VERSION,
  type DeliveryAuditFacts,
  type DeliveryConnectionSnapshot,
  type DeliveryJobSnapshot,
  type DeliveryListingSnapshot,
  type DeliveryPolicyOutcome,
} from "@wukong/shopline";

export type DeliverInput = {
  workspaceId: string;
  actorId: string;
  draftId: string;
  method: "csv" | "shopline_api";
};

export type DeliverySnapshot = {
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

export type DeliveryResult =
  | { kind: "csv"; body: string; specVersion: string; versionId: string }
  | { kind: "queued"; jobId: string; versionId: string }
  | { kind: "retry_required"; jobId: string; versionId: string }
  | { kind: "approval_required" }
  | { kind: "blocking_flags"; issues: string[] }
  | { kind: "validation_error"; issues: string[] }
  | { kind: "disconnected"; csvFallback: { method: "csv"; path: string } }
  | { kind: "already_published"; remoteProductId: string | null };

export type DeliveryDeps = {
  listings: { requireForPublish(draftId: string): Promise<DeliverySnapshot> };
  imageUrls(
    workspaceId: string,
    draftId: string,
    assetIds: readonly string[],
  ): Promise<readonly string[]>;
  audit: {
    write(event: {
      workspaceId: string;
      actorId: string;
      action: string;
      entityId: string;
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
  publisher: {
    enqueue(input: {
      workspaceId: string;
      draftId: string;
      versionId: string;
      payloadDigest: string;
    }): Promise<string>;
  };
  connection?: () => Promise<{ id: string; verified: boolean } | null>;
  existingDelivery?: (
    idempotencyKey: string,
  ) => Promise<{
    id?: string;
    versionId?: string;
    status: string;
    idempotencyKey?: string;
    payloadDigest?: string | null;
    connectionId?: string | null;
    remoteProductId: string | null;
  } | null>;
};

export type DeliverySnapshotReader = {
  read(input: Pick<DeliverInput, "workspaceId" | "draftId" | "method">): Promise<DeliveryPolicySnapshot>;
};

export type DeliveryPolicySnapshot = {
  listing: DeliveryListingSnapshot;
  imageUrls: readonly string[];
  connection: DeliveryConnectionSnapshot | null;
  job: DeliveryJobSnapshot | null;
  existingDelivery: Awaited<ReturnType<NonNullable<DeliveryDeps["existingDelivery"]>>>;
};

export function createDeliverySnapshotReader(
  deps: Pick<DeliveryDeps, "listings" | "imageUrls" | "connection" | "existingDelivery">,
  options: { deferImageUrls?: boolean } = {},
): DeliverySnapshotReader {
  async function read(
    input: Pick<DeliverInput, "workspaceId" | "draftId" | "method">,
  ): Promise<DeliveryPolicySnapshot> {
    const source = await deps.listings.requireForPublish(input.draftId);
    const listing: DeliveryListingSnapshot = {
      workspaceId: input.workspaceId,
      draftId: input.draftId,
      target: source.target,
      status: source.status,
      activeVersion: source.activeVersion,
      flags: source.flags,
    };
    const configuredConnection = deps.connection
      ? await deps.connection()
      : null;
    const connection = configuredConnection
      ? { ...configuredConnection, workspaceId: input.workspaceId }
      : null;
    const existingDelivery =
      input.method === "shopline_api" && listing.activeVersion && deps.existingDelivery
        ? await deps.existingDelivery(
            `${input.workspaceId}:${listing.activeVersion.id}:shopline:create`,
          )
        : null;
    const job = existingDelivery?.id && existingDelivery.versionId && existingDelivery.idempotencyKey
      ? {
          id: existingDelivery.id,
          versionId: existingDelivery.versionId,
          status: existingDelivery.status,
          idempotencyKey: existingDelivery.idempotencyKey,
          payloadDigest: existingDelivery.payloadDigest ?? null,
          connectionId: existingDelivery.connectionId ?? null,
        }
      : null;
    const imageUrls = listing.activeVersion && !options.deferImageUrls
      ? await deps.imageUrls(
          input.workspaceId,
          input.draftId,
          listing.activeVersion.content.imageAssetIds,
        )
      : [];
    return { listing, imageUrls, connection, job, existingDelivery };
  }

  return { read };
}

async function withResolvedImageUrls(
  snapshot: DeliveryPolicySnapshot,
  deps: Pick<DeliveryDeps, "imageUrls">,
): Promise<DeliveryPolicySnapshot> {
  const activeVersion = snapshot.listing.activeVersion;
  if (!activeVersion) return snapshot;
  return {
    ...snapshot,
    imageUrls: await deps.imageUrls(
      snapshot.listing.workspaceId,
      snapshot.listing.draftId,
      activeVersion.content.imageAssetIds,
    ),
  };
}

function auditMetadata(facts: DeliveryAuditFacts, metadata: Record<string, unknown> = {}) {
  return { ...facts, ...metadata };
}

function resultFromPolicy(
  outcome: Exclude<DeliveryPolicyOutcome, { kind: "ready" }>,
  snapshot: DeliveryPolicySnapshot,
): Exclude<DeliveryResult, { kind: "csv" | "queued" | "retry_required" }> {
  switch (outcome.kind) {
    case "blocking_flags":
      return { kind: "blocking_flags", issues: outcome.flags.map((flag) => `${flag.field}: ${flag.rule}`) };
    case "validation_error":
      return { kind: "validation_error", issues: outcome.issues.map((issue) => `${issue.path}: ${issue.message}`) };
    case "already_published":
      return {
        kind: "already_published",
        remoteProductId: snapshot.existingDelivery?.status === "published"
          ? snapshot.existingDelivery.remoteProductId
          : outcome.remoteProductId,
      };
    case "disconnected":
      return { kind: "disconnected", csvFallback: outcome.csvFallback };
    case "not_found":
    case "approval_required":
    case "stale_plan":
      return { kind: "approval_required" };
  }
}

export type ShoplinePublishRequest = {
  kind: "publish_request";
  jobId: string;
  versionId: string;
  connectionId: string;
  workspaceId: string;
  actorId: string;
  draftId: string;
  idempotencyKey: string;
  payloadDigest: string;
  auditFacts: DeliveryAuditFacts;
};

export type ShoplinePreparationResult =
  | ShoplinePublishRequest
  | Extract<
      DeliveryResult,
      {
        kind:
          | "approval_required"
          | "blocking_flags"
          | "validation_error"
          | "disconnected"
          | "already_published"
          | "queued"
          | "retry_required";
      }
    >;

export type ShoplineDeliveryDeps = Omit<DeliveryDeps, "publisher"> & {
  publishJobs: {
    ensure(input: {
      listingId: string;
      versionId: string;
      connectionId: string;
      idempotencyKey: string;
      payloadDigest: string;
    }): Promise<{ id: string; status: string; connectionId: string }>;
    markQueued(key: string): Promise<boolean>;
  };
};

export async function prepareShoplineDelivery(
  input: DeliverInput,
  deps: ShoplineDeliveryDeps,
): Promise<ShoplinePreparationResult> {
  const reader = createDeliverySnapshotReader(deps, { deferImageUrls: true });
  const snapshot = await reader.read(input);
  const outcome = evaluateDeliveryPolicy({ ...input, phase: "request", ...snapshot });
  if (outcome.kind !== "ready") return resultFromPolicy(outcome, snapshot);

  const resolvedSnapshot = await withResolvedImageUrls(snapshot, deps);
  const resolvedOutcome = evaluateDeliveryPolicy({
    ...input,
    phase: "request",
    ...resolvedSnapshot,
  });
  if (resolvedOutcome.kind !== "ready")
    return resultFromPolicy(resolvedOutcome, resolvedSnapshot);

  const { plan } = resolvedOutcome;
  const job = await deps.publishJobs.ensure({
    listingId: snapshot.listing.draftId,
    versionId: plan.versionId,
    connectionId: plan.connectionId!,
    idempotencyKey: plan.idempotencyKey!,
    payloadDigest: plan.payloadDigest,
  });
  if (job.status === "queued" || job.status === "running") {
    return { kind: "queued", jobId: job.id, versionId: plan.versionId };
  }
  if (job.status !== "pending_enqueue") {
    return { kind: "retry_required", jobId: job.id, versionId: plan.versionId };
  }
  const auditFacts = { ...plan.auditFacts, connectionId: job.connectionId };
  await deps.audit.write({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: "listing.publish_requested",
    entityId: input.draftId,
    metadata: auditMetadata(auditFacts, { jobId: job.id }),
  });
  return {
    kind: "publish_request",
    jobId: job.id,
    versionId: plan.versionId,
    connectionId: job.connectionId,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    draftId: input.draftId,
    idempotencyKey: plan.idempotencyKey!,
    payloadDigest: plan.payloadDigest,
    auditFacts,
  };
}

export type ConfirmShoplineDeliveryDeps = {
  audit: DeliveryDeps["audit"];
  publishJobs: {
    markQueued(key: string): Promise<boolean>;
    getByIdempotencyKey?(
      key: string,
    ): Promise<{ id: string; status: string } | null>;
  };
};

export async function confirmShoplineQueued(
  prepared: ShoplinePublishRequest,
  deps: ConfirmShoplineDeliveryDeps,
): Promise<Extract<DeliveryResult, { kind: "queued" | "retry_required" }>> {
  const transitioned = await deps.publishJobs.markQueued(
    prepared.idempotencyKey,
  );
  if (!transitioned) {
    const job = await deps.publishJobs.getByIdempotencyKey?.(
      prepared.idempotencyKey,
    );
    if (
      !job ||
      job.id !== prepared.jobId ||
      !["queued", "running", "published"].includes(job.status)
    ) {
      return {
        kind: "retry_required",
        jobId: prepared.jobId,
        versionId: prepared.versionId,
      };
    }
  } else {
    await deps.audit.write({
      workspaceId: prepared.workspaceId,
      actorId: prepared.actorId,
      action: "listing.publish_queued",
      entityId: prepared.draftId,
      metadata: auditMetadata(prepared.auditFacts, { jobId: prepared.jobId }),
    });
  }
  return {
    kind: "queued",
    jobId: prepared.jobId,
    versionId: prepared.versionId,
  };
}

export async function deliverListing(
  input: DeliverInput,
  deps: DeliveryDeps,
): Promise<DeliveryResult> {
  const reader = createDeliverySnapshotReader(deps);
  const snapshot = await reader.read(input);
  const outcome = evaluateDeliveryPolicy({ ...input, phase: "request", ...snapshot });
  if (outcome.kind !== "ready") return resultFromPolicy(outcome, snapshot);

  const { plan } = outcome;

  if (input.method === "csv") {
    const body = createShoplineCsv([plan.payload]);
    await deps.audit.write({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: "listing.csv_exported",
      entityId: input.draftId,
      metadata: auditMetadata(plan.auditFacts, {
        specVersion: SHOPLINE_CSV_SPEC_VERSION,
      }),
    });
    return {
      kind: "csv",
      body,
      specVersion: SHOPLINE_CSV_SPEC_VERSION,
      versionId: plan.versionId,
    };
  }

  const jobId = await deps.publisher.enqueue({
    workspaceId: input.workspaceId,
    draftId: input.draftId,
    versionId: plan.versionId,
    payloadDigest: plan.payloadDigest,
  });
  await deps.audit.write({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: "listing.publish_queued",
    entityId: input.draftId,
    metadata: auditMetadata(plan.auditFacts, { jobId }),
  });
  return { kind: "queued", jobId, versionId: plan.versionId };
}
