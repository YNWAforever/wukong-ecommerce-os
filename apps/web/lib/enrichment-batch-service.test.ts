import { describe, expect, it } from "vitest";

import { createEnrichmentBatchService } from "./enrichment-batch-service";

const untranslated = {
  remoteProductId: "remote_1",
  listingId: "draft_1",
  origin: "import" as const,
  rawRow: { nameEn: "Demo Estate Riesling", nameZh: "Demo Estate Riesling" },
};
const translated = {
  remoteProductId: "remote_2",
  listingId: "draft_2",
  origin: "import" as const,
  rawRow: { nameEn: "Demo Estate Riesling", nameZh: "示範酒莊麗絲玲" },
};
const unlinked = {
  remoteProductId: "remote_3",
  listingId: null,
  origin: "import" as const,
  rawRow: { nameEn: "Never imported", nameZh: "Never imported" },
};

type AuditRecord = { action: string; entityId: string; metadata: unknown };

type FakePlatformProduct = {
  remoteProductId: string;
  listingId: string | null;
  origin: "import" | "created";
  rawRow: Record<string, string | null> | null;
};

function serviceWith(
  products: FakePlatformProduct[] = [untranslated, translated, unlinked],
) {
  const recorded: { created: unknown[]; audits: AuditRecord[] } = {
    created: [],
    audits: [],
  };

  const service = createEnrichmentBatchService({
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repositories: any) => Promise<T>,
        ) {
          return work({
            platformProducts: {
              async listRecent() {
                return products;
              },
            },
            enrichmentBatches: {
              async create(input: { budgetUsd: number; waveSize: number }) {
                recorded.created.push(input);
                return {
                  id: "batch_1",
                  label: "x",
                  budgetUsd: input.budgetUsd,
                  waveSize: input.waveSize,
                  status: "open",
                  createdBy: "user_1",
                };
              },
            },
            audit: {
              async write(entry: AuditRecord) {
                recorded.audits.push(entry);
              },
            },
          });
        },
      }) as never,
    publisher: {
      async enqueue() {
        return { id: "job_1" };
      },
    },
  });

  return { service, recorded };
}

describe("enrichment batch creation", () => {
  it("selects only products whose rows show the requested gap", async () => {
    const { service, recorded } = serviceWith();

    const result = await service.createBatch({
      workspaceId: "ws_opak",
      actorId: "user_1",
      label: "zh names",
      gap: "untranslatedName",
      budgetUsd: 5,
      waveSize: 3,
    });

    expect(result.selected).toBe(1);
    expect(
      (recorded.created[0] as { listingIds: string[] }).listingIds,
    ).toEqual(["draft_1"]);
    expect(result.batchId).toBe("batch_1");
  });

  it("records the cohort as identifiers and counts only", async () => {
    const { service, recorded } = serviceWith();

    await service.createBatch({
      workspaceId: "ws_opak",
      actorId: "user_1",
      label: "zh names",
      gap: "untranslatedName",
      budgetUsd: 5,
      waveSize: 3,
    });

    expect(recorded.audits).toEqual([
      {
        workspaceId: "ws_opak",
        actorId: "user_1",
        entityId: "batch_1",
        action: "enrichment_batch.created",
        metadata: {
          gap: "untranslatedName",
          selected: 1,
          budgetUsd: 5,
          waveSize: 3,
        },
      },
    ]);
  });

  it("skips products that have no draft to enrich", async () => {
    const { service, recorded } = serviceWith([unlinked]);

    await expect(
      service.createBatch({
        workspaceId: "ws_opak",
        actorId: "user_1",
        label: "zh names",
        gap: "untranslatedName",
        budgetUsd: 5,
        waveSize: 3,
      }),
    ).rejects.toThrow(/no products match/i);
    expect(recorded.created).toEqual([]);
  });

  it("excludes a created-origin product from gap-based cohort selection", async () => {
    const { service, recorded } = serviceWith([
      {
        remoteProductId: "remote_import_1",
        listingId: "listing-1",
        origin: "import",
        rawRow: {
          nameEn: "Demo Estate Riesling",
          nameZh: "Demo Estate Riesling",
        },
      },
      {
        remoteProductId: "remote_created_1",
        listingId: "listing-2",
        origin: "created",
        rawRow: null,
      },
    ]);

    const result = await service.createBatch({
      workspaceId: "ws_opak",
      actorId: "user_1",
      label: "zh names",
      gap: "untranslatedName",
      budgetUsd: 10,
      waveSize: 5,
    });

    // Only the import-origin listing is eligible. If the created-origin
    // row's null rawRow reached bulkFormGaps unfiltered, this call would
    // throw instead of returning cleanly with just the import-origin draft.
    expect(result.selected).toBe(1);
    expect(
      (recorded.created[0] as { listingIds: string[] }).listingIds,
    ).toEqual(["listing-1"]);
  });

  it("refuses a non-positive budget", async () => {
    const { service } = serviceWith();

    await expect(
      service.createBatch({
        workspaceId: "ws_opak",
        actorId: "user_1",
        label: "zh names",
        gap: "untranslatedName",
        budgetUsd: 0,
        waveSize: 3,
      }),
    ).rejects.toThrow(/budget/);
  });

  it("refuses a wave size that is not a positive whole number", async () => {
    const { service, recorded } = serviceWith();

    await expect(
      service.createBatch({
        workspaceId: "ws_opak",
        actorId: "user_1",
        label: "zh names",
        gap: "untranslatedName",
        budgetUsd: 5,
        waveSize: 2.5,
      }),
    ).rejects.toThrow(/wave size/i);
    expect(recorded.created).toEqual([]);
  });

  it("refuses a wave size above the 1-5 cap", async () => {
    const { service, recorded } = serviceWith();

    await expect(
      service.createBatch({
        workspaceId: "ws_opak",
        actorId: "user_1",
        label: "zh names",
        gap: "untranslatedName",
        budgetUsd: 5,
        waveSize: 6,
      }),
    ).rejects.toThrow(/wave size/i);
    expect(recorded.created).toEqual([]);
  });
});

type Marked = { listingIds: string[]; status: string };

function advanceServiceWith(options: {
  spent: number;
  budget: number;
  pending: string[];
  queued?: string[];
  listingStatuses?: Record<string, string>;
  counts?: Record<string, number>;
}) {
  const enqueued: string[] = [];
  const statuses: string[] = [];
  const marked: Marked[] = [];
  const audits: AuditRecord[] = [];
  const queued = options.queued ?? [];
  let remaining = [...options.pending];

  const service = createEnrichmentBatchService({
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repositories: any) => Promise<T>,
        ) {
          return work({
            enrichmentBatches: {
              async getById() {
                return {
                  id: "batch_1",
                  label: "zh names",
                  budgetUsd: options.budget,
                  waveSize: 2,
                  status: "open",
                  createdBy: "user_1",
                };
              },
              async listItemIds() {
                return [...options.pending, ...queued];
              },
              async listItemsByStatus(_batchId: string, status: string) {
                return status === "queued" ? queued : [];
              },
              async claimWave(_batchId: string, limit: number) {
                const wave = remaining.slice(0, limit);
                remaining = remaining.slice(limit);
                return wave;
              },
              async countByStatus() {
                return {
                  pending: remaining.length,
                  queued: 0,
                  succeeded: 0,
                  failed: 0,
                  skipped: 0,
                  ...options.counts,
                };
              },
              async setStatus(_batchId: string, status: string) {
                statuses.push(status);
              },
              async markItems(
                _batchId: string,
                listingIds: string[],
                status: string,
              ) {
                marked.push({ listingIds: [...listingIds], status });
              },
            },
            listings: {
              async statusesByIds(ids: string[]) {
                return Object.fromEntries(
                  ids
                    .filter((id) => options.listingStatuses?.[id] !== undefined)
                    .map((id) => [id, options.listingStatuses?.[id]]),
                );
              },
            },
            aiRuns: {
              async sumCostForListings() {
                return options.spent;
              },
            },
            audit: {
              async write(entry: AuditRecord) {
                audits.push(entry);
              },
            },
          });
        },
      }) as never,
    publisher: {
      async enqueue(job: { draftId: string }) {
        enqueued.push(job.draftId);
        return { id: `job_${job.draftId}` };
      },
    },
  });

  return { service, enqueued, statuses, marked, audits };
}

const advanceInput = {
  workspaceId: "ws_opak",
  actorId: "user_1",
  batchId: "batch_1",
};

describe("enrichment batch advance", () => {
  it("enqueues one wave of existing listing jobs", async () => {
    const { service, enqueued, audits } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1", "draft_2", "draft_3"],
    });

    const result = await service.advanceBatch(advanceInput);

    expect(enqueued).toEqual(["draft_1", "draft_2"]);
    expect(result.enqueued).toBe(2);
    expect(result.status).toBe("running");
    expect(audits).toEqual([
      {
        workspaceId: "ws_opak",
        actorId: "user_1",
        entityId: "batch_1",
        action: "enrichment_batch.advanced",
        metadata: { enqueued: 2, spentUsd: 0, budgetUsd: 10 },
      },
    ]);
  });

  it("stops and enqueues nothing once observed spend reaches the budget", async () => {
    const { service, enqueued, statuses } = advanceServiceWith({
      spent: 10,
      budget: 10,
      pending: ["draft_1", "draft_2"],
    });

    const result = await service.advanceBatch(advanceInput);

    expect(enqueued).toEqual([]);
    expect(result.status).toBe("budget_exhausted");
    expect(statuses).toContain("budget_exhausted");
  });

  it("completes the batch when nothing is left to do", async () => {
    const { service, statuses } = advanceServiceWith({
      spent: 1,
      budget: 10,
      pending: [],
      counts: { pending: 0, queued: 0 },
    });

    const result = await service.advanceBatch(advanceInput);

    expect(result.status).toBe("completed");
    expect(statuses).toContain("completed");
  });

  it("reconciles queued drafts that reached a terminal state", async () => {
    const { service, marked } = advanceServiceWith({
      spent: 1,
      budget: 10,
      pending: [],
      queued: ["draft_done", "draft_dead", "draft_busy"],
      listingStatuses: {
        draft_done: "in_review",
        draft_dead: "failed",
        draft_busy: "processing",
      },
      counts: { pending: 0, queued: 1 },
    });

    await service.advanceBatch(advanceInput);

    expect(marked).toEqual([
      { listingIds: ["draft_done"], status: "succeeded" },
      { listingIds: ["draft_dead"], status: "failed" },
    ]);
  });

  it("does not complete a batch whose queued drafts are still running", async () => {
    const { service, statuses } = advanceServiceWith({
      spent: 1,
      budget: 10,
      pending: [],
      queued: ["draft_busy"],
      listingStatuses: { draft_busy: "processing" },
      counts: { pending: 0, queued: 1 },
    });

    const result = await service.advanceBatch(advanceInput);

    expect(result.status).toBe("running");
    expect(statuses).not.toContain("completed");
  });

  it("rejects an unknown batch", async () => {
    const service = createEnrichmentBatchService({
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            _workspaceId: string,
            work: (repositories: any) => Promise<T>,
          ) {
            return work({
              enrichmentBatches: {
                async getById() {
                  return null;
                },
              },
            });
          },
        }) as never,
      publisher: {
        async enqueue() {
          return { id: "job_1" };
        },
      },
    });

    await expect(service.advanceBatch(advanceInput)).rejects.toThrow(
      /no such enrichment batch/i,
    );
  });
});

describe("enrichment batch listing", () => {
  it("returns every batch the repository lists", async () => {
    const batches = [
      {
        id: "batch_1",
        label: "first",
        budgetUsd: 5,
        waveSize: 2,
        status: "open" as const,
        createdBy: "user_1",
        createdAt: new Date("2026-08-01T00:00:00Z"),
      },
    ];
    const service = createEnrichmentBatchService({
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            _workspaceId: string,
            work: (repositories: any) => Promise<T>,
          ) {
            return work({
              enrichmentBatches: {
                async listForWorkspace() {
                  return batches;
                },
              },
            });
          },
        }) as never,
      publisher: { async enqueue() { return { id: "job_1" }; } },
    });

    const result = await service.listBatches({ workspaceId: "ws_opak" });
    expect(result).toEqual(batches);
  });
});

describe("enrichment batch detail", () => {
  it("returns a batch with its item status counts", async () => {
    const counts = {
      pending: 1,
      queued: 0,
      succeeded: 2,
      failed: 0,
      skipped: 0,
    };
    const service = createEnrichmentBatchService({
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            _workspaceId: string,
            work: (repositories: any) => Promise<T>,
          ) {
            return work({
              enrichmentBatches: {
                async getById(id: string) {
                  return {
                    id,
                    label: "detail test",
                    budgetUsd: 5,
                    waveSize: 2,
                    status: "running",
                    createdBy: "user_1",
                    createdAt: new Date("2026-08-01T00:00:00Z"),
                  };
                },
                async countByStatus() {
                  return counts;
                },
              },
            });
          },
        }) as never,
      publisher: { async enqueue() { return { id: "job_1" }; } },
    });

    const result = await service.getBatch({
      workspaceId: "ws_opak",
      batchId: "batch_1",
    });
    expect(result.batch.id).toBe("batch_1");
    expect(result.counts).toEqual(counts);
  });

  it("rejects an unknown batch", async () => {
    const service = createEnrichmentBatchService({
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            _workspaceId: string,
            work: (repositories: any) => Promise<T>,
          ) {
            return work({
              enrichmentBatches: { async getById() { return null; } },
            });
          },
        }) as never,
      publisher: { async enqueue() { return { id: "job_1" }; } },
    });

    await expect(
      service.getBatch({ workspaceId: "ws_opak", batchId: "missing" }),
    ).rejects.toThrow(/no such enrichment batch/i);
  });
});
