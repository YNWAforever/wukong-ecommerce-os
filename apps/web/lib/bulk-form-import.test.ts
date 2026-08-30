import { describe, expect, it } from "vitest";

import { BULK_FORM_COLUMNS, type BulkFormColumnKey } from "@wukong/shopline";

import { MAX_IMPORT_ROWS, createBulkFormImporter } from "./bulk-form-import";

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

const RAW_BYTES = new Uint8Array([1, 2, 3]);
const MERCHANT_ATTESTED_EXPORT_AT = new Date("2026-08-01T00:00:00Z");
const FILENAME = "opak-export.xlsx";
const SHEET_NAME = "Default";

type Recorded = {
  created: { note: string | null }[];
  upserts: {
    remoteProductId: string;
    listingId: string | null;
    contentDigest: string;
    origin?: string;
    sourceImportId?: string;
  }[];
  audits: { action: string; entityId: string }[];
  notes: { listingId: string; note: string }[];
};

function importerWith(
  existing: Record<string, { listingId: string; contentDigest: string }> = {},
) {
  const recorded: Recorded = {
    created: [],
    upserts: [],
    audits: [],
    notes: [],
  };
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
            sourceImports: {
              async create(input: Record<string, unknown>) {
                return { id: "source_import_1", ...input };
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
              async upsertMany(inputs: Recorded["upserts"]) {
                recorded.upserts.push(...inputs);
                return inputs;
              },
            },
            listings: {
              async create(input: { note: string | null }) {
                recorded.created.push(input);
                nextDraft += 1;
                return { id: `draft_${nextDraft}` };
              },
              async updateNote(listingId: string, note: string) {
                recorded.notes.push({ listingId, note });
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
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
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
    expect(recorded.upserts.map((upsert) => upsert.origin)).toEqual([
      "import",
      "import",
    ]);
  });

  it("writes an audit event per created draft", async () => {
    const { importBulkForm, recorded } = importerWith();

    await importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
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
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
      sheet: sheetOf(rowFor()),
    });

    expect(result.createdDrafts).toBe(0);
    expect(result.refreshedProducts).toBe(1);
    expect(recorded.created).toEqual([]);
    expect(recorded.upserts[0]?.listingId).toBe("draft_existing");
    expect(recorded.upserts[0]?.origin).toBe("import");
  });

  it("does not count an unchanged re-import as a refresh", async () => {
    const first = importerWith();
    await first.importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
      sheet: sheetOf(rowFor()),
    });
    const digest = first.recorded.upserts[0]?.contentDigest ?? "";

    const second = importerWith({
      remote_1: { listingId: "draft_existing", contentDigest: digest },
    });
    const result = await second.importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
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
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
      sheet: sheetOf(rowFor({ quantity: "-1" })),
    });

    expect(result.createdDrafts).toBe(1);
    expect(result.issues.map((issue) => issue.code)).toContain(
      "quantity_negative",
    );
  });

  it("audits a refreshed snapshot, because rewriting a row is a mutation", async () => {
    const { importBulkForm, recorded } = importerWith({
      remote_1: { listingId: "draft_existing", contentDigest: "stale" },
    });

    await importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
      sheet: sheetOf(rowFor()),
    });

    expect(recorded.audits).toEqual([
      expect.objectContaining({
        action: "listing.import_refreshed",
        entityId: "draft_existing",
      }),
    ]);
  });

  it("writes no audit event when a re-import changes nothing", async () => {
    const first = importerWith();
    await first.importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
      sheet: sheetOf(rowFor()),
    });
    const digest = first.recorded.upserts[0]?.contentDigest ?? "";

    const second = importerWith({
      remote_1: { listingId: "draft_existing", contentDigest: digest },
    });
    await second.importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
      sheet: sheetOf(rowFor()),
    });

    expect(second.recorded.audits).toEqual([]);
  });

  it("writes a note the extract step can read, keeping provenance first", async () => {
    const { importBulkForm, recorded } = importerWith();

    await importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
      sheet: sheetOf(rowFor()),
    });

    const note = recorded.created[0]?.note ?? "";
    expect(note.split("\n")[0]).toMatch(
      /^Imported from a SHOPLINE bulk update form, row \d+$/,
    );
    // The spec version carries a four-digit year, and extraction reads the first
    // year-shaped token as the vintage. It must not appear in the note.
    expect(note).not.toContain("2026");
    expect(note).toContain("Product name: Demo Estate Riesling 2024");
    expect(note).toContain("Categories: White Wine > Germany > Mosel");
  });

  it("refreshes the note when a re-import changes the row", async () => {
    const { importBulkForm, recorded } = importerWith({
      remote_1: { listingId: "draft_existing", contentDigest: "stale" },
    });

    await importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
      sheet: sheetOf(rowFor({ nameEn: "Renamed Estate Riesling 2024" })),
    });

    expect(recorded.notes).toEqual([
      {
        listingId: "draft_existing",
        note: expect.stringContaining(
          "Product name: Renamed Estate Riesling 2024",
        ),
      },
    ]);
  });

  it("does not touch the note when a re-import changes nothing", async () => {
    const first = importerWith();
    await first.importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
      sheet: sheetOf(rowFor()),
    });
    const digest = first.recorded.upserts[0]?.contentDigest ?? "";

    const second = importerWith({
      remote_1: { listingId: "draft_existing", contentDigest: digest },
    });
    await second.importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
      sheet: sheetOf(rowFor()),
    });

    expect(second.recorded.notes).toEqual([]);
  });

  it("refuses a sheet larger than one transaction should carry", async () => {
    const { importBulkForm, recorded } = importerWith();
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_unused, index) =>
      rowFor({ productId: `remote_${index}`, sku: `sku_${index}` }),
    );

    await expect(
      importBulkForm({
        workspaceId: "ws_opak",
        actorId: "user_1",
        rawBytes: RAW_BYTES,
        merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
        filename: FILENAME,
        sheetName: SHEET_NAME,
        sheet: sheetOf(...rows),
      }),
    ).rejects.toThrow(/imports are limited to/);
    // The guard must run before the transaction opens, not partway through it.
    expect(recorded.created).toEqual([]);
    expect(recorded.upserts).toEqual([]);
  });

  it("accepts a sheet exactly at the limit", async () => {
    const { importBulkForm } = importerWith();
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_unused, index) =>
      rowFor({ productId: `remote_${index}`, sku: `sku_${index}` }),
    );

    const result = await importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
      sheet: sheetOf(...rows),
    });

    expect(result.createdDrafts).toBe(MAX_IMPORT_ROWS);
  });

  it("rejects a sheet with no readable rows", async () => {
    const { importBulkForm } = importerWith();

    await expect(
      importBulkForm({
        workspaceId: "ws_opak",
        actorId: "user_1",
        rawBytes: RAW_BYTES,
        merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
        filename: FILENAME,
        sheetName: SHEET_NAME,
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
        rawBytes: RAW_BYTES,
        merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
        filename: FILENAME,
        sheetName: SHEET_NAME,
        sheet: sheetOf(rowFor()),
      }),
    ).rejects.toThrow(/Connect a SHOPLINE store/);
  });

  it("creates a source_imports row and stamps its id on every upserted mirror", async () => {
    const { importBulkForm, recorded } = importerWith();

    await importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      rawBytes: new Uint8Array([1, 2, 3]),
      merchantAttestedExportAt: new Date("2026-08-01T00:00:00Z"),
      filename: "opak-export.xlsx",
      sheetName: "Default",
      sheet: sheetOf(rowFor(), rowFor({ productId: "remote_2", sku: "0002" })),
    });

    expect(recorded.upserts.every((u) => u.sourceImportId === "source_import_1")).toBe(
      true,
    );
  });
});
