import { describe, expect, it } from "vitest";

import { createEnrichmentBatchService } from "./enrichment-batch-service";

const untranslated = {
  remoteProductId: "remote_1",
  listingId: "draft_1",
  rawRow: { nameEn: "Demo Estate Riesling", nameZh: "Demo Estate Riesling" },
};
const translated = {
  remoteProductId: "remote_2",
  listingId: "draft_2",
  rawRow: { nameEn: "Demo Estate Riesling", nameZh: "示範酒莊麗絲玲" },
};
const unlinked = {
  remoteProductId: "remote_3",
  listingId: null,
  rawRow: { nameEn: "Never imported", nameZh: "Never imported" },
};

type AuditRecord = { action: string; entityId: string; metadata: unknown };

function serviceWith(products = [untranslated, translated, unlinked]) {
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
      waveSize: 10,
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
      waveSize: 10,
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
          waveSize: 10,
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
        waveSize: 10,
      }),
    ).rejects.toThrow(/no products match/i);
    expect(recorded.created).toEqual([]);
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
        waveSize: 10,
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
});

type Marked = { listingIds: string[]; status: string };

/** Fixed so the spend-window assertion does not depend on wall-clock time. */
const BATCH_CREATED_AT = new Date("2026-08-16T00:00:00.000Z");

function advanceServiceWith(options: {
  spent: number;
  budget: number;
  pending: string[];
  queued?: string[];
  listingStatuses?: Record<string, string>;
  counts?: Record<string, number>;
  status?: string;
}) {
  const enqueued: string[] = [];
  const statuses: string[] = [];
  const marked: Marked[] = [];
  const audits: AuditRecord[] = [];
  const spendBounds: (Date | undefined)[] = [];
  const queued = options.queued ?? [];
  let remaining = [...options.pending];
  // Which queued drafts reconciliation actually resolved. `countByStatus` is
  // derived from this rather than from a fixture, so a test that asserts a
  // batch completed genuinely depends on the classification under test.
  const resolved = new Set<string>();

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
                  status: options.status ?? "open",
                  createdBy: "user_1",
                  createdAt: BATCH_CREATED_AT,
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
                  queued: queued.filter((id) => !resolved.has(id)).length,
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
                for (const id of listingIds) resolved.add(id);
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
              async sumCostForListings(_ids: string[], since?: Date) {
                spendBounds.push(since);
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

  return { service, enqueued, statuses, marked, audits, spendBounds };
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
    });

    const result = await service.advanceBatch(advanceInput);

    expect(result.status).toBe("running");
    expect(statuses).not.toContain("completed");
  });

  it("counts a draft that stopped for more information as finished, not in flight", async () => {
    const { service, marked } = advanceServiceWith({
      spent: 1,
      budget: 10,
      pending: [],
      queued: ["draft_stuck"],
      listingStatuses: { draft_stuck: "needs_info" },
      counts: { pending: 0, queued: 0 },
    });

    await service.advanceBatch(advanceInput);

    // It spent budget and produced no listing, so it is a failure for the
    // batch — but above all it must not stay queued forever.
    expect(marked).toContainEqual({
      listingIds: ["draft_stuck"],
      status: "failed",
    });
  });

  it("completes a batch whose last draft stopped for more information", async () => {
    const { service, statuses } = advanceServiceWith({
      spent: 1,
      budget: 10,
      pending: [],
      queued: ["draft_stuck"],
      listingStatuses: { draft_stuck: "needs_info" },
    });

    const result = await service.advanceBatch(advanceInput);

    expect(result.status).toBe("completed");
    expect(statuses).toContain("completed");
  });

  it("counts a reopened draft as enriched", async () => {
    const { service, marked } = advanceServiceWith({
      spent: 1,
      budget: 10,
      pending: [],
      queued: ["draft_reopened"],
      listingStatuses: { draft_reopened: "reopened" },
      counts: { pending: 0, queued: 0 },
    });

    await service.advanceBatch(advanceInput);

    // A human approved it and then reopened it. The enrichment run the batch
    // paid for did its job; what happened afterwards is review work.
    expect(marked).toContainEqual({
      listingIds: ["draft_reopened"],
      status: "succeeded",
    });
  });

  it("charges only spend recorded since the batch was created", async () => {
    const { service, spendBounds } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1"],
    });

    await service.advanceBatch(advanceInput);

    // Unbounded, a draft that an earlier batch already enriched would arrive
    // carrying that batch's cost and could exhaust this budget immediately.
    expect(spendBounds).toEqual([BATCH_CREATED_AT]);
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

  it.each(["completed", "cancelled"])(
    "refuses to advance a %s batch",
    async (status) => {
      const { service, enqueued, statuses } = advanceServiceWith({
        spent: 0,
        budget: 10,
        pending: ["draft_1"],
        status,
      });

      await expect(service.advanceBatch(advanceInput)).rejects.toThrow(
        /finished/i,
      );
      // The point of the guard: a cancelled batch with pending items would
      // otherwise claim a wave and set itself back to running.
      expect(enqueued).toEqual([]);
      expect(statuses).toEqual([]);
    },
  );

  it("still advances a batch that previously exhausted its budget", async () => {
    const { service, enqueued } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1"],
      status: "budget_exhausted",
    });

    // Not terminal: re-advancing re-derives spend, which is the only way an
    // operator learns the batch is still stuck.
    const result = await service.advanceBatch(advanceInput);

    expect(result.status).toBe("running");
    expect(enqueued).toEqual(["draft_1"]);
  });
});
