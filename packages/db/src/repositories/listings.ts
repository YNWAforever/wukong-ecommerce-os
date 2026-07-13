import { and, desc, eq } from "drizzle-orm";

import { canonicalListingSchema } from "@wukong/core";
import type { AuditContext, AuditWriter, CanonicalListing, ComplianceFlag, FieldEvidence, ListingAction, ListingStatus } from "@wukong/core";
import { transitionListing } from "@wukong/core";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { complianceFlags, fieldEvidence, listingDrafts, listingVersions, workspaces } from "../schema.js";

export type Listing = typeof listingDrafts.$inferSelect;

export type CreateListingInput = { target: "shopline"; note?: string | null };
export type ListingVersion = { id: string; sequence: number };

export type ListingRepository = {
  create(input: CreateListingInput): Promise<Listing>;
  getById(id: string): Promise<Listing | null>;
  requireById(id: string): Promise<Listing & { activeVersionSequence: number }>;
  requireForPublish(id: string): Promise<{ id: string; target: "shopline"; status: ListingStatus; activeVersion: { id: string; sequence: number; content: CanonicalListing } | null; flags: ComplianceFlag[] }>;
  beginPublish(id: string, context: AuditContext, audit: AuditWriter): Promise<void>;
  markPublished(id: string, versionId: string, remoteProductId: string, payloadDigest: string, context: AuditContext, audit: AuditWriter): Promise<void>;
  markPublishFailed(id: string, versionId: string, errorCode: string, context: AuditContext, audit: AuditWriter): Promise<void>;
  startProcessing(id: string, context: AuditContext, audit: AuditWriter): Promise<void>;
  appendVersion(id: string, content: CanonicalListing, context: AuditContext, audit: AuditWriter, pipelineIdempotencyKey?: string): Promise<ListingVersion>;
  replaceEvidence(versionId: string, evidence: FieldEvidence[]): Promise<void>;
  replaceFlags(versionId: string, flags: ComplianceFlag[]): Promise<void>;
  complete(id: string, result: { status: "in_review" | "needs_info"; versionId: string | null; idempotencyKey: string }, context: AuditContext, audit: AuditWriter): Promise<void>;
  fail(id: string, errorCode: string, context: AuditContext, audit: AuditWriter): Promise<void>;
};

type Audit = { write(event: any): Promise<void> };

export function createListingRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ListingRepository {
  if (workspaceId.trim().length === 0) throw new Error("workspaceId must not be empty");
  const byId = (id: string) => and(eq(listingDrafts.workspaceId, workspaceId), eq(listingDrafts.id, id));

  return {
    async create(input) {
      scope.assertOpen();
      await transaction.insert(workspaces).values({ id: workspaceId, name: workspaceId, profile: {} }).onConflictDoNothing();
      const [created] = await transaction.insert(listingDrafts).values({ workspaceId, target: input.target, note: input.note ?? null }).returning();
      if (!created) throw new Error("listing insert did not return a row");
      return created;
    },

    async getById(id) {
      scope.assertOpen();
      const [listing] = await transaction.select().from(listingDrafts).where(byId(id)).limit(1);
      return listing ?? null;
    },

    async requireById(id) {
      const listing = await this.getById(id);
      if (!listing) throw new Error("listing not found");
      const [active] = listing.activeVersionId ? await transaction.select({ sequence: listingVersions.sequence }).from(listingVersions).where(and(eq(listingVersions.workspaceId, workspaceId), eq(listingVersions.id, listing.activeVersionId))).limit(1) : [];
      return { ...listing, activeVersionSequence: active?.sequence ?? 0 };
    },

    async requireForPublish(id) {
      scope.assertOpen();
      const listing = await this.requireById(id);
      const activeVersion = listing.activeVersionId
        ? (await transaction.select({ id: listingVersions.id, sequence: listingVersions.sequence, content: listingVersions.content }).from(listingVersions).where(and(eq(listingVersions.workspaceId, workspaceId), eq(listingVersions.id, listing.activeVersionId))).limit(1))[0] ?? null
        : null;
      const rows = activeVersion
        ? await transaction.select({ code: complianceFlags.code, severity: complianceFlags.severity, status: complianceFlags.status, details: complianceFlags.details }).from(complianceFlags).where(and(eq(complianceFlags.workspaceId, workspaceId), eq(complianceFlags.listingVersionId, activeVersion.id)))
        : [];
      const flags: ComplianceFlag[] = rows.flatMap((row): ComplianceFlag[] => {
        const details = (row.details ?? {}) as Record<string, unknown>;
        if ((row.severity !== "blocking" && row.severity !== "warning") || (row.status !== "open" && row.status !== "resolved")) return [];
        const idValue = typeof details.id === "string" ? details.id : `${row.code}:${String(details.field ?? "unknown")}`;
        const field = typeof details.field === "string" ? details.field : "unknown";
        if (row.status === "resolved") {
          const reason = typeof details.resolutionReason === "string" ? details.resolutionReason : "";
          return [{ id: idValue, field, rule: row.code as ComplianceFlag["rule"], severity: row.severity as "blocking" | "warning", status: "resolved", resolutionReason: reason }];
        }
        return [{ id: idValue, field, rule: row.code as ComplianceFlag["rule"], severity: row.severity as "blocking" | "warning", status: "open", resolutionReason: null }];
      });
      const parsedContent = activeVersion ? canonicalListingSchema.safeParse(activeVersion.content) : null;
      if (activeVersion && !parsedContent?.success) throw new Error("active listing version content is invalid");
      return { id: listing.id, target: "shopline" as const, status: listing.status as ListingStatus, activeVersion: activeVersion && parsedContent?.success ? { id: activeVersion.id, sequence: activeVersion.sequence, content: parsedContent.data } : null, flags };
    },

    async beginPublish(id, context, audit) {
      scope.assertOpen();
      const listing = await this.requireById(id);
      if (listing.status === "publishing") return;
      const next = await transitionListing(listing.status, "begin_publish", context, audit);
      const updated = await transaction.update(listingDrafts).set({ status: next, updatedAt: new Date() }).where(and(byId(id), eq(listingDrafts.status, listing.status))).returning({ id: listingDrafts.id });
      if (updated.length !== 1) throw new Error("listing status changed while beginning publish");
    },

    async markPublished(id, versionId, remoteProductId, payloadDigest, context, audit) {
      scope.assertOpen();
      const listing = await this.requireById(id);
      if (listing.status === "published" && listing.activeVersionId === versionId) return;
      if (listing.status !== "publishing") throw new Error("listing is not publishing");
      const next = await transitionListing(listing.status, "publish_succeeded", context, audit);
      const updated = await transaction.update(listingDrafts).set({ status: next, activeVersionId: versionId, updatedAt: new Date() }).where(and(byId(id), eq(listingDrafts.status, listing.status))).returning({ id: listingDrafts.id });
      if (updated.length !== 1) throw new Error("listing status changed while completing publish");
      await audit.write({ ...context, action: "listing.published", metadata: { versionId, remoteProductId, payloadDigest } });
    },

    async markPublishFailed(id, versionId, errorCode, context, audit) {
      scope.assertOpen();
      const listing = await this.requireById(id);
      if (listing.status === "publish_failed") return;
      if (listing.status !== "publishing") throw new Error("listing is not publishing");
      const next = await transitionListing(listing.status, "publish_failed", context, audit);
      const updated = await transaction.update(listingDrafts).set({ status: next, activeVersionId: versionId, updatedAt: new Date() }).where(and(byId(id), eq(listingDrafts.status, listing.status))).returning({ id: listingDrafts.id });
      if (updated.length !== 1) throw new Error("listing status changed while failing publish");
      await audit.write({ ...context, action: "listing.publish_failed", metadata: { versionId, errorCode } });
    },
    async startProcessing(id, context, audit) {
      scope.assertOpen();
      const listing = await this.requireById(id);
      if (listing.status === "processing") return;
      const action: ListingAction = listing.status === "failed" ? "retry" : "start_processing";
      const next = await transitionListing(listing.status, action, context, audit);
      const updated = await transaction.update(listingDrafts).set({ status: next, updatedAt: new Date() }).where(and(byId(id), eq(listingDrafts.status, listing.status))).returning({ id: listingDrafts.id });
      if (updated.length !== 1) throw new Error("listing status changed while starting processing");
    },

    async appendVersion(id, content, context, audit, pipelineIdempotencyKey) {
      scope.assertOpen();
      if (pipelineIdempotencyKey) {
        const [existing] = await transaction.select({ id: listingVersions.id, sequence: listingVersions.sequence }).from(listingVersions).where(and(eq(listingVersions.workspaceId, workspaceId), eq(listingVersions.listingId, id), eq(listingVersions.pipelineIdempotencyKey, pipelineIdempotencyKey))).limit(1);
        if (existing) return existing;
      }
      const [latest] = await transaction.select({ sequence: listingVersions.sequence }).from(listingVersions).where(and(eq(listingVersions.workspaceId, workspaceId), eq(listingVersions.listingId, id))).orderBy(desc(listingVersions.sequence)).limit(1);
      const [created] = await transaction.insert(listingVersions).values({ workspaceId, listingId: id, sequence: (latest?.sequence ?? 0) + 1, pipelineIdempotencyKey: pipelineIdempotencyKey ?? null, content, createdBy: context.actorId }).onConflictDoNothing().returning({ id: listingVersions.id, sequence: listingVersions.sequence });
      if (created) {
        await audit.write({ ...context, action: "listing.version_appended", metadata: { versionId: created.id, sequence: created.sequence } });
        return created;
      }
      if (pipelineIdempotencyKey) {
        const [existing] = await transaction.select({ id: listingVersions.id, sequence: listingVersions.sequence }).from(listingVersions).where(and(eq(listingVersions.workspaceId, workspaceId), eq(listingVersions.listingId, id), eq(listingVersions.pipelineIdempotencyKey, pipelineIdempotencyKey))).limit(1);
        if (existing) return existing;
      }
      throw new Error("listing version insert did not return a row");
    },

    async replaceEvidence(versionId, evidence) {
      scope.assertOpen();
      await transaction.delete(fieldEvidence).where(and(eq(fieldEvidence.workspaceId, workspaceId), eq(fieldEvidence.listingVersionId, versionId)));
      if (evidence.length === 0) return;
      await transaction.insert(fieldEvidence).values(evidence.map((entry) => ({ workspaceId, listingVersionId: versionId, sourceAssetId: entry.sourceAssetId === "note" ? null : entry.sourceAssetId, fieldPath: entry.field, evidence: { page: entry.page, excerpt: entry.excerpt, confidence: entry.confidence } })));
    },

    async replaceFlags(versionId, flags) {
      scope.assertOpen();
      await transaction.delete(complianceFlags).where(and(eq(complianceFlags.workspaceId, workspaceId), eq(complianceFlags.listingVersionId, versionId)));
      if (flags.length === 0) return;
      await transaction.insert(complianceFlags).values(flags.map((flag) => ({ workspaceId, listingVersionId: versionId, code: flag.rule, severity: flag.severity, status: flag.status, details: { id: flag.id, field: flag.field, resolutionReason: flag.resolutionReason }, resolvedAt: flag.status === "resolved" ? new Date() : null })));
    },

    async complete(id, result, context, audit) {
      scope.assertOpen();
      const listing = await this.requireById(id);
      if (listing.status === result.status && listing.activeVersionId === result.versionId) return;
      if (listing.status !== result.status) {
        const action: ListingAction = result.status === "needs_info" ? "request_info" : "submit_review";
        const next = await transitionListing(listing.status, action, context, audit);
        if (next !== result.status) throw new Error("listing transition did not reach requested status");
      }
      const updated = await transaction.update(listingDrafts).set({ status: result.status, activeVersionId: result.versionId, updatedAt: new Date() }).where(and(byId(id), eq(listingDrafts.status, listing.status))).returning({ id: listingDrafts.id });
      if (updated.length !== 1 && listing.status !== result.status) throw new Error("listing status changed while completing pipeline");
      await audit.write({ ...context, action: result.status === "in_review" ? "listing.submitted_for_review" : "listing.info_requested", metadata: { versionId: result.versionId, idempotencyKey: result.idempotencyKey } });
    },

    async fail(id, errorCode, context, audit) {
      scope.assertOpen();
      const listing = await this.requireById(id);
      if (listing.status === "processing") {
        const next = await transitionListing(listing.status, "fail", context, audit);
        await transaction.update(listingDrafts).set({ status: next, updatedAt: new Date() }).where(and(byId(id), eq(listingDrafts.status, listing.status)));
      }
      if (listing.status !== "failed") await audit.write({ ...context, action: "listing.pipeline_failed", metadata: { errorCode } });
    },
  };
}