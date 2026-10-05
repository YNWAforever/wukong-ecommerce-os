import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { emptyWorkingListing } from "@wukong/core";
import type { Database } from "@wukong/db";
import {
  createBatchSelectionService,
  batchSelectionSchema,
} from "./batch-selection";

function fixture() {
  const ids = [randomUUID(), randomUUID()];
  const rows = ids.map((listingId) => ({
    listingId,
    status: "received",
    assessmentState: "assessed",
    content: {
      ...emptyWorkingListing(),
      producer: "Synthetic Estate",
      productType: "wine" as const,
      country: "France",
      packQuantity: 6 as number | null,
      title: { en: "Synthetic", "zh-Hant": "" },
    },
    fence: { inputRevision: 5, activeVersionId: null, sourceBinding: null },
  }));
  const receipts = new Map<string, any>();
  const previews = new Map<string, any>();
  const create = vi.fn(async () => ({ id: randomUUID() }));
  const audit = vi.fn();
  const repos = {
    platformProducts: {
      lockMaintenanceListings: vi.fn(),
      lockMaintenanceBindings: vi.fn(),
      getMaintenanceByIds: vi.fn(async (selected: string[]) =>
        rows.filter((row) => selected.includes(row.listingId)),
      ),
    },
    listings: { lockReviewState: vi.fn() },
    workspaces: { requireProfile: vi.fn(async () => ({})) },
    enrichmentBatches: {
      create,
      insertPreview: vi.fn(async (value: any) => {
        previews.set(value.id, value);
      }),
      lockPreview: vi.fn(async (id: string) => previews.get(id) ?? null),
      findPreviewCreate: vi.fn(
        async (key: string) => receipts.get(key) ?? null,
      ),
      previewHasCreate: vi.fn(async () => false),
      recordPreviewCreate: vi.fn(
        async (key: string, digest: string, response: any) => {
          receipts.set(key, { digest, response });
        },
      ),
    },
    audit: { write: audit },
  };
  const service = createBatchSelectionService({
    getDatabase: () =>
      ({
        forWorkspace: async (_ws: string, work: any) => work(repos),
      }) as unknown as Database,
    now: () => new Date("2026-10-01T08:00:00Z"),
    provider: "fake",
  });
  const input = {
    workspaceId: "ws-synthetic",
    actorId: "operator",
    label: "Synthetic",
    budgetUsd: 1,
    waveSize: 2,
    selection: {
      mode: "explicit" as const,
      listingIds: ids,
      fields: ["nameZh" as const],
    },
  };
  return { service, input, rows, repos, previews };
}
describe("immutable explicit maintenance preview", () => {
  it("shows an unknown pack as needing confirmation before any batch admission", async () => {
    const f = fixture();
    f.rows[1]!.content.packQuantity = null;
    expect(await f.service.preview(f.input)).toMatchObject({
      selectedCount: 2,
      eligibleCount: 1,
      skippedByReason: { confirm_pack_quantity: 1 },
    });
    expect(f.repos.enrichmentBatches.create).not.toHaveBeenCalled();
  });
  it("rejects a gap cohort that changes between its scan and immutable preview", async () => {
    const f = fixture();
    Object.assign(f.repos.platformProducts, {
      scanMaintenancePage: vi.fn(async (afterId?: string) => {
        if (afterId) return [];
        return structuredClone(f.rows);
      }),
    });
    f.repos.platformProducts.getMaintenanceByIds.mockImplementation(
      async (selected) => {
        f.rows[0]!.fence.inputRevision += 1;
        f.rows[0]!.content.title["zh-Hant"] = "人工已補";
        return f.rows.filter((row) => selected.includes(row.listingId));
      },
    );
    await expect(
      f.service.previewCohort({
        workspaceId: f.input.workspaceId,
        actorId: f.input.actorId,
        label: "Current gap",
        budgetUsd: 1,
        waveSize: 2,
        gap: "untranslatedName",
        fields: ["nameZh"],
      }),
    ).rejects.toMatchObject({ code: "batch_content_stale" });
    expect(f.repos.enrichmentBatches.insertPreview).not.toHaveBeenCalled();
  });
  it("rejects foreign identities and non-whitelisted hidden fields before saving", async () => {
    const f = fixture();
    expect(
      batchSelectionSchema.safeParse({
        ...f.input.selection,
        fields: ["nameZh", "priceHkd"],
      }).success,
    ).toBe(false);
    await expect(
      f.service.preview({
        ...f.input,
        selection: {
          ...f.input.selection,
          listingIds: [...f.input.selection.listingIds, randomUUID()],
        },
      }),
    ).rejects.toMatchObject({ code: "selection_not_authorized" });
    expect(f.repos.enrichmentBatches.insertPreview).not.toHaveBeenCalled();
  });
  it("previews without creating/enqueueing and creates once from the stored options", async () => {
    const f = fixture();
    const preview = await f.service.preview(f.input);
    expect(preview).toMatchObject({
      eligibleCount: 2,
      fields: ["nameZh"],
      maxCostUsd: 0,
    });
    expect(f.repos.enrichmentBatches.create).not.toHaveBeenCalled();
    const input = {
      workspaceId: f.input.workspaceId,
      actorId: f.input.actorId,
      previewId: preview.previewId,
      digest: preview.digest,
      idempotencyKey: randomUUID(),
    };
    const created = await f.service.create(input);
    expect(await f.service.create(input)).toEqual(created);
    expect(f.repos.enrichmentBatches.create).toHaveBeenCalledTimes(1);
    expect(f.repos.enrichmentBatches.create).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: ["nameZh"],
        contentFences: expect.any(Object),
      }),
    );
  });
  it("rejects tampered digest, expiry, another actor, and any changed selected fence as a whole", async () => {
    for (const mode of ["digest", "expiry", "actor", "fence"]) {
      const f = fixture();
      const preview = await f.service.preview(f.input);
      const input = {
        workspaceId: f.input.workspaceId,
        actorId: f.input.actorId,
        previewId: preview.previewId,
        digest: preview.digest,
        idempotencyKey: randomUUID(),
      };
      if (mode === "digest") input.digest = "a".repeat(64);
      if (mode === "actor") input.actorId = "other-operator";
      if (mode === "expiry")
        f.previews.get(preview.previewId).expiresAt = "2026-10-01T07:59:59Z";
      if (mode === "fence") f.rows[1]!.fence.inputRevision = 6;
      await expect(f.service.create(input)).rejects.toMatchObject({
        status: mode === "actor" ? 404 : 409,
      });
      expect(f.repos.enrichmentBatches.create).not.toHaveBeenCalled();
    }
  });
});
