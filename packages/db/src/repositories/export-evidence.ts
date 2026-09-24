import { sql, getTableColumns, type SQL } from "drizzle-orm";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import {
  exportAttempts,
  exportVerifications,
  importResults,
} from "../schema.js";
import type { ExportAttempt } from "./export-attempts.js";
import type { ExportVerification } from "./export-verifications.js";
import type { ImportResult } from "./import-results.js";
export type ExportEvidenceSnapshot = {
  asOf: Date;
  attempt: ExportAttempt | null;
  comparison: ExportVerification | null;
  receipts: ImportResult[];
  receiptCount: number;
};
export type ExportEvidenceRepository = {
  getSnapshot(
    attemptId: string,
    comparisonId: string,
  ): Promise<ExportEvidenceSnapshot>;
};
function object(columns: Record<string, unknown>, omit: string[]): SQL {
  const pairs = Object.entries(columns)
    .filter(([k]) => !omit.includes(k))
    .map(([k, v]) => sql`${k}::text, ${v as SQL}`);
  return sql`jsonb_build_object(${sql.join(pairs, sql`, `)})`;
}
export function createExportEvidenceRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ExportEvidenceRepository {
  return {
    async getSnapshot(attemptId, comparisonId) {
      scope.assertOpen();
      // Every subselect shares this statement's MVCC snapshot. The 1001st row is an overflow sentinel, never a partial packet.
      const rows = await transaction.execute(sql`
   with selected_attempt as materialized (
    select ${object(getTableColumns(exportAttempts), ["workspaceId", "idempotencyKey"])} as value, ${exportAttempts.manifest} as manifest
    from ${exportAttempts} where ${exportAttempts.workspaceId}=${workspaceId} and ${exportAttempts.id}=${attemptId}
   ), selected_comparison as materialized (
    select ${object(getTableColumns(exportVerifications), ["workspaceId", "identityKey"])} as value
    from ${exportVerifications} where ${exportVerifications.workspaceId}=${workspaceId} and ${exportVerifications.exportAttemptId}=${attemptId} and ${exportVerifications.id}=${comparisonId}
   ), relevant_receipts as materialized (
    select ${object(getTableColumns(importResults), ["workspaceId"])} as value
    from ${importResults} where ${importResults.workspaceId}=${workspaceId} and ${importResults.exportAttemptId}=${attemptId} and ${importResults.mode}='export'
    and exists (select 1 from selected_attempt a, jsonb_array_elements(a.manifest) m where m->>'outcome'='included' and m->>'listingId'=${importResults.listingId}::text)
    order by ${importResults.listingId},${importResults.revision},${importResults.id} limit 1001
   )
   select statement_timestamp() as "asOf",(select value from selected_attempt) as attempt,(select value from selected_comparison) as comparison,
    coalesce((select jsonb_agg(value) from relevant_receipts),'[]'::jsonb) as receipts,(select count(*)::int from relevant_receipts) as "receiptCount"
  `);
      const row = rows[0]!;
      const attempt = row.attempt as ExportAttempt | null,
        comparison = row.comparison as ExportVerification | null,
        receipts = row.receipts as ImportResult[];
      if (attempt) {
        attempt.createdAt = new Date(attempt.createdAt);
        if (attempt.artifactReadyAt)
          attempt.artifactReadyAt = new Date(attempt.artifactReadyAt);
      }
      if (comparison) {
        comparison.createdAt = new Date(comparison.createdAt);
        comparison.merchantAttestedExportAt = new Date(
          comparison.merchantAttestedExportAt,
        );
      }
      for (const receipt of receipts)
        receipt.createdAt = new Date(receipt.createdAt);
      return {
        asOf: new Date(row.asOf as string),
        attempt,
        comparison,
        receipts,
        receiptCount: Number(row.receiptCount),
      };
    },
  };
}
