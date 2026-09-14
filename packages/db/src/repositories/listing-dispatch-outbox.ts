import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { listingDispatchOutbox } from "../schema.js";

export type OutboxEntry = {
  id: string;
  listingId: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attempts: number;
};

export type RecordDispatchInput = {
  listingId: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
};

export type ListingDispatchOutboxRepository = {
  /**
   * Records work we are about to send, inside the caller's transaction.
   *
   * `onConflictDoNothing` on `(workspace_id, dedupe_key)` makes this safe to
   * repeat: the same job written twice is the same job, and the second write is
   * a no-op rather than a duplicate message. Returns only the rows this call
   * created, so the caller sends exactly what it is responsible for.
   */
  record(entries: readonly RecordDispatchInput[]): Promise<OutboxEntry[]>;
  /**
   * Rows that were recorded and never confirmed as sent.
   *
   * `olderThanSeconds` keeps a wave that is dispatching right now out of the
   * result: without it, a concurrent advance would re-send messages the first
   * one is still in the middle of sending.
   */
  pending(input: {
    olderThanSeconds: number;
    maxRows: number;
  }): Promise<OutboxEntry[]>;
  /** Confirms the queue accepted these. Safe to call twice. */
  markDispatched(ids: readonly string[]): Promise<void>;
  /**
   * Records that a send was attempted and did not succeed.
   *
   * The count is what lets a later query distinguish a row that keeps failing
   * from one that was simply never reached.
   */
  markAttempted(ids: readonly string[]): Promise<void>;
};

export function createListingDispatchOutboxRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ListingDispatchOutboxRepository {
  if (workspaceId.trim().length === 0) {
    throw new Error("workspaceId must not be empty");
  }

  const columns = {
    id: listingDispatchOutbox.id,
    listingId: listingDispatchOutbox.listingId,
    dedupeKey: listingDispatchOutbox.dedupeKey,
    payload: listingDispatchOutbox.payload,
    attempts: listingDispatchOutbox.attempts,
  };

  return {
    async record(entries) {
      scope.assertOpen();
      if (entries.length === 0) return [];
      return transaction
        .insert(listingDispatchOutbox)
        .values(
          entries.map((entry) => ({
            workspaceId,
            listingId: entry.listingId,
            dedupeKey: entry.dedupeKey,
            payload: entry.payload,
          })),
        )
        .onConflictDoNothing()
        .returning(columns);
    },

    async pending({ olderThanSeconds, maxRows }) {
      scope.assertOpen();
      if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100) {
        throw new Error("outbox maxRows must be 1..100");
      }
      if (!Number.isFinite(olderThanSeconds) || olderThanSeconds < 0) {
        throw new Error("outbox olderThanSeconds must be >= 0");
      }
      return (
        transaction
          .select(columns)
          .from(listingDispatchOutbox)
          .where(
            and(
              eq(listingDispatchOutbox.workspaceId, workspaceId),
              isNull(listingDispatchOutbox.dispatchedAt),
              lt(
                listingDispatchOutbox.createdAt,
                sql`now() - make_interval(secs => ${olderThanSeconds})`,
              ),
            ),
          )
          // Oldest first: the work owed longest is sent first.
          .orderBy(asc(listingDispatchOutbox.createdAt))
          .limit(maxRows)
      );
    },

    async markDispatched(ids) {
      scope.assertOpen();
      const unique = [...new Set(ids)];
      if (unique.length === 0) return;
      await transaction
        .update(listingDispatchOutbox)
        .set({ dispatchedAt: new Date() })
        .where(
          and(
            eq(listingDispatchOutbox.workspaceId, workspaceId),
            inArray(listingDispatchOutbox.id, unique),
            // Never move the timestamp of a row already confirmed: the first
            // confirmation is the true one, and a re-send must not rewrite it.
            isNull(listingDispatchOutbox.dispatchedAt),
          ),
        );
    },

    async markAttempted(ids) {
      scope.assertOpen();
      const unique = [...new Set(ids)];
      if (unique.length === 0) return;
      await transaction
        .update(listingDispatchOutbox)
        .set({ attempts: sql`${listingDispatchOutbox.attempts} + 1` })
        .where(
          and(
            eq(listingDispatchOutbox.workspaceId, workspaceId),
            inArray(listingDispatchOutbox.id, unique),
            isNull(listingDispatchOutbox.dispatchedAt),
          ),
        );
    },
  };
}
