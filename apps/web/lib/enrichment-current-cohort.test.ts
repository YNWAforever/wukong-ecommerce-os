import { emptyWorkingListing } from "@wukong/core";
import { describe, expect, it } from "vitest";
import { createEnrichmentBatchService } from "./enrichment-batch-service";

function fixture(count: number, currentChinese: string) {
  const content = emptyWorkingListing();
  content.title = { en: "Synthetic Estate", "zh-Hant": currentChinese };
  const records = Array.from({ length: count }, (_, index) => ({
    listingId: `draft-${String(index).padStart(5, "0")}`,
    status: "received",
    assessmentState: "assessed",
    content,
    fence: { inputRevision: 5, activeVersionId: null, sourceBinding: null },
  }));
  const created: any[] = [];
  const service = createEnrichmentBatchService({
    getDatabase: () =>
      ({
        forWorkspace: (_: string, work: (repositories: any) => unknown) =>
          work({
            platformProducts: {
              listRecent: (limit: number) =>
                records.slice(-limit).map((record) => ({
                  ...record,
                  origin: "import",
                  rawRow: { nameEn: "Old name", nameZh: "Old name" },
                })),
              scanMaintenancePage: (
                afterId: string | undefined,
                limit: number,
              ) =>
                records
                  .filter((record) => !afterId || record.listingId > afterId)
                  .slice(0, limit),
            },
            enrichmentBatches: {
              create: (input: any) => {
                created.push(input);
                return {
                  id: "batch-synthetic",
                  budgetUsd: input.budgetUsd,
                  waveSize: input.waveSize,
                };
              },
            },
            audit: { write: async () => undefined },
          }),
      }) as never,
    publisher: { enqueue: async () => ({ id: "unused" }) },
  });
  return { service, created, records };
}
const input = {
  workspaceId: "ws_synthetic",
  actorId: "operator",
  label: "Current Chinese",
  gap: "untranslatedName" as const,
  budgetUsd: 5,
  waveSize: 3,
};

describe("current-content cohort authority", () => {
  it("does not reselect a historical raw-row gap already repaired by a human", async () => {
    const { service, created } = fixture(1, "人工已補中文");
    await expect(service.createBatch(input)).rejects.toMatchObject({
      code: "empty_cohort",
    });
    expect(created).toEqual([]);
  });

  it("scans all 5001 listings and reports the execution cap and continuation", async () => {
    const { service, created, records } = fixture(5001, "Synthetic Estate");
    const result = await service.createBatch(input);
    expect(result).toMatchObject({
      selected: 5000,
      totalMatching: 5001,
      truncated: true,
      continuation: records[4999]!.listingId,
    });
    expect(created[0].listingIds).toContain(records[0]!.listingId);
    expect(created[0].contentFences[records[0]!.listingId].inputRevision).toBe(
      5,
    );
  });
});
