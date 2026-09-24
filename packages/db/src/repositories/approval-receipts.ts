import { and, desc, eq } from "drizzle-orm";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { bulkUpdateApprovalReceipts, sourceRowSnapshots } from "../schema.js";

export type RecordApprovalReceiptInput = Omit<
  typeof bulkUpdateApprovalReceipts.$inferInsert,
  "id" | "workspaceId" | "createdAt" | "receiptOrdinal"
>;
export type BulkUpdateApprovalReceipt = Omit<
  typeof bulkUpdateApprovalReceipts.$inferSelect,
  "receiptOrdinal"
> & {
  connectionId: string;
  sourceImportId: string;
  remoteProductId: string;
  sourceRowDigest: string;
  headerContractSha256: string;
  specVersion: string;
};
export type ApprovalReceiptRepository = {
  record(
    input: RecordApprovalReceiptInput,
  ): Promise<BulkUpdateApprovalReceipt & { wasCreated: boolean }>;
  getByVersionId(versionId: string): Promise<BulkUpdateApprovalReceipt | null>;
};
export function createApprovalReceiptRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ApprovalReceiptRepository {
  async function getByVersionId(
    versionId: string,
    binding?: RecordApprovalReceiptInput,
  ) {
    const [row] = await transaction
      .select({
        receipt: bulkUpdateApprovalReceipts,
        connectionId: sourceRowSnapshots.connectionId,
        sourceImportId: sourceRowSnapshots.sourceImportId,
        remoteProductId: sourceRowSnapshots.remoteProductId,
        sourceRowDigest: sourceRowSnapshots.sourceRowDigest,
        headerContractSha256: sourceRowSnapshots.headerContractSha256,
        specVersion: sourceRowSnapshots.specVersion,
      })
      .from(bulkUpdateApprovalReceipts)
      .innerJoin(
        sourceRowSnapshots,
        and(
          eq(
            sourceRowSnapshots.workspaceId,
            bulkUpdateApprovalReceipts.workspaceId,
          ),
          eq(
            sourceRowSnapshots.id,
            bulkUpdateApprovalReceipts.sourceSnapshotId,
          ),
        ),
      )
      .where(
        and(
          eq(bulkUpdateApprovalReceipts.workspaceId, workspaceId),
          eq(bulkUpdateApprovalReceipts.versionId, versionId),
          ...(binding
            ? [
                eq(
                  bulkUpdateApprovalReceipts.sourceSnapshotId,
                  binding.sourceSnapshotId,
                ),
                eq(
                  bulkUpdateApprovalReceipts.confirmationVersionId,
                  binding.confirmationVersionId,
                ),
                eq(
                  bulkUpdateApprovalReceipts.confirmationRevision,
                  binding.confirmationRevision,
                ),
              ]
            : []),
        ),
      )
      .orderBy(desc(bulkUpdateApprovalReceipts.receiptOrdinal))
      .limit(1);
    if (!row) return null;
    const { receipt, ...snapshot } = row;
    const { receiptOrdinal: _ordinal, ...publicReceipt } = receipt;
    return { ...publicReceipt, ...snapshot };
  }
  return {
    async record(input) {
      scope.assertOpen();
      const inserted = await transaction
        .insert(bulkUpdateApprovalReceipts)
        .values({ ...input, workspaceId })
        .onConflictDoNothing()
        .returning({ id: bulkUpdateApprovalReceipts.id });
      const receipt = await getByVersionId(input.versionId, input);
      if (!receipt)
        throw new Error("approval receipt insert did not return a row");
      return { ...receipt, wasCreated: inserted.length === 1 };
    },
    async getByVersionId(versionId) {
      scope.assertOpen();
      return getByVersionId(versionId);
    },
  };
}
