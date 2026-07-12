import type { AuditWriter, DomainAuditEvent } from "@wukong/core";

import type { WorkspaceTransaction } from "../client.js";
import { auditEvents } from "../schema.js";

export type WorkspaceAuditWriter = AuditWriter;

export function createAuditWriter(
  transaction: WorkspaceTransaction,
  workspaceId: string,
): WorkspaceAuditWriter {
  if (workspaceId.trim().length === 0) {
    throw new Error("workspaceId must not be empty");
  }

  return {
    async write(event: DomainAuditEvent): Promise<void> {
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
  };
}