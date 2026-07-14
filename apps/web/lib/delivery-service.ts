import { createHash } from "node:crypto";

import type { CanonicalListing, ComplianceFlag, ListingStatus } from "@wukong/core";
import {
  createShoplineCsv,
  projectToShopline,
  SHOPLINE_CSV_SPEC_VERSION,
  validateShoplineProduct,
  type ShoplineProductPayload,
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
  activeVersion: { id: string; sequence: number; content: CanonicalListing } | null;
  flags: ComplianceFlag[];
};

export type DeliveryResult =
  | { kind: "csv"; body: string; specVersion: string; versionId: string }
  | { kind: "queued"; jobId: string; versionId: string }
  | { kind: "approval_required" }
  | { kind: "blocking_flags"; issues: string[] }
  | { kind: "validation_error"; issues: string[] }
  | { kind: "disconnected"; csvFallback: { method: "csv"; path: string } }
  | { kind: "already_published"; remoteProductId: string | null };

export type DeliveryDeps = {
  listings: { requireForPublish(draftId: string): Promise<DeliverySnapshot> };
  imageUrls(assetIds: readonly string[]): Promise<readonly string[]>;
  audit: { write(event: { workspaceId: string; actorId: string; action: string; entityId: string; metadata?: Record<string, unknown> }): Promise<void> };
  publisher: {
    enqueue(input: {
      workspaceId: string;
      draftId: string;
      versionId: string;
      payloadDigest: string;
    }): Promise<string>;
  };
  connection?: { id: string; verified: boolean } | null;
  existingDelivery?: (idempotencyKey: string) => Promise<{ status: string; remoteProductId: string | null } | null>;
};

function digest(payload: ShoplineProductPayload): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function approved(status: ListingStatus): boolean {
  return status === "approved" || status === "published";
}

export async function deliverListing(
  input: DeliverInput,
  deps: DeliveryDeps,
): Promise<DeliveryResult> {
  const listing = await deps.listings.requireForPublish(input.draftId);
  if (listing.target !== "shopline" || !listing.activeVersion || !approved(listing.status)) {
    return { kind: "approval_required" };
  }
  const blocking = listing.flags.filter((flag) => flag.severity === "blocking" && (flag.status === "open" || (flag.status === "resolved" && flag.resolutionReason.trim().length < 10)));
  if (blocking.length > 0) {
    return {
      kind: "blocking_flags",
      issues: blocking.map((flag) => `${flag.field}: ${flag.rule}`),
    };
  }

  let payload: ShoplineProductPayload;
  try {
    payload = projectToShopline(
      listing.activeVersion.content,
      await deps.imageUrls(listing.activeVersion.content.imageAssetIds),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "SHOPLINE payload is invalid";
    return { kind: "validation_error", issues: [message] };
  }
  const validation = validateShoplineProduct(payload);
  if (!validation.valid) return { kind: "validation_error", issues: validation.issues.map((issue) => `${issue.path}: ${issue.message}`) };

  if (input.method === "csv") {
    const body = createShoplineCsv([validation.value]);
    await deps.audit.write({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: "listing.csv_exported",
      entityId: input.draftId,
      metadata: { versionId: listing.activeVersion.id, specVersion: SHOPLINE_CSV_SPEC_VERSION },
    });
    return { kind: "csv", body, specVersion: SHOPLINE_CSV_SPEC_VERSION, versionId: listing.activeVersion.id };
  }

  if (listing.status === "published") {
    const existing = deps.existingDelivery ? await deps.existingDelivery(`${input.workspaceId}:${listing.activeVersion.id}:shopline:create`) : null;
    if (existing?.status === "published" && existing.remoteProductId) return { kind: "already_published", remoteProductId: existing.remoteProductId };
    return { kind: "already_published", remoteProductId: null };
  }

  if (!deps.connection?.verified) {
    return {
      kind: "disconnected",
      csvFallback: { method: "csv", path: `/api/listings/${input.draftId}/deliver` },
    };
  }
  const jobId = await deps.publisher.enqueue({
    workspaceId: input.workspaceId,
    draftId: input.draftId,
    versionId: listing.activeVersion.id,
    payloadDigest: digest(validation.value),
  });
  await deps.audit.write({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: "listing.publish_queued",
    entityId: input.draftId,
    metadata: { versionId: listing.activeVersion.id, jobId },
  });
  return { kind: "queued", jobId, versionId: listing.activeVersion.id };
}

