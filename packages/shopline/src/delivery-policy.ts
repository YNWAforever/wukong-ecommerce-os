import { createHash } from "node:crypto";

import type {
  CanonicalListing,
  ComplianceFlag,
  ListingStatus,
} from "@wukong/core";

import { projectToShopline, type ShoplineProductPayload } from "./projection.js";
import {
  ShoplineValidationError,
  type ShoplineValidationIssue,
} from "./validation.js";

export type DeliveryMethod = "shopline_api" | "csv";
export type DeliveryPolicyPhase = "request" | "worker";

export type DeliveryListingSnapshot = {
  workspaceId: string;
  draftId: string;
  target: string;
  status: ListingStatus;
  activeVersion: { id: string; content: CanonicalListing } | null;
  flags: readonly ComplianceFlag[];
};

export type DeliveryConnectionSnapshot = {
  id: string;
  workspaceId: string;
  verified: boolean;
};

export type DeliveryJobSnapshot = {
  id: string;
  versionId: string;
  status: string;
  idempotencyKey: string;
  payloadDigest: string | null;
  connectionId: string | null;
};

export type DeliveryPolicyInput = {
  method: DeliveryMethod;
  phase: DeliveryPolicyPhase;
  listing: DeliveryListingSnapshot | null;
  imageUrls: readonly string[];
  connection: DeliveryConnectionSnapshot | null;
  job: DeliveryJobSnapshot | null;
};

export type DeliveryAuditFacts = {
  workspaceId: string | null;
  draftId: string | null;
  method: DeliveryMethod | string;
  phase: DeliveryPolicyPhase;
  versionId: string | null;
  payloadDigest?: string;
  connectionId?: string;
  reason: string;
};

export type DeliveryPlan = {
  method: DeliveryMethod;
  workspaceId: string;
  draftId: string;
  versionId: string;
  payload: ShoplineProductPayload;
  payloadDigest: string;
  connectionId?: string;
  idempotencyKey?: string;
  auditFacts: DeliveryAuditFacts;
};

export type DeliveryPolicyOutcome =
  | { kind: "ready"; plan: DeliveryPlan }
  | { kind: "not_found"; auditFacts: DeliveryAuditFacts }
  | { kind: "approval_required"; auditFacts: DeliveryAuditFacts }
  | { kind: "blocking_flags"; flags: ComplianceFlag[]; auditFacts: DeliveryAuditFacts }
  | { kind: "validation_error"; issues: ShoplineValidationIssue[]; auditFacts: DeliveryAuditFacts }
  | { kind: "already_published"; remoteProductId: string | null; auditFacts: DeliveryAuditFacts }
  | {
      kind: "disconnected";
      csvFallback: { method: "csv"; path: string };
      auditFacts: DeliveryAuditFacts;
    }
  | {
      kind: "stale_plan";
      expected: { versionId: string; payloadDigest: string };
      observed: { versionId: string | null; payloadDigest: string | null };
      auditFacts: DeliveryAuditFacts;
    };

function auditFacts(
  input: DeliveryPolicyInput,
  reason: string,
  versionId = input.listing?.activeVersion?.id ?? null,
  payloadDigest = input.listing?.activeVersion
    ? hashCanonicalListing(input.listing.activeVersion.content)
    : undefined,
): DeliveryAuditFacts {
  return {
    workspaceId: input.listing?.workspaceId ?? null,
    draftId: input.listing?.draftId ?? null,
    method: input.method,
    phase: input.phase,
    versionId,
    ...(payloadDigest === undefined ? {} : { payloadDigest }),
    ...(input.connection ? { connectionId: input.connection.id } : {}),
    reason,
  };
}

function isEligibleStatus(phase: DeliveryPolicyPhase, status: ListingStatus): boolean {
  return phase === "request"
    ? status === "approved" || status === "published"
    : status === "approved" || status === "publishing" || status === "publish_failed";
}

function validationIssue(message: string): ShoplineValidationIssue[] {
  return [{ code: "invalid_shape", path: "payload", message }];
}

/** Preserves the legacy SHA-256 digest of JSON.stringify(canonical listing). */
export function hashCanonicalListing(listing: CanonicalListing): string {
  return createHash("sha256").update(JSON.stringify(listing), "utf8").digest("hex");
}

/**
 * Evaluates delivery facts without reading adapters or invoking provider code.
 * Callers own persistence, CSV serialization, queue ingress, audit writes, and connectors.
 */
export function evaluateDeliveryPolicy(input: DeliveryPolicyInput): DeliveryPolicyOutcome {
  if (!input.listing) return { kind: "not_found", auditFacts: auditFacts(input, "not_found") };
  if (input.method !== "shopline_api" && input.method !== "csv") {
    return { kind: "approval_required", auditFacts: auditFacts(input, "unsupported_method") };
  }

  const { listing } = input;
  if (listing.target !== "shopline") {
    return { kind: "approval_required", auditFacts: auditFacts(input, "wrong_target") };
  }
  if (!listing.activeVersion) {
    return { kind: "approval_required", auditFacts: auditFacts(input, "missing_active_version") };
  }

  const { id: versionId, content } = listing.activeVersion;
  const payloadDigest = hashCanonicalListing(content);
  if (input.phase === "worker") {
    const observed = {
      versionId: input.job?.versionId ?? null,
      payloadDigest: input.job?.payloadDigest ?? null,
    };
    if (observed.versionId !== versionId || observed.payloadDigest !== payloadDigest) {
      return {
        kind: "stale_plan",
        expected: { versionId, payloadDigest },
        observed,
        auditFacts: auditFacts(input, "stale_plan", versionId, payloadDigest),
      };
    }
  }

  if (!isEligibleStatus(input.phase, listing.status)) {
    return { kind: "approval_required", auditFacts: auditFacts(input, "status_not_eligible", versionId, payloadDigest) };
  }

  const blockingFlags = listing.flags.filter(
    (flag) => flag.severity === "blocking" && flag.status === "open",
  );
  if (blockingFlags.length > 0) {
    return {
      kind: "blocking_flags",
      flags: [...blockingFlags],
      auditFacts: auditFacts(input, "blocking_flags", versionId, payloadDigest),
    };
  }

  if (input.method === "shopline_api" && input.phase === "request" && listing.status === "published") {
    return {
      kind: "already_published",
      remoteProductId: null,
      auditFacts: auditFacts(input, "already_published", versionId, payloadDigest),
    };
  }

  let payload: ShoplineProductPayload;
  try {
    payload = projectToShopline(content, input.imageUrls);
  } catch (error) {
    const issues = error instanceof ShoplineValidationError
      ? error.issues
      : validationIssue(error instanceof Error ? error.message : "SHOPLINE payload is invalid");
    return {
      kind: "validation_error",
      issues,
      auditFacts: auditFacts(input, "validation_error", versionId, payloadDigest),
    };
  }

  if (input.method === "shopline_api") {
    if (!input.connection || !input.connection.verified || input.connection.workspaceId !== listing.workspaceId) {
      return {
        kind: "disconnected",
        csvFallback: { method: "csv", path: `/api/listings/${listing.draftId}/deliver` },
        auditFacts: auditFacts(input, "disconnected", versionId, payloadDigest),
      };
    }
    const idempotencyKey = `${listing.workspaceId}:${versionId}:shopline:create`;
    return {
      kind: "ready",
      plan: {
        method: input.method,
        workspaceId: listing.workspaceId,
        draftId: listing.draftId,
        versionId,
        payload,
        payloadDigest,
        connectionId: input.connection.id,
        idempotencyKey,
        auditFacts: auditFacts(input, "ready", versionId, payloadDigest),
      },
    };
  }

  return {
    kind: "ready",
    plan: {
      method: input.method,
      workspaceId: listing.workspaceId,
      draftId: listing.draftId,
      versionId,
      payload,
      payloadDigest,
      auditFacts: auditFacts(input, "ready", versionId, payloadDigest),
    },
  };
}
