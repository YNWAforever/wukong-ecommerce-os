import { sql } from "drizzle-orm";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";

export type BatchSelectionPreview = {
  id: string;
  actorId: string;
  digest: string;
  expiresAt: string;
  options: Record<string, unknown>;
};
export function createBatchSelectionPreviewRepository(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
) {
  return {
    async insertPreview(input: BatchSelectionPreview) {
      scope.assertOpen();
      await tx.execute(
        sql`insert into enrichment_batch_previews(workspace_id,id,actor_id,digest,expires_at,options) values(${workspaceId},${input.id}::uuid,${input.actorId},${input.digest},${input.expiresAt}::timestamptz,${JSON.stringify(input.options)}::jsonb)`,
      );
    },
    async lockPreview(
      id: string,
      requestKey?: string,
    ): Promise<BatchSelectionPreview | null> {
      scope.assertOpen();
      // Immutable rows need no UPDATE grant. Serialize both replay coordinates.
      const keys = [
        JSON.stringify(["batch-preview", workspaceId, id]),
        ...(requestKey
          ? [JSON.stringify(["batch-create", workspaceId, requestKey])]
          : []),
      ].sort();
      for (const key of keys)
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`,
        );
      const rows = await tx.execute(
        sql`select id,actor_id,digest,expires_at,options from enrichment_batch_previews where workspace_id=${workspaceId} and id=${id}::uuid`,
      );
      return rows[0]
        ? {
            id: String(rows[0].id),
            actorId: String(rows[0].actor_id),
            digest: String(rows[0].digest),
            expiresAt: new Date(rows[0].expires_at as string).toISOString(),
            options: rows[0].options as Record<string, unknown>,
          }
        : null;
    },
    async findPreviewCreate(requestKey: string) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select digest,response from enrichment_batch_create_receipts where workspace_id=${workspaceId} and request_key=${requestKey}::uuid`,
      );
      return rows[0]
        ? {
            digest: String(rows[0].digest),
            response: rows[0].response as Record<string, unknown>,
          }
        : null;
    },
    async previewHasCreate(id: string) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select request_key from enrichment_batch_create_receipts where workspace_id=${workspaceId} and preview_id=${id}::uuid`,
      );
      return rows.length > 0;
    },
    async recordPreviewCreate(
      requestKey: string,
      digest: string,
      response: Record<string, unknown>,
      previewId: string,
    ) {
      scope.assertOpen();
      await tx.execute(
        sql`insert into enrichment_batch_create_receipts(workspace_id,request_key,preview_id,digest,batch_id,response) values(${workspaceId},${requestKey}::uuid,${previewId}::uuid,${digest},${String(response.batchId)}::uuid,${JSON.stringify(response)}::jsonb)`,
      );
    },
  };
}
