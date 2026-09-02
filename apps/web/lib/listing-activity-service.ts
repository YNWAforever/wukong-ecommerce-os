export type ListingActivityAuditEntry = {
  kind: "audit";
  id: string;
  action: string;
  metadata: unknown;
  createdAt: Date;
};

export type ListingActivityBatchEntry = {
  kind: "batch";
  id: string;
  label: string;
  status: string;
  createdAt: Date;
};

export type ListingActivityExportEntry = {
  kind: "export";
  id: string;
  outcome: string;
  reason?: string;
  createdAt: Date;
};

export type ListingActivityEntry =
  | ListingActivityAuditEntry
  | ListingActivityBatchEntry
  | ListingActivityExportEntry;

export type ListingActivityRepositories = {
  audit: {
    findRelatedToListing(listingId: string): Promise<
      Array<{
        id: string;
        actorId: string;
        entityId: string;
        action: string;
        metadata: unknown;
        createdAt: Date;
      }>
    >;
  };
  enrichmentBatches: {
    listBatchesForListing(listingId: string): Promise<
      Array<{ batchId: string; label: string; status: string; createdAt: Date }>
    >;
  };
  exportAttempts: {
    listContainingListing(listingId: string): Promise<
      Array<{ id: string; outcome: string; reason?: string; createdAt: Date }>
    >;
  };
};

/**
 * Merges the three sources of per-listing traceability this codebase has —
 * audit events keyed directly by entityId, batch membership via
 * enrichment_batch_items, and export-manifest membership via a jsonb
 * containment lookup — into one newest-first feed. Mirrors how
 * `buildJobsLedger` (apps/web/lib/jobs-ledger.ts) merges its own 4 sources.
 */
export async function getListingActivity(
  repositories: ListingActivityRepositories,
  listingId: string,
): Promise<ListingActivityEntry[]> {
  const [auditEvents, batches, exportAttempts] = await Promise.all([
    repositories.audit.findRelatedToListing(listingId),
    repositories.enrichmentBatches.listBatchesForListing(listingId),
    repositories.exportAttempts.listContainingListing(listingId),
  ]);

  const entries: ListingActivityEntry[] = [
    ...auditEvents.map(
      (event): ListingActivityAuditEntry => ({
        kind: "audit",
        id: event.id,
        action: event.action,
        metadata: event.metadata,
        createdAt: event.createdAt,
      }),
    ),
    ...batches.map(
      (batch): ListingActivityBatchEntry => ({
        kind: "batch",
        id: batch.batchId,
        label: batch.label,
        status: batch.status,
        createdAt: batch.createdAt,
      }),
    ),
    ...exportAttempts.map(
      (attempt): ListingActivityExportEntry => ({
        kind: "export",
        id: attempt.id,
        outcome: attempt.outcome,
        reason: attempt.reason,
        createdAt: attempt.createdAt,
      }),
    ),
  ];

  entries.sort((a, b) => {
    const byCreatedAt = b.createdAt.getTime() - a.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
  });
  return entries;
}
