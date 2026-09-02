import { and, desc, eq, gte, sql } from "drizzle-orm";

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
  /** Newest-first, this workspace's events for this listing only. `limit`
   * defaults to 100 and must be between 1 and 100, matching every sibling
   * repository's own `listForWorkspace`-style bound. */
  findRelatedToListing(
    listingId: string,
    limit?: number,
  ): Promise<AuditEventRecord[]>;

  countByActionSince(action: string, since: Date): Promise<number>;
  countByActionAndMetadataKeySince(
    action: string,
    metadataKey: string,
    since: Date,
  ): Promise<Array<{ value: string | null; count: number }>>;
  sumImportMetricsSince(since: Date): Promise<{
    parsedRows: number;
    createdDrafts: number;
    refreshedProducts: number;
    issueCount: number;
  }>;
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
        throw new Error(
          "audit event workspace does not match transaction workspace",
        );
      }
      await transaction.insert(auditEvents).values({
        workspaceId,
        actorId: event.actorId,
        entityId: event.entityId,
        action: event.action,
        metadata: event.metadata,
      });
    },

    async findRelatedToListing(listingId, limit = 100) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error(
          "audit findRelatedToListing limit must be between 1 and 100",
        );
      }
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
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(limit);
      return rows;
    },

    async countByActionSince(action, since) {
      scope.assertOpen();
      const [row] = await transaction
        .select({ count: sql<number>`count(*)::int` })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, workspaceId),
            eq(auditEvents.action, action),
            gte(auditEvents.createdAt, since),
          ),
        );
      return row?.count ?? 0;
    },

    async countByActionAndMetadataKeySince(action, metadataKey, since) {
      scope.assertOpen();
      // The computed jsonb-field expression is defined once, aliased, and
      // grouped by that alias -- not re-interpolated in both the select list
      // and the group-by clause. Two separate `sql` interpolations of the
      // same `metadataKey` value produce two different bound-parameter
      // placeholders ($1 vs $N), which Postgres's GROUP BY validity check
      // treats as syntactically distinct expressions even though they
      // evaluate to the same string at runtime -- grouping by the SELECT
      // list's own output alias sidesteps that entirely (a standard,
      // Postgres-supported pattern for this exact class of query).
      const value = sql<
        string | null
      >`${auditEvents.metadata}->>${metadataKey}`.as("value");
      const rows = await transaction
        .select({
          value,
          count: sql<number>`count(*)::int`,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, workspaceId),
            eq(auditEvents.action, action),
            gte(auditEvents.createdAt, since),
          ),
        )
        .groupBy(value);
      return rows;
    },

    async sumImportMetricsSince(since) {
      scope.assertOpen();
      const [row] = await transaction
        .select({
          parsedRows: sql<number>`coalesce(sum((${auditEvents.metadata}->>'parsedRows')::int), 0)::int`,
          createdDrafts: sql<number>`coalesce(sum((${auditEvents.metadata}->>'createdDrafts')::int), 0)::int`,
          refreshedProducts: sql<number>`coalesce(sum((${auditEvents.metadata}->>'refreshedProducts')::int), 0)::int`,
          issueCount: sql<number>`coalesce(sum((${auditEvents.metadata}->>'issueCount')::int), 0)::int`,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, workspaceId),
            eq(auditEvents.action, "listing.bulk_form_import_completed"),
            gte(auditEvents.createdAt, since),
          ),
        );
      return (
        row ?? {
          parsedRows: 0,
          createdDrafts: 0,
          refreshedProducts: 0,
          issueCount: 0,
        }
      );
    },
  };
}
