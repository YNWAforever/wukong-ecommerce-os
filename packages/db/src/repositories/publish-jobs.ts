import { and, eq } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { publishJobs } from "../schema.js";

export type PublishJobStatus = "queued" | "running" | "published" | "failed";

export type PublishJob = {
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

export type EnsurePublishJobInput = {
  listingId: string;
  versionId: string;
  connectionId: string;
  idempotencyKey: string;
  payloadDigest: string;
};

export type PublishJobRepository = {
  getByIdempotencyKey(key: string): Promise<PublishJob | null>;
  ensure(input: EnsurePublishJobInput): Promise<PublishJob>;
  markRunning(key: string): Promise<void>;
  markPublished(key: string, remoteProductId: string, payloadDigest: string): Promise<void>;
  markFailed(key: string, errorCode: string): Promise<void>;
};

export function createPublishJobRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): PublishJobRepository {
  const byKey = (key: string) => and(
    eq(publishJobs.workspaceId, workspaceId),
    eq(publishJobs.idempotencyKey, key),
  );
  const selectByKey = async (key: string): Promise<PublishJob | null> => {
    scope.assertOpen();
    const [row] = await transaction.select({
      id: publishJobs.id,
      listingId: publishJobs.listingId,
      versionId: publishJobs.versionId,
      connectionId: publishJobs.connectionId,
      status: publishJobs.status,
      idempotencyKey: publishJobs.idempotencyKey,
      payloadDigest: publishJobs.payloadDigest,
      remoteProductId: publishJobs.remoteProductId,
      error: publishJobs.error,
    }).from(publishJobs).where(byKey(key)).limit(1);
    if (!row || !row.versionId) return null;
    return {
      ...row,
      status: row.status as PublishJobStatus,
      versionId: row.versionId,
    };
  };

  return {
    getByIdempotencyKey: selectByKey,

    async ensure(input) {
      scope.assertOpen();
      await transaction.insert(publishJobs).values({
        workspaceId,
        listingId: input.listingId,
        versionId: input.versionId,
        connectionId: input.connectionId,
        status: "queued",
        idempotencyKey: input.idempotencyKey,
        payloadDigest: input.payloadDigest,
      }).onConflictDoNothing();
      const row = await selectByKey(input.idempotencyKey);
      if (!row) throw new Error("publish job insert did not return a row");
      if (row.listingId !== input.listingId || row.versionId !== input.versionId) {
        throw new Error("publish job idempotency key does not match listing version");
      }
      return row;
    },

    async markRunning(key) {
      scope.assertOpen();
      await transaction.update(publishJobs).set({ status: "running", error: null, updatedAt: new Date() }).where(byKey(key));
    },

    async markPublished(key, remoteProductId, payloadDigest) {
      scope.assertOpen();
      if (!remoteProductId.trim() || !/^[a-f0-9]{64}$/.test(payloadDigest)) {
        throw new Error("publish result is invalid");
      }
      const updated = await transaction.update(publishJobs).set({ status: "published", remoteProductId, payloadDigest, error: null, updatedAt: new Date() }).where(byKey(key)).returning({ id: publishJobs.id });
      if (!updated.length) throw new Error("publish job not found");
    },

    async markFailed(key, errorCode) {
      scope.assertOpen();
      const safeCode = /^(invalid_credentials_or_permission|validation_failed|rate_limited|remote_unavailable|not_approved|blocking_flags|invalid_payload)$/.test(errorCode) ? errorCode : "remote_unavailable";
      const updated = await transaction.update(publishJobs).set({ status: "failed", error: safeCode, updatedAt: new Date() }).where(byKey(key)).returning({ id: publishJobs.id });
      if (!updated.length) throw new Error("publish job not found");
    },
  };
}
