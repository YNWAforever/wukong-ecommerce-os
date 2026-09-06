import { describe, expect, it, vi } from "vitest";
import { BULK_FORM_COLUMNS } from "@wukong/shopline";
import { writeBulkFormWorkbook } from "@wukong/shopline/bulk-form-xlsx";
import { createWorkbookParser, workbookPreview } from "./workbook-import";

const sheet = (count = 1) => [
  BULK_FORM_COLUMNS.map((c) => c.en),
  BULK_FORM_COLUMNS.map((c) => c.zh),
  ...Array.from({ length: count }, (_, i) =>
    BULK_FORM_COLUMNS.map(
      (c) =>
        (
          ({
            productId: `00${i}`,
            sku: `SKU${i}`,
            nameEn: "Synthetic wine",
            regularPrice: "100",
          }) as Record<string, string>
        )[c.key] ?? "",
    ),
  ),
];
const request = (body: Uint8Array, filename = "synthetic.xlsx") =>
  new Request("https://app.test/?filename=" + encodeURIComponent(filename), {
    method: "POST",
    body: new Uint8Array(body),
  });
describe("workbook parser", () => {
  it("reads real synthetic XLSX without credentials and returns a bounded public projection", async () => {
    const parsed = await createWorkbookParser()(
      request(writeBulkFormWorkbook(sheet(21))),
    );
    expect(parsed.prepared.products).toHaveLength(21);
    const preview = workbookPreview(parsed);
    expect(preview.products).toHaveLength(20);
    expect(preview.eligibleProducts).toBe(21);
    expect(preview.products[0]).not.toHaveProperty("raw");
    expect(preview).not.toHaveProperty("sheet");
    expect(preview.inferredExportTime).toBeNull();
  });
  it.each([
    ["", "empty_upload"],
    ["bad", "upload_not_a_workbook"],
  ])("rejects invalid bytes %s", async (body, code) => {
    await expect(
      createWorkbookParser()(request(new TextEncoder().encode(body))),
    ).rejects.toMatchObject({ code });
  });
  it.each(["bad.csv", "a".repeat(256) + ".xlsx"])(
    "rejects invalid filename",
    async (filename) => {
      const readSheet = vi.fn();
      await expect(
        createWorkbookParser({ readSheet, readSheetName: () => "Default" })(
          request(new Uint8Array([1]), filename),
        ),
      ).rejects.toMatchObject({ code: "invalid_filename" });
      expect(readSheet).not.toHaveBeenCalled();
    },
  );
  it("caps streamed bytes without content length before parsing", async () => {
    const readSheet = vi.fn();
    await expect(
      createWorkbookParser({ readSheet, readSheetName: () => "Default" })(
        request(new Uint8Array(4 * 1024 * 1024 + 1)),
      ),
    ).rejects.toMatchObject({ status: 413, code: "upload_too_large" });
    expect(readSheet).not.toHaveBeenCalled();
  });
  it("rejects sheets over 5000 rows and malformed or empty sheets", async () => {
    for (const [rows, code] of [
      [sheet(5001), "workbook_too_many_rows"],
      [[], "workbook_empty"],
      [[["unknown"]], "workbook_unrecognized"],
    ] as const) {
      await expect(
        createWorkbookParser({
          readSheet: () => rows,
          readSheetName: () => "Default",
        })(request(new Uint8Array([1]))),
      ).rejects.toMatchObject({ code });
    }
  });
  it("keeps zero-eligible preview visible and bounds issues", async () => {
    const rows = sheet(101);
    for (const row of rows.slice(2)) row[0] = "";
    const parsed = await createWorkbookParser({
      readSheet: () => rows,
      readSheetName: () => "Default",
    })(request(new Uint8Array([1])));
    expect(workbookPreview(parsed)).toMatchObject({
      eligibleProducts: 0,
      excludedRows: 101,
    });
    expect(workbookPreview(parsed).issues.length).toBeLessThanOrEqual(100);
    expect(workbookPreview(parsed).totalIssues).toBeGreaterThanOrEqual(101);
  });
});
it("returns an actionable error for oversized normalized source or product evidence", async () => {
  for (const count of [1, 20]) {
    const rows = sheet(count);
    const titleColumn = BULK_FORM_COLUMNS.findIndex((c) => c.key === "nameEn");
    for (const row of rows.slice(2))
      row[titleColumn] = "x".repeat(count === 1 ? 1024 * 1024 : 900 * 1024);
    await expect(
      createWorkbookParser({
        readSheet: () => rows,
        readSheetName: () => "Default",
      })(request(new Uint8Array([1]))),
    ).rejects.toMatchObject({
      status: 413,
      code: "workbook_evidence_too_large",
    });
  }
});

it("maps PostgreSQL JSONB size constraints to an actionable error", async () => {
  const { createWorkbookSaver } = await import("./workbook-import");
  const { prepareWorkbookBase } = await import("@wukong/shopline");
  for (const constraint_name of [
    "workbook_imports_normalized_sheet_check",
    "workbook_imports_check",
    "workbook_products_check",
  ]) {
    const save = createWorkbookSaver({
      getDatabase: () =>
        ({
          forWorkspace: async () => {
            throw Object.assign(new Error("database detail"), {
              cause: { code: "23514", constraint_name },
            });
          },
        }) as never,
    });
    await expect(
      save({
        workspaceId: "trusted",
        actorId: "op",
        filename: "synthetic.xlsx",
        sheetName: "Default",
        workbookSha256: "0".repeat(64),
        headerContractSha256: "0".repeat(64),
        prepared: prepareWorkbookBase(sheet(), "synthetic.xlsx"),
      }),
    ).rejects.toMatchObject({
      status: 413,
      code: "workbook_evidence_too_large",
    });
  }
});
