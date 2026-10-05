import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createEnrichmentBatchService } from "./enrichment-batch-service";

function fixture() {
  const asset = randomUUID(),
    listing = randomUUID();
  const read = vi.fn(async () => ({
    url: "https://local.invalid/safe-preview",
    expiresAt: new Date("2026-10-01T10:00:00Z"),
  }));
  const getByIds = vi.fn(async () => [
    {
      id: asset,
      listingId: listing,
      kind: "image/png",
      storageKey: "ws/owned/synthetic.png",
    },
  ]);
  const repos = {
    sourceAssets: { getByIds },
    enrichmentBatches: {
      getById: async () => ({
        id: "batch",
        createdAt: new Date(),
        status: "running",
      }),
      countByStatus: async () => ({
        pending: 0,
        queued: 1,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      }),
      listItemDetails: async () => [
        { id: "item", listingId: listing, thumbnailAssetId: asset },
      ],
      sumBoundRunCost: async () => 0,
    },
  };
  const service = createEnrichmentBatchService({
    getDatabase: () =>
      ({
        forWorkspace: async (_ws: string, work: any) => work(repos),
      }) as never,
    publisher: { enqueue: async () => ({ id: "unused" }) },
    getAssetStore: () => ({ createReadUrl: read }),
  });
  return { service, read, getByIds, asset, listing };
}
it("signs only an owned image associated with that item's listing in one asset query", async () => {
  const f = fixture();
  const result = await f.service.getBatch({
    workspaceId: "owned",
    batchId: "batch",
  });
  expect(result.items?.[0]).toMatchObject({
    thumbnailUrl: "https://local.invalid/safe-preview",
    thumbnailState: "ready",
  });
  expect(f.getByIds).toHaveBeenCalledOnce();
  expect(f.read).toHaveBeenCalledWith("owned", "ws/owned/synthetic.png", {
    expiresInMs: 300_000,
  });
  f.getByIds.mockResolvedValueOnce([
    {
      id: f.asset,
      listingId: randomUUID(),
      kind: "image/png",
      storageKey: "ws/owned/unrelated.png",
    },
  ]);
  f.read.mockClear();
  expect(
    (await f.service.getBatch({ workspaceId: "owned", batchId: "batch" }))
      .items?.[0],
  ).toMatchObject({ thumbnailUrl: null, thumbnailState: "unavailable" });
  expect(f.read).not.toHaveBeenCalled();
});
it("degrades signing only but propagates whole asset DB/permission failure", async () => {
  const f = fixture();
  f.read.mockRejectedValueOnce(new Error("PRIVATE_SIGNING_ERROR"));
  expect(
    (await f.service.getBatch({ workspaceId: "owned", batchId: "batch" }))
      .items?.[0],
  ).toMatchObject({ thumbnailUrl: null, thumbnailState: "unavailable" });
  f.getByIds.mockRejectedValueOnce(
    Object.assign(new Error("PRIVATE_DATABASE_ERROR"), { code: "42501" }),
  );
  await expect(
    f.service.getBatch({ workspaceId: "owned", batchId: "batch" }),
  ).rejects.toMatchObject({ code: "42501" });
});
