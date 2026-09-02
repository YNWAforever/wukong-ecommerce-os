import { and, desc, eq } from "drizzle-orm";

import type { AuditWriter, DomainAuditEvent } from "@wukong/core";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { auditEvents } from "../schema.js";

export type AuditEventRecord = {
  id: string;
  actorId: string;
  entityId: string;
  action: string;
  metadata: unknown;
  createdAt: Date;
};

export type WorkspaceAuditWriter = AuditWriter & {
  findRelatedToListing(listingId: string): Promise<AuditEventRecord[]>;
};

export function createAuditWriter(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): WorkspaceAuditWriter {
  if (workspaceId.trim().length === 0) {
    throw new Error("workspaceId must not be empty");
  }

  return {
    async write(event: DomainAuditEvent): Promise<void> {
      scope.assertOpen();
      if (event.workspaceId !== workspaceId) {
        throw new Error("audit event workspace does not match transaction workspace");
      }
      await transaction.insert(auditEvents).values({
        workspaceId,
        actorId: event.actorId,
        entityId: event.entityId,
        action: event.action,
        metadata: event.metadata,
      });
    },

    async findRelatedToListing(listingId: string): Promise<AuditEventRecord[]> {
      scope.assertOpen();
      const rows = await transaction
        .select({
          id: auditEvents.id,
          actorId: auditEvents.actorId,
          entityId: auditEvents.entityId,
          action: auditEvents.action,
          metadata: auditEvents.metadata,
          createdAt: auditEvents.createdAt,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, workspaceId),
            eq(auditEvents.entityId, listingId),
          ),
        )
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id));
      return rows;
    },
  };
}
