import { randomUUID } from "node:crypto";

import { and, eq, inArray, lte, or, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { publishJobs } from "../schema.js";

const RETRYABLE_PUBLISH_JOB_ERRORS = [
  "remote_unavailable",
  "rate_limited",
] as const;

const SAFE_PUBLISH_JOB_ERROR_CODES = [
  "invalid_credentials_or_permission",
  "validation_failed",
  "rate_limited",
  "remote_unavailable",
  "not_approved",
  "blocking_flags",
  "invalid_payload",
  "stale_plan",
] as const;

export function sanitizePublishJobErrorCode(errorCode: string): string {
  return SAFE_PUBLISH_JOB_ERROR_CODES.some(
    (candidate) => candidate === errorCode,
  )
    ? errorCode
    : "remote_unavailable";
}

export function isRetryablePublishJobError(errorCode: string | null): boolean {
  return (
    errorCode !== null &&
    RETRYABLE_PUBLISH_JOB_ERRORS.some((candidate) => candidate === errorCode)
  );
}

export type PublishJobStatus =
  "pending_enqueue" | "queued" | "running" | "published" | "failed";

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
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
};

export type EnsurePublishJobInput = {
  listingId: string;
  versionId: string;
  connectionId: string;
  idempotencyKey: string;
  payloadDigest: string;
};

export type ClaimPublishJobInput = {
  key: string;
  expectedVersionId: string;
  now: Date;
  leaseMs: number;
};

export type ClaimPublishJobResult = {
  claimed: boolean;
  job: PublishJob | null;
  leaseToken: string | null;
};

export type PublishJobRepository = {
  getByIdempotencyKey(key: string): Promise<PublishJob | null>;
  ensure(input: EnsurePublishJobInput): Promise<PublishJob>;
  markQueued(key: string): Promise<boolean>;
  claim(input: ClaimPublishJobInput): Promise<ClaimPublishJobResult>;
  /**
   * Records the remote product id the instant the connector returns it, while
   * the job stays `running` and keeps its lease. Without this the id only lands
   * as part of `markPublished`, so a crash or failed commit between the remote
   * create and that write leaves a live product with no local record and no
   * input for the reconciliation read on the next delivery.
   */
  recordRemoteProduct(
    key: string,
    leaseToken: string,
    remoteProductId: string,
  ): Promise<void>;
  markPublished(
    key: string,
    leaseToken: string,
    remoteProductId: string,
    payloadDigest: string,
  ): Promise<void>;
  markFailed(key: string, leaseToken: string, errorCode: string): Promise<void>;
};

type PublishJobRow = typeof publishJobs.$inferSelect;

function toPublishJob(row: PublishJobRow | undefined): PublishJob | null {
  if (!row?.versionId) return null;
  return {
    id: row.id,
    listingId: row.listingId,
    versionId: row.versionId,
    connectionId: row.connectionId,
    status: row.status as PublishJobStatus,
    idempotencyKey: row.idempotencyKey,
    payloadDigest: row.payloadDigest,
    remoteProductId: row.remoteProductId,
    error: row.error,
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
    attemptCount: row.attemptCount,
  };
}

export function createPublishJobRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): PublishJobRepository {
  const byKey = (key: string) =>
    and(
      eq(publishJobs.workspaceId, workspaceId),
      eq(publishJobs.idempotencyKey, key),
    );
  const selectByKey = async (key: string): Promise<PublishJob | null> => {
    scope.assertOpen();
    const [row] = await transaction
      .select()
      .from(publishJobs)
      .where(byKey(key))
      .limit(1);
    return toPublishJob(row);
  };

  return {
    getByIdempotencyKey: selectByKey,

    async ensure(input) {
      scope.assertOpen();
      await transaction
        .insert(publishJobs)
        .values({
          workspaceId,
          listingId: input.listingId,
          versionId: input.versionId,
          connectionId: input.connectionId,
          status: "pending_enqueue",
          idempotencyKey: input.idempotencyKey,
          payloadDigest: input.payloadDigest,
        })
        .onConflictDoNothing();
      const row = await selectByKey(input.idempotencyKey);
      if (!row) throw new Error("publish job insert did not return a row");
      if (
        row.listingId !== input.listingId ||
        row.versionId !== input.versionId
      ) {
        throw new Error(
          "publish job idempotency key does not match listing version",
        );
      }
      return row;
    },

    async markQueued(key) {
      scope.assertOpen();
      const updated = await transaction
        .update(publishJobs)
        .set({
          status: "queued",
          updatedAt: new Date(),
        })
        .where(and(byKey(key), eq(publishJobs.status, "pending_enqueue")))
        .returning({ id: publishJobs.id });
      return updated.length > 0;
    },

    async claim(input) {
      scope.assertOpen();
      if (
        Number.isNaN(input.now.getTime()) ||
        !Number.isFinite(input.leaseMs) ||
        input.leaseMs <= 0
      ) {
        throw new Error("publish job lease is invalid");
      }

      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
      const [row] = await transaction
        .update(publishJobs)
        .set({
          status: "running",
          leaseToken,
          leaseExpiresAt,
          attemptCount: sql`${publishJobs.attemptCount} + 1`,
          error: null,
          updatedAt: input.now,
        })
        .where(
          and(
            byKey(input.key),
            eq(publishJobs.versionId, input.expectedVersionId),
            or(
              inArray(publishJobs.status, ["pending_enqueue", "queued"]),
              and(
                eq(publishJobs.status, "failed"),
                inArray(publishJobs.error, [...RETRYABLE_PUBLISH_JOB_ERRORS]),
              ),
              and(
                eq(publishJobs.status, "running"),
                lte(publishJobs.leaseExpiresAt, input.now),
              ),
            ),
          ),
        )
        .returning();

      const job = toPublishJob(row);
      if (!job) return { claimed: false, job: null, leaseToken: null };
      return { claimed: true, job, leaseToken };
    },

    async recordRemoteProduct(key, leaseToken, remoteProductId) {
      scope.assertOpen();
      if (!remoteProductId.trim()) {
        throw new Error("publish result is invalid");
      }
      const updated = await transaction
        .update(publishJobs)
        .set({ remoteProductId, updatedAt: new Date() })
        .where(
          and(
            byKey(key),
            eq(publishJobs.status, "running"),
            eq(publishJobs.leaseToken, leaseToken),
          ),
        )
        .returning({ id: publishJobs.id });
      if (!updated.length) throw new Error("publish job lease is not active");
    },

    async markPublished(key, leaseToken, remoteProductId, payloadDigest) {
      scope.assertOpen();
      if (!remoteProductId.trim() || !/^[a-f0-9]{64}$/.test(payloadDigest)) {
        throw new Error("publish result is invalid");
      }
      const updated = await transaction
        .update(publishJobs)
        .set({
          status: "published",
          remoteProductId,
          payloadDigest,
          error: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            byKey(key),
            eq(publishJobs.status, "running"),
            eq(publishJobs.leaseToken, leaseToken),
          ),
        )
        .returning({ id: publishJobs.id });
      if (!updated.length) throw new Error("publish job lease is not active");
    },

    async markFailed(key, leaseToken, errorCode) {
      scope.assertOpen();
      const safeCode = sanitizePublishJobErrorCode(errorCode);
      const updated = await transaction
        .update(publishJobs)
        .set({
          status: "failed",
          error: safeCode,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            byKey(key),
            eq(publishJobs.status, "running"),
            eq(publishJobs.leaseToken, leaseToken),
          ),
        )
        .returning({ id: publishJobs.id });
      if (!updated.length) throw new Error("publish job lease is not active");
    },
  };
}
