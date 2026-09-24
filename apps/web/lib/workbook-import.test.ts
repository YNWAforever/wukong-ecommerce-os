import { createWorkbookPreviewHandler } from "../app/api/workbook-imports/preview/route";
import { createWorkbookSaveHandler } from "../app/api/workbook-imports/route";
import { zipOf } from "../../../packages/shopline/fixtures/synthetic-workbook";
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
        createWorkbookParser({ readSheet })(
          request(new Uint8Array([1]), filename),
        ),
      ).rejects.toMatchObject({ code: "invalid_filename" });
      expect(readSheet).not.toHaveBeenCalled();
    },
  );
  it("caps streamed bytes without content length before parsing", async () => {
    const readSheet = vi.fn();
    await expect(
      createWorkbookParser({ readSheet })(
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
        })(request(new Uint8Array([1]))),
      ).rejects.toMatchObject({ code });
    }
  });
  it("keeps zero-eligible preview visible and bounds issues", async () => {
    const rows = sheet(101);
    for (const row of rows.slice(2)) row[0] = "";
    const parsed = await createWorkbookParser({
      readSheet: () => rows,
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

function reorderedWorkbook(
  names: readonly [string, string] = ["Default", "Archive"],
  paired = false,
) {
  const originalSheet = sheet();
  originalSheet[2]![0] = "ARCHIVE-PRODUCT";
  const bytes = writeBulkFormWorkbook(originalSheet);
  const parts: { name: string; text: string }[] = [];
  const decoder = new TextDecoder(),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true),
      nameLength = view.getUint16(offset + 26, true),
      extraLength = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + nameLength + extraLength;
    parts.push({
      name: decoder.decode(bytes.slice(offset + 30, offset + 30 + nameLength)),
      text: decoder.decode(bytes.slice(dataStart, dataStart + size)),
    });
    offset = dataStart + size;
  }
  const workbook = parts.find((p) => p.name === "xl/workbook.xml")!;
  workbook.text = workbook.text.replace(
    /<sheets>[\s\S]*?<\/sheets>/,
    `<sheets><sheet name="${names[0]}" sheetId="2" r:id="rId2"/><sheet name="${names[1]}" sheetId="1" r:id="rId1"/></sheets>`,
  );
  if (paired)
    workbook.text = workbook.text.replace(
      /<sheet\b([^>]*)\/>/g,
      "<sheet$1></sheet>",
    );
  const relationships = parts.find(
    (p) => p.name === "xl/_rels/workbook.xml.rels",
  )!;
  relationships.text = relationships.text.replace(
    "</Relationships>",
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
  );
  const types = parts.find((p) => p.name === "[Content_Types].xml")!;
  types.text = types.text.replace(
    "</Types>",
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  parts.push({
    name: "xl/worksheets/sheet2.xml",
    text: parts
      .find((p) => p.name === "xl/worksheets/sheet1.xml")!
      .text.replaceAll("ARCHIVE-PRODUCT", "CURRENT-PRODUCT"),
  });
  return zipOf(parts);
}
it("binds Default rows and retained source name through the workbook relationship", async () => {
  const bytes = reorderedWorkbook();
  const parsed = await createWorkbookParser()(request(bytes));
  expect(parsed.sheetName).toBe("Default");
  expect(parsed.prepared.products[0]!.productId).toBe("CURRENT-PRODUCT");
  expect(parsed.prepared.sheet[2]![0]).toBe("CURRENT-PRODUCT");
  expect(workbookPreview(parsed).products[0]!.productId).toBe(
    "CURRENT-PRODUCT",
  );
});
it.each([
  ["Current", "Archive"],
  ["Default", "Default"],
] as const)(
  "safely rejects ambiguous or missing Default declarations %s/%s",
  async (first, second) => {
    const bytes = reorderedWorkbook([first, second]);
    await expect(createWorkbookParser()(request(bytes))).rejects.toMatchObject({
      status: 400,
      code: "upload_not_a_workbook",
    });
    const sessionContext = {
      resolve: async () => ({
        workspaceId: "trusted",
        actorId: "op",
        role: "operator" as const,
      }),
    };
    const saveWorkbook = vi.fn();
    for (const handler of [
      createWorkbookPreviewHandler({
        sessionContext,
        parseWorkbook: createWorkbookParser(),
      }),
      createWorkbookSaveHandler({
        sessionContext,
        parseWorkbook: createWorkbookParser(),
        saveWorkbook,
      }),
    ]) {
      const response = await handler(request(bytes));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        code: "upload_not_a_workbook",
        message:
          "Choose a readable SHOPLINE XLSX workbook with its Default sheet.",
      });
    }
    expect(saveWorkbook).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "saves relationship-selected Default rows with matching source name (paired tags: %s)",
  async (paired) => {
    const bytes = reorderedWorkbook(undefined, paired),
      parsed = await createWorkbookParser()(request(bytes));
    const saveWorkbook = vi.fn(async () => ({
      importId: "saved",
      importedProducts: 1,
      alreadyImportedProducts: 0,
      excludedRows: 0,
    }));
    const handler = createWorkbookSaveHandler({
      sessionContext: {
        resolve: async () => ({
          workspaceId: "trusted",
          actorId: "op",
          role: "operator",
        }),
      },
      parseWorkbook: createWorkbookParser(),
      saveWorkbook,
    });
    const saveRequest = request(bytes);
    saveRequest.headers.set("x-workbook-sha256", parsed.workbookSha256);
    saveRequest.headers.set(
      "x-workbook-header-sha256",
      parsed.headerContractSha256,
    );
    expect((await handler(saveRequest)).status).toBe(201);
    expect(saveWorkbook).toHaveBeenCalledWith(
      expect.objectContaining({
        sheetName: "Default",
        prepared: expect.objectContaining({
          products: [expect.objectContaining({ productId: "CURRENT-PRODUCT" })],
        }),
      }),
    );
  },
);
