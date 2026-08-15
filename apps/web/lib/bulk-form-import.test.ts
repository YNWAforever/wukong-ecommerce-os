import { describe, expect, it } from "vitest";

import { BULK_FORM_COLUMNS, type BulkFormColumnKey } from "@wukong/shopline";

import { createBulkFormImporter } from "./bulk-form-import";

const HEADER_EN = BULK_FORM_COLUMNS.map((column) => column.en);
const HEADER_ZH = BULK_FORM_COLUMNS.map((column) => column.zh);

const DEFAULTS: Partial<Record<BulkFormColumnKey, string>> = {
  productId: "remote_1",
  nameEn: "Demo Estate Riesling 2024",
  nameZh: "Demo Estate Riesling 2024",
  sku: "0001",
  regularPrice: "100.0",
  salePrice: "80.0",
  quantity: "6",
  updateQuantity: "+0",
  onlineStoreCategories: "White Wine>Germany>Mosel",
};

const rowFor = (overrides: Partial<Record<BulkFormColumnKey, string>> = {}) =>
  BULK_FORM_COLUMNS.map(
    (column) => overrides[column.key] ?? DEFAULTS[column.key] ?? "",
  );

const sheetOf = (...rows: string[][]) => [HEADER_EN, HEADER_ZH, ...rows];

type Recorded = {
  created: { note: string | null }[];
  upserts: {
    remoteProductId: string;
    listingId: string | null;
    contentDigest: string;
  }[];
  audits: { action: string; entityId: string }[];
};

function importerWith(
  existing: Record<string, { listingId: string; contentDigest: string }> = {},
) {
  const recorded: Recorded = { created: [], upserts: [], audits: [] };
  let nextDraft = 0;

  const importBulkForm = createBulkFormImporter({
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repositories: any) => Promise<T>,
        ) {
          return work({
            shoplineConnections: {
              async getDefault() {
                return { id: "connection_1" };
              },
            },
            platformProducts: {
              async listByRemoteProductIds(
                _connectionId: string,
                ids: string[],
              ) {
                return ids
                  .filter((id) => existing[id] !== undefined)
                  .map((id) => ({ remoteProductId: id, ...existing[id] }));
              },
              async upsert(input: Recorded["upserts"][number]) {
                recorded.upserts.push(input);
                return input;
              },
            },
            listings: {
              async create(input: { note: string | null }) {
                recorded.created.push(input);
                nextDraft += 1;
                return { id: `draft_${nextDraft}` };
              },
            },
            audit: {
              async write(event: Recorded["audits"][number]) {
                recorded.audits.push(event);
              },
            },
          });
        },
      }) as never,
  });

  return { importBulkForm, recorded };
}

describe("bulk form importer", () => {
  it("creates one draft per parsed row and links it to the remote product", async () => {
    const { importBulkForm, recorded } = importerWith();

    const result = await importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      sheet: sheetOf(rowFor(), rowFor({ productId: "remote_2", sku: "0002" })),
    });

    expect(result.parsedRows).toBe(2);
    expect(result.createdDrafts).toBe(2);
    expect(result.refreshedProducts).toBe(0);
    expect(recorded.created).toHaveLength(2);
    expect(recorded.upserts.map((upsert) => upsert.listingId)).toEqual([
      "draft_1",
      "draft_2",
    ]);
  });

  it("writes an audit event per created draft", async () => {
    const { importBulkForm, recorded } = importerWith();

    await importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      sheet: sheetOf(rowFor()),
    });

    expect(recorded.audits).toEqual([
      expect.objectContaining({
        action: "listing.imported",
        entityId: "draft_1",
      }),
    ]);
  });

  it("keeps an already-imported product on its existing draft", async () => {
    const { importBulkForm, recorded } = importerWith({
      remote_1: { listingId: "draft_existing", contentDigest: "stale" },
    });

    const result = await importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      sheet: sheetOf(rowFor()),
    });

    expect(result.createdDrafts).toBe(0);
    expect(result.refreshedProducts).toBe(1);
    expect(recorded.created).toEqual([]);
    expect(recorded.upserts[0]?.listingId).toBe("draft_existing");
  });

  it("does not count an unchanged re-import as a refresh", async () => {
    const first = importerWith();
    await first.importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      sheet: sheetOf(rowFor()),
    });
    const digest = first.recorded.upserts[0]?.contentDigest ?? "";

    const second = importerWith({
      remote_1: { listingId: "draft_existing", contentDigest: digest },
    });
    const result = await second.importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      sheet: sheetOf(rowFor()),
    });

    expect(result.createdDrafts).toBe(0);
    expect(result.refreshedProducts).toBe(0);
  });

  it("reports parse warnings without dropping the import", async () => {
    const { importBulkForm } = importerWith();

    const result = await importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      sheet: sheetOf(rowFor({ quantity: "-1" })),
    });

    expect(result.createdDrafts).toBe(1);
    expect(result.issues.map((issue) => issue.code)).toContain(
      "quantity_negative",
    );
  });

  it("rejects a sheet with no readable rows", async () => {
    const { importBulkForm } = importerWith();

    await expect(
      importBulkForm({
        workspaceId: "ws_opak",
        actorId: "user_1",
        sheet: [["nonsense"]],
      }),
    ).rejects.toThrow(/No product rows/);
  });

  it("rejects an import when no SHOPLINE connection exists", async () => {
    const importBulkForm = createBulkFormImporter({
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            _workspaceId: string,
            work: (repositories: any) => Promise<T>,
          ) {
            return work({
              shoplineConnections: {
                async getDefault() {
                  return null;
                },
              },
            });
          },
        }) as never,
    });

    await expect(
      importBulkForm({
        workspaceId: "ws_opak",
        actorId: "user_1",
        sheet: sheetOf(rowFor()),
      }),
    ).rejects.toThrow(/Connect a SHOPLINE store/);
  });
});
