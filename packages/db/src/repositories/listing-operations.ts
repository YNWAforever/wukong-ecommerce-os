import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";

export type ListingOperationState =
  "queued" | "running" | "succeeded" | "failed" | "superseded" | "cancelled";
export type ListingOperation = {
  id: string;
  listingId: string;
  idempotencyKey: string;
  inputRevision: number;
  baseVersionId: string | null;
  retryOfRunId: string | null;
  runAttempt: number;
  activeVersionSequence: number;
  executionState: ListingOperationState;
  execution: Record<string, unknown>;
  errorCode: string | null;
  requestDigest: string;
  acceptedAt: string;
};
export class ListingOperationConflict extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function operation(row: Record<string, unknown>): ListingOperation {
  return {
    id: String(row.id),
    listingId: String(row.listing_id),
    idempotencyKey: String(row.idempotency_key),
    inputRevision: Number(row.input_revision),
    baseVersionId: row.base_version_id as string | null,
    retryOfRunId: row.retry_of_run_id as string | null,
    runAttempt: Number(row.run_attempt),
    activeVersionSequence: Number(row.active_version_sequence),
    executionState: row.execution_state as ListingOperationState,
    execution: row.execution as Record<string, unknown>,
    errorCode: row.error_code as string | null,
    requestDigest: String(row.request_digest),
    acceptedAt: new Date(row.created_at as string).toISOString(),
  };
}
export function createListingOperationRepository(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
) {
  const getOperation = async (id: string): Promise<ListingOperation | null> => {
    scope.assertOpen();
    const rows = await tx.execute(
      sql`select * from listing_pipeline_runs where workspace_id=${workspaceId} and id=${id}::uuid and execution_state is not null`,
    );
    return rows[0] ? operation(rows[0]) : null;
  };
  return {
    getOperation,
    /** Roll back acceptance on this connection while retaining saved intake. */
    async withAcceptanceSavepoint<T>(work: () => Promise<T>): Promise<T> {
      scope.assertOpen();
      return tx.transaction(async () => work());
    },
    async acceptanceTimestamp(): Promise<string> {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select clock_timestamp() as accepted_at`,
      );
      return new Date(rows[0]!.accepted_at as string).toISOString();
    },
    async retainOperationCandidate(id: string, candidate: unknown) {
      scope.assertOpen();
      await tx.execute(
        sql`update listing_pipeline_runs set execution=execution || jsonb_build_object('candidate',${JSON.stringify(candidate)}::jsonb) where workspace_id=${workspaceId} and id=${id}::uuid and execution_state is not null`,
      );
    },
    async lockCreateRequests(
      requestKey: string | null,
      sourceAssetIds: readonly string[] = [],
    ) {
      scope.assertOpen();
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        (requestKey !== null && !uuid.test(requestKey)) ||
        sourceAssetIds.length > 11 ||
        sourceAssetIds.some((id) => !uuid.test(id))
      )
        throw new Error("invalid create lock coordinates");
      // Order: request -> sorted unique assets -> listing/run -> workspace budget.
      // Advisory locks serialize creates without reversing the runtime row locks.
      const keys = [
        ...(requestKey
          ? [JSON.stringify(["listing-create", workspaceId, requestKey])]
          : []),
        ...[...new Set(sourceAssetIds)]
          .sort()
          .map((id) =>
            JSON.stringify(["listing-create-asset", workspaceId, id]),
          ),
      ];
      for (const key of keys)
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`,
        );
    },
    async lockAdmissionBudget() {
      scope.assertOpen();
      await tx.execute(
        sql`select id from workspaces where id=${workspaceId} for update`,
      );
    },
    async findCreateRequest(key: string) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select request_digest,response from listing_create_requests where workspace_id=${workspaceId} and request_key=${key}::uuid`,
      );
      return rows[0]
        ? {
            digest: String(rows[0].request_digest),
            response: rows[0].response as Record<string, unknown>,
          }
        : null;
    },
    async recordCreateRequest(
      key: string,
      digest: string,
      listingId: string,
      response: Record<string, unknown>,
    ) {
      scope.assertOpen();
      await tx.execute(
        sql`insert into listing_create_requests(workspace_id,request_key,request_digest,listing_id,response) values(${workspaceId},${key}::uuid,${digest},${listingId}::uuid,${JSON.stringify(response)}::jsonb)`,
      );
    },
    async setOperationState(
      id: string,
      state: ListingOperationState,
      errorCode: string | null = null,
      candidate?: unknown,
    ) {
      scope.assertOpen();
      await tx.execute(sql`update listing_pipeline_runs set execution_state=${state}, status=case when ${state} in ('queued','running') then 'started' when ${state}='failed' then 'failed' else 'succeeded' end,
        error_code=case when execution_state in ('queued','running') then ${errorCode} else error_code end, execution=case when ${candidate !== undefined} then execution || jsonb_build_object('candidate',${JSON.stringify(candidate ?? null)}::jsonb) else execution end, updated_at=now()
        where workspace_id=${workspaceId} and id=${id}::uuid and (execution_state in ('queued','running') or (execution_state in ('superseded','succeeded','failed') and execution_state=${state} and ${candidate !== undefined}))`);
    },
    async getCurrentOperation(
      listingId: string,
    ): Promise<ListingOperation | null> {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select r.* from listing_pipeline_runs r join listing_drafts d on d.workspace_id=r.workspace_id and d.current_run_id=r.id where d.workspace_id=${workspaceId} and d.id=${listingId}::uuid`,
      );
      return rows[0] ? operation(rows[0]) : null;
    },
    async findOperationRequest(
      listingId: string,
      requestKey: string,
    ): Promise<ListingOperation | null> {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select * from listing_pipeline_runs where workspace_id=${workspaceId} and listing_id=${listingId}::uuid and request_key=${requestKey}`,
      );
      return rows[0] ? operation(rows[0]) : null;
    },
    async acceptOperation(input: {
      listingId: string;
      inputRevision: number;
      baseVersionId: string | null;
      activeVersionSequence: number;
      requestKey: string;
      requestDigest: string;
      retryOfRunId?: string;
      execution: Record<string, unknown>;
      acceptedAt?: string;
    }): Promise<ListingOperation> {
      scope.assertOpen();
      const drafts = await tx.execute(
        sql`select id from listing_drafts where workspace_id=${workspaceId} and id=${input.listingId}::uuid for update`,
      );
      if (!drafts.length)
        throw new ListingOperationConflict("listing_not_found");
      const replay = await tx.execute(
        sql`select * from listing_pipeline_runs where workspace_id=${workspaceId} and listing_id=${input.listingId}::uuid and request_key=${input.requestKey}`,
      );
      if (replay[0]) {
        if (replay[0].request_digest !== input.requestDigest)
          throw new ListingOperationConflict("idempotency_conflict");
        return operation(replay[0]);
      }
      const active = await tx.execute(
        sql`select id from listing_pipeline_runs where workspace_id=${workspaceId} and listing_id=${input.listingId}::uuid and execution_state in ('queued','running')`,
      );
      if (active.length)
        throw new ListingOperationConflict("processing_already_active");
      if (input.retryOfRunId) {
        const previous = await getOperation(input.retryOfRunId);
        if (
          !previous ||
          previous.listingId !== input.listingId ||
          !["failed", "superseded", "succeeded", "cancelled"].includes(
            previous.executionState,
          )
        )
          throw new ListingOperationConflict("invalid_retry_lineage");
      }
      const id = randomUUID();
      const key = `listing-run:${id}`;
      const rows = await tx.execute(sql`insert into listing_pipeline_runs
        (id,workspace_id,listing_id,active_version_sequence,idempotency_key,status,input_revision,base_version_id,run_attempt,retry_of_run_id,request_key,request_digest,execution_state,execution,created_at)
        select ${id}::uuid,${workspaceId},${input.listingId}::uuid,${input.activeVersionSequence},${key},'started',${input.inputRevision},${input.baseVersionId}::uuid,
        coalesce(max(run_attempt),0)+1,${input.retryOfRunId ?? null}::uuid,${input.requestKey},${input.requestDigest},'queued',${JSON.stringify(input.execution)}::jsonb,coalesce(${input.acceptedAt ?? null}::timestamptz,now())
        from listing_pipeline_runs where workspace_id=${workspaceId} and listing_id=${input.listingId}::uuid returning *`);
      await tx.execute(
        sql`update listing_drafts set current_run_id=${id}::uuid,updated_at=now() where workspace_id=${workspaceId} and id=${input.listingId}::uuid`,
      );
      return operation(rows[0]!);
    },
  };
}
