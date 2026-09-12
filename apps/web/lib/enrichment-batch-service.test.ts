import { describe, expect, it } from "vitest";

import { createEnrichmentBatchService } from "./enrichment-batch-service";
import { MAX_ENRICHMENT_WAVE_SIZE } from "./enrichment-wave-limit";

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

/** Fixed so the cost-window assertion has something exact to compare to. */
const BATCH_CREATED_AT = new Date("2026-09-01T00:00:00.000Z");

function advanceServiceWith(options: {
  spent: number;
  budget: number;
  pending: string[];
  queued?: string[];
  listingStatuses?: Record<string, string>;
  counts?: Record<string, number>;
  sequences?: Record<string, number>;
  recordedRuns?: Record<string, number>;
  /** Rows an earlier advance recorded and never confirmed as sent. */
  stranded?: Array<{
    id: string;
    listingId: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
  }>;
  enqueueFails?: (job: { draftId: string }) => boolean;
  /** What the row holds, which need not be what the API would accept. */
  storedWaveSize?: number;
}) {
  const enqueued: string[] = [];
  const jobs: Array<Record<string, unknown>> = [];
  const costWindows: Array<Date | null> = [];
  // Mirrors the repository: unique on dedupeKey, and `pending` only ever
  // returns rows nothing has confirmed.
  const outbox = new Map<
    string,
    {
      id: string;
      listingId: string;
      dedupeKey: string;
      payload: Record<string, unknown>;
      attempts: number;
      dispatched: boolean;
    }
  >();
  for (const row of options.stranded ?? []) {
    outbox.set(row.dedupeKey, { ...row, attempts: 0, dispatched: false });
  }
  const statuses: string[] = [];
  const marked: Marked[] = [];
  const audits: AuditRecord[] = [];
  const queued = options.queued ?? [];
  let remaining = [...options.pending];
  const claimLimits: number[] = [];

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
                  waveSize: options.storedWaveSize ?? 2,
                  status: "open",
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
                claimLimits.push(limit);
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
                // A draft with no configured status is a plain unprocessed
                // one. Before the wave gate existed the service never asked,
                // so the fake could leave them undefined.
                return Object.fromEntries(
                  ids.map((id) => [
                    id,
                    options.listingStatuses?.[id] ?? "received",
                  ]),
                );
              },
              async requireById(id: string) {
                return {
                  activeVersionSequence: options.sequences?.[id] ?? 0,
                };
              },
            },
            pipelineRuns: {
              async countRuns({ listingId }: { listingId: string }) {
                return options.recordedRuns?.[listingId] ?? 0;
              },
            },
            dispatchOutbox: {
              async record(
                entries: Array<{
                  listingId: string;
                  dedupeKey: string;
                  payload: Record<string, unknown>;
                }>,
              ) {
                const created = [];
                for (const entry of entries) {
                  if (outbox.has(entry.dedupeKey)) continue;
                  const row = {
                    ...entry,
                    id: `outbox_${outbox.size + 1}`,
                    attempts: 0,
                    dispatched: false,
                  };
                  outbox.set(entry.dedupeKey, row);
                  created.push(row);
                }
                return created;
              },
              async pending() {
                return [...outbox.values()].filter((row) => !row.dispatched);
              },
              async markDispatched(ids: string[]) {
                for (const row of outbox.values()) {
                  if (ids.includes(row.id)) row.dispatched = true;
                }
              },
              async markAttempted(ids: string[]) {
                for (const row of outbox.values()) {
                  if (ids.includes(row.id) && !row.dispatched)
                    row.attempts += 1;
                }
              },
            },
            aiRuns: {
              async sumCostForListings(
                _ids: readonly string[],
                costOptions?: { since?: Date },
              ) {
                costWindows.push(costOptions?.since ?? null);
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
        if (options.enqueueFails?.(job)) throw new Error("queue unreachable");
        enqueued.push(job.draftId);
        jobs.push({ ...job });
        return { id: `job_${job.draftId}` };
      },
    },
  });

  return {
    service,
    enqueued,
    jobs,
    statuses,
    marked,
    audits,
    costWindows,
    outbox,
    claimLimits,
  };
}

const advanceInput = {
  workspaceId: "ws_opak",
  actorId: "user_1",
  batchId: "batch_1",
};

describe("the wave cap on advance", () => {
  /**
   * G12 asked for the cap to be enforced by the API, not the UI.
   *
   * `createBatch` and the route schema both refuse an over-large `waveSize`,
   * so no request can store one. A row can still hold one -- an earlier bug, a
   * migration, a direct write -- and `advanceBatch` claimed using the stored
   * number, so that row dispatched that many AI calls per advance. The ceiling
   * is the unguarded side: Postgres already refuses a zero or negative value
   * (0005_enrichment_batches.sql:20 CHECK (wave_size > 0)).
   */
  it("claims no more than the cap when the row holds a larger number", async () => {
    const pending = Array.from({ length: 40 }, (_, i) => `listing_${i}`);
    const { service, claimLimits, enqueued } = advanceServiceWith({
      pending,
      budget: 1000,
      spent: 0,
      storedWaveSize: 40,
    });

    await service.advanceBatch(advanceInput);

    expect(claimLimits).toEqual([MAX_ENRICHMENT_WAVE_SIZE]);
    expect(enqueued).toHaveLength(MAX_ENRICHMENT_WAVE_SIZE);
  });

  it("leaves a legitimate wave size exactly as stored", async () => {
    // Clamping must not quietly become a floor: a batch created at 2 still
    // claims 2, not the cap.
    const { service, claimLimits } = advanceServiceWith({
      pending: ["listing_a", "listing_b", "listing_c", "listing_d"],
      budget: 1000,
      spent: 0,
      storedWaveSize: 2,
    });

    await service.advanceBatch(advanceInput);

    expect(claimLimits).toEqual([2]);
  });
});

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
      publisher: {
        async enqueue() {
          return { id: "job_1" };
        },
      },
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
      publisher: {
        async enqueue() {
          return { id: "job_1" };
        },
      },
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

    await expect(
      service.getBatch({ workspaceId: "ws_opak", batchId: "missing" }),
    ).rejects.toThrow(/no such enrichment batch/i);
  });
});

/**
 * What a batch actually sends, and what it declines to send.
 *
 * Every wave used to enqueue `activeVersionSequence: 0` regardless of the
 * draft's real revision. For anything that had already been through the
 * pipeline that key resolved to a completed run, so the Worker returned the
 * cached result without calling the model: the item was marked queued, then
 * reconciled as succeeded, and the catalog was unchanged. The operator read
 * "enqueued: 5" over five listings nothing had touched. The cohort makes that
 * the expected case rather than a corner -- the gap is read from an imported
 * sheet row enrichment never rewrites, so a second batch re-selects exactly
 * the same drafts.
 *
 * Sending the real revision is only safe together with a status gate, which is
 * why they are pinned together here: a genuine job for an approved or
 * published draft spends on the model and then throws on the status
 * transition, rolling back the cost record written in the same transaction.
 */
describe("what a wave enqueues", () => {
  it("uses the draft's real revision and a fresh attempt", async () => {
    const { service, jobs } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1"],
      sequences: { draft_1: 2 },
      recordedRuns: { draft_1: 1 },
    });

    await service.advanceBatch(advanceInput);

    expect(jobs).toEqual([
      {
        workspaceId: "ws_opak",
        draftId: "draft_1",
        activeVersionSequence: 2,
        runAttempt: 1,
      },
    ]);
  });

  it("omits runAttempt entirely for a draft that has never run", async () => {
    // A Worker deployed before `runAttempt` existed parses the envelope
    // strictly and acks an unrecognised field away in silence, so the common
    // path must stay byte-identical to what it always was.
    const { service, jobs } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1"],
    });

    await service.advanceBatch(advanceInput);

    expect(jobs).toEqual([
      {
        workspaceId: "ws_opak",
        draftId: "draft_1",
        activeVersionSequence: 0,
      },
    ]);
  });

  it("does not send a draft the pipeline cannot start from", async () => {
    // `transitionListing` has no edge out of `approved` or `published` for
    // submit_review, so this job would run extraction and generation and then
    // throw while completing -- and the throw takes the cost record with it.
    const { service, enqueued, marked } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_done", "draft_live", "draft_open"],
      listingStatuses: {
        draft_done: "approved",
        draft_live: "published",
        draft_open: "received",
      },
    });

    const result = await service.advanceBatch(advanceInput);

    // waveSize is 2, so only the first two are claimed this time.
    expect(enqueued).toEqual([]);
    expect(result.enqueued).toBe(0);
    expect(marked).toEqual([
      { listingIds: ["draft_done", "draft_live"], status: "succeeded" },
    ]);
  });

  it("skips a draft stuck somewhere the pipeline cannot use", async () => {
    const { service, enqueued, marked } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_held"],
      listingStatuses: { draft_held: "publishing" },
    });

    await service.advanceBatch(advanceInput);

    expect(enqueued).toEqual([]);
    expect(marked).toEqual([
      { listingIds: ["draft_held"], status: "succeeded" },
    ]);
  });

  it("still sends a draft that needs information or has failed", async () => {
    const { service, enqueued } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_short", "draft_broken"],
      listingStatuses: {
        draft_short: "needs_info",
        draft_broken: "failed",
      },
    });

    await service.advanceBatch(advanceInput);

    expect(enqueued).toEqual(["draft_short", "draft_broken"]);
  });
});

describe("closing out a batch", () => {
  it("settles a queued item that came back needing information", async () => {
    // Neither succeeded nor failed, so it was in neither reconciliation list
    // and stayed `queued`. `done` requires an empty queued bucket, so the
    // batch could never report itself complete and the operator was left
    // watching a counter that would not move.
    const { service, marked } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: [],
      queued: ["draft_short", "draft_back"],
      listingStatuses: {
        draft_short: "needs_info",
        draft_back: "reopened",
      },
      counts: { pending: 0, queued: 0 },
    });

    const result = await service.advanceBatch(advanceInput);

    expect(marked).toEqual([
      { listingIds: ["draft_short", "draft_back"], status: "skipped" },
    ]);
    expect(result.status).toBe("completed");
  });
});

describe("what a batch's budget counts", () => {
  it("counts only spend recorded after the batch was created", async () => {
    const { service, costWindows } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1"],
    });

    await service.advanceBatch(advanceInput);

    expect(costWindows).toEqual([BATCH_CREATED_AT]);
  });

  it("advances a cohort an earlier batch already spent against", async () => {
    // The prescribed recovery from a bad run is a new batch over the same
    // drafts. Counting all history meant that batch opened pre-charged with
    // the first one's spend -- and since no route can change a batch's budget
    // after creation, an operator had no way out of it at all.
    const { service } = advanceServiceWith({
      spent: 0, // what the window returns: nothing since this batch began
      budget: 5,
      pending: ["draft_1"],
    });

    const result = await service.advanceBatch(advanceInput);

    expect(result.status).toBe("running");
    expect(result.enqueued).toBe(1);
  });

  it("still refuses to advance once its own spend reaches the budget", async () => {
    const { service, enqueued } = advanceServiceWith({
      spent: 5,
      budget: 5,
      pending: ["draft_1"],
    });

    const result = await service.advanceBatch(advanceInput);

    expect(result.status).toBe("budget_exhausted");
    expect(enqueued).toEqual([]);
  });
});

/**
 * Work that was decided on but never sent.
 *
 * Dispatch was an in-request loop running AFTER the claim transaction
 * committed. A request that died mid-wave left its items `queued` with no queue
 * message, no audit event, and nothing able to find them: the sweeper requires
 * a source asset, which imported drafts never have, and `claimWave` only claims
 * `pending`. The work was lost silently and permanently.
 *
 * A recovery pass was impossible to write before, because nothing recorded the
 * INTENT to send -- `listing_pipeline_runs` appears only once the pipeline
 * claims its first step, so its absence cannot tell "never sent" from "sent and
 * still queued", and re-sending the second buys a duplicate extraction.
 */
describe("recording work before sending it", () => {
  const pending = <T extends { dispatched: boolean }>(outbox: Map<string, T>) =>
    [...outbox.values()].filter((row) => !row.dispatched);

  it("records the wave, then confirms it once the queue accepts", async () => {
    const { service, enqueued, outbox } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1", "draft_2"],
    });

    await service.advanceBatch(advanceInput);

    expect(enqueued).toEqual(["draft_1", "draft_2"]);
    expect(outbox.size).toBe(2);
    expect(pending(outbox)).toEqual([]);
  });

  it("keeps the row when the queue refuses, so nothing is lost", async () => {
    const { service, outbox } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1", "draft_2"],
      enqueueFails: (job) => job.draftId === "draft_2",
    });

    const result = await service.advanceBatch(advanceInput);

    // One went out, one did not, and the batch reports only what was accepted.
    expect(result.enqueued).toBe(1);
    expect(pending(outbox).map((row) => row.listingId)).toEqual(["draft_2"]);
    expect(pending(outbox)[0]?.attempts).toBe(1);
  });

  it("does not abandon the rest of the wave when one send fails", async () => {
    // The loop used to `await` without catching, so the first failure threw and
    // every later item in the wave was never attempted at all.
    const { service, enqueued } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1", "draft_2"],
      enqueueFails: (job) => job.draftId === "draft_1",
    });

    await service.advanceBatch(advanceInput);

    expect(enqueued).toEqual(["draft_2"]);
  });

  it("re-sends what an interrupted advance recorded and never sent", async () => {
    // The whole point: this is the request that died, recovered by the next one.
    const { service, enqueued, outbox } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: [],
      counts: { pending: 0, queued: 1 },
      stranded: [
        {
          id: "outbox_x",
          listingId: "draft_lost",
          dedupeKey: "listing:ws_opak:draft_lost:0",
          payload: {
            workspaceId: "ws_opak",
            draftId: "draft_lost",
            activeVersionSequence: 0,
          },
        },
      ],
    });

    const result = await service.advanceBatch(advanceInput);

    expect(enqueued).toEqual(["draft_lost"]);
    expect(result.enqueued).toBe(1);
    expect(pending(outbox)).toEqual([]);
  });

  it("still sends stranded work after the budget is exhausted", async () => {
    // The money was committed when the item was claimed; the message merely
    // never left. Withholding it would strand the item for ever with nothing
    // owed to it, and no budget an operator could set would release it.
    const { service, enqueued } = advanceServiceWith({
      spent: 99,
      budget: 5,
      pending: ["draft_1"],
      stranded: [
        {
          id: "outbox_x",
          listingId: "draft_lost",
          dedupeKey: "listing:ws_opak:draft_lost:0",
          payload: {
            workspaceId: "ws_opak",
            draftId: "draft_lost",
            activeVersionSequence: 0,
          },
        },
      ],
    });

    const result = await service.advanceBatch(advanceInput);

    expect(enqueued).toEqual(["draft_lost"]);
    // The batch is still exhausted; it just is not hiding the debt it owed.
    expect(result.status).toBe("budget_exhausted");
  });

  it("does not record the same job twice", async () => {
    // Unique on the run key, so a retried advance cannot turn one job into two
    // messages -- and a genuinely new run carries a new attempt, so a new key.
    const { service, outbox } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1"],
      stranded: [
        {
          id: "outbox_x",
          listingId: "draft_1",
          dedupeKey: "listing:ws_opak:draft_1:0",
          payload: {
            workspaceId: "ws_opak",
            draftId: "draft_1",
            activeVersionSequence: 0,
          },
        },
      ],
    });

    await service.advanceBatch(advanceInput);

    expect(outbox.size).toBe(1);
  });

  it("reports a queue that accepted nothing as a failure, not a quiet success", async () => {
    // The work is safe and the next advance re-sends it, but answering 200 with
    // `enqueued: 0` would say the queue is healthy when it plainly is not.
    const { service, outbox } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1"],
      enqueueFails: () => true,
    });

    await expect(service.advanceBatch(advanceInput)).rejects.toThrow(
      /queue unreachable/i,
    );
    expect(pending(outbox)).toHaveLength(1);
  });
});
