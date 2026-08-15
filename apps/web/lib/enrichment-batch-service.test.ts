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
    expect((recorded.created[0] as { listingIds: string[] }).listingIds).toEqual(
      ["draft_1"],
    );
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
