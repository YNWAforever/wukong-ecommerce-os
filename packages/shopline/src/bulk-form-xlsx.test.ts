import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { zipOf } from "../fixtures/synthetic-workbook.js";

import {
  BULK_FORM_COLUMNS,
  createBulkFormUpdate,
  parseBulkForm,
} from "./bulk-form.js";
import {
  BulkFormWorkbookError,
  readBulkFormSheet,
  readBulkFormSheetName,
  writeBulkFormWorkbook,
} from "./bulk-form-xlsx.js";

const MINIMAL_PARTS = [
  {
    name: "[Content_Types].xml",
    text: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  },
];

describe("bulk form xlsx adapter", () => {
  it("round-trips leading zeros, Traditional Chinese, and in-cell newlines", () => {
    const sheet = [
      ["Product ID (DO NOT EDIT)", "SKU", "Online Store Categories", "Name"],
      [
        "aaaaaaaaaaaaaaaaaaaaaa01",
        "0001",
        "Champagne>Rose\nParty Wines Selection",
        "示範酒莊",
      ],
    ];

    expect(readBulkFormSheet(writeBulkFormWorkbook(sheet))).toEqual(sheet);
  });

  it("never lets a numeric-looking SKU lose its leading zeros", () => {
    const read = readBulkFormSheet(
      writeBulkFormWorkbook([["0001", "007", "0.0", "+0"]]),
    );

    expect(read[0]).toEqual(["0001", "007", "0.0", "+0"]);
  });

  it("escapes markup and preserves it verbatim", () => {
    const sheet = [['Ampersand & <tag> "quoted"', "a>b>c"]];

    expect(readBulkFormSheet(writeBulkFormWorkbook(sheet))).toEqual(sheet);
  });

  it("returns null for cells the worksheet omits", () => {
    const read = readBulkFormSheet(writeBulkFormWorkbook([["a", "", "c"]]));

    expect(read[0]).toEqual(["a", null, "c"]);
  });

  it('names the generated worksheet "Default", matching a real SHOPLINE bulk-update export', () => {
    const bytes = writeBulkFormWorkbook([
      ["Product ID (DO NOT EDIT)"],
      ["001"],
    ]);
    const raw = Buffer.from(bytes).toString("latin1");
    const sheetName = raw.match(/<sheet name="([^"]*)"/)?.[1];

    expect(sheetName).toBe("Default");
  });

  it("reads back the worksheet name it wrote", () => {
    const bytes = writeBulkFormWorkbook([
      ["Product ID (DO NOT EDIT)"],
      ["001"],
    ]);

    expect(readBulkFormSheetName(bytes)).toBe("Default");
  });

  it("decodes XML entities in the declared worksheet name", () => {
    const bytes = zipOf([
      ...MINIMAL_PARTS,
      {
        name: "xl/workbook.xml",
        text: '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Q3 &amp; Q4" sheetId="1" r:id="rId1"/></sheets></workbook>',
      },
    ]);

    expect(readBulkFormSheetName(bytes)).toBe("Q3 & Q4");
  });

  it("rejects a workbook missing xl/workbook.xml", () => {
    expect(() => readBulkFormSheetName(zipOf(MINIMAL_PARTS))).toThrow(
      /no xl\/workbook\.xml/,
    );
  });

  it("rejects a workbook whose first sheet tag declares no name", () => {
    const bytes = zipOf([
      ...MINIMAL_PARTS,
      {
        name: "xl/workbook.xml",
        text: '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/></sheets></workbook>',
      },
    ]);

    expect(() => readBulkFormSheetName(bytes)).toThrow(
      /declares no worksheet name/,
    );
  });

  it("reads a workbook that stores its text in sharedStrings", () => {
    const bytes = zipOf([
      ...MINIMAL_PARTS,
      {
        name: "xl/sharedStrings.xml",
        text: '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>0001</t></si><si><t>示範酒莊</t></si></sst>',
      },
      {
        name: "xl/worksheets/sheet1.xml",
        text: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>620</v></c></row></sheetData></worksheet>',
      },
    ]);

    expect(readBulkFormSheet(bytes)).toEqual([["0001", "示範酒莊", "620"]]);
  });

  it("concatenates rich-text runs within one cell", () => {
    const bytes = zipOf([
      ...MINIMAL_PARTS,
      {
        name: "xl/worksheets/sheet1.xml",
        text: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t>Demo </t></r><r><t>Estate</t></r></is></c></row></sheetData></worksheet>',
      },
    ]);

    expect(readBulkFormSheet(bytes)).toEqual([["Demo Estate"]]);
  });

  it("keeps row numbering positional when the worksheet skips rows", () => {
    const bytes = zipOf([
      ...MINIMAL_PARTS,
      {
        name: "xl/worksheets/sheet1.xml",
        text: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>third</t></is></c></row></sheetData></worksheet>',
      },
    ]);

    expect(readBulkFormSheet(bytes)).toEqual([["first"], [], ["third"]]);
  });

  // Every number below is attacker-controlled in the uploaded file. Without
  // these bounds each case allocates until the process dies, from a payload
  // smaller than this comment.
  it("rejects a row reference beyond the worksheet row limit", () => {
    const bytes = zipOf([
      ...MINIMAL_PARTS,
      {
        name: "xl/worksheets/sheet1.xml",
        text: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="200000000"><c r="A200000000" t="inlineStr"><is><t>boom</t></is></c></row></sheetData></worksheet>',
      },
    ]);

    expect(bytes.byteLength).toBeLessThan(1024);
    expect(() => readBulkFormSheet(bytes)).toThrow(/exceeds the maximum row/);
  });

  it("rejects a cell reference beyond the worksheet column limit", () => {
    const bytes = zipOf([
      ...MINIMAL_PARTS,
      {
        name: "xl/worksheets/sheet1.xml",
        text: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="AAAAAA1" t="inlineStr"><is><t>boom</t></is></c></row></sheetData></worksheet>',
      },
    ]);

    expect(() => readBulkFormSheet(bytes)).toThrow(
      /exceeds the maximum column/,
    );
  });

  it("accepts the last row and column a spreadsheet can actually produce", () => {
    const bytes = zipOf([
      ...MINIMAL_PARTS,
      {
        name: "xl/worksheets/sheet1.xml",
        text: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="XFD1" t="inlineStr"><is><t>edge</t></is></c></row></sheetData></worksheet>',
      },
    ]);

    // XFD is Excel's 16,384th column; the ceiling must not reject real files.
    expect(readBulkFormSheet(bytes)[0]?.[16_383]).toBe("edge");
  });

  it("rejects a zip entry that inflates beyond the supported size", () => {
    const bomb = deflateRawSync(Buffer.alloc(80 * 1024 * 1024, 0x61));

    const bytes = zipOf([
      ...MINIMAL_PARTS,
      { name: "xl/worksheets/sheet1.xml", raw: new Uint8Array(bomb) },
    ]);

    expect(bytes.byteLength).toBeLessThan(200 * 1024);
    expect(() => readBulkFormSheet(bytes)).toThrow(/inflates beyond/);
  });

  it("rejects an archive whose total decompressed size exceeds the combined bound, even though every individual entry stays under the per-entry cap", () => {
    const first = deflateRawSync(Buffer.alloc(50 * 1024 * 1024, 0x61));
    const second = deflateRawSync(Buffer.alloc(50 * 1024 * 1024, 0x62));

    const bytes = zipOf([
      ...MINIMAL_PARTS,
      { name: "xl/worksheets/sheet1.xml", raw: new Uint8Array(first) },
      { name: "xl/worksheets/sheet2.xml", raw: new Uint8Array(second) },
    ]);

    expect(bytes.byteLength).toBeLessThan(400 * 1024);
    expect(() => readBulkFormSheet(bytes)).toThrow(/total decompressed size/);
  });

  it("rejects a file that is not a workbook", () => {
    expect(() =>
      readBulkFormSheet(new TextEncoder().encode("not a zip")),
    ).toThrow(BulkFormWorkbookError);
    expect(() => readBulkFormSheet(zipOf(MINIMAL_PARTS))).toThrow(
      /no worksheet/,
    );
  });

  it("carries a full bulk form through xlsx and back into the parser", () => {
    const headerEn = BULK_FORM_COLUMNS.map((column) => column.en);
    const headerZh = BULK_FORM_COLUMNS.map((column) => column.zh);
    const row = BULK_FORM_COLUMNS.map((column) => {
      if (column.key === "productId") return "aaaaaaaaaaaaaaaaaaaaaa01";
      if (column.key === "sku") return "0001";
      if (column.key === "nameEn") return "Demo Estate Riesling 2024";
      if (column.key === "nameZh") return "Demo Estate Riesling 2024";
      if (column.key === "onlineStoreCategories")
        return "White Wine>Germany>Mosel\nTop Picks";
      if (column.key === "regularPrice") return "100.0";
      if (column.key === "salePrice") return "80.0";
      if (column.key === "quantity") return "6";
      if (column.key === "updateQuantity") return "+0";
      return "";
    });

    const parsed = parseBulkForm(
      readBulkFormSheet(writeBulkFormWorkbook([headerEn, headerZh, row])),
    );
    expect(parsed.rows).toHaveLength(1);

    const update = createBulkFormUpdate(parsed.rows, [
      {
        productId: "aaaaaaaaaaaaaaaaaaaaaa01",
        values: { nameZh: "示範酒莊麗絲玲 2024" },
      },
    ]);
    const reparsed = parseBulkForm(
      readBulkFormSheet(writeBulkFormWorkbook(update.sheet)),
    );

    expect(reparsed.rows[0]?.sku).toBe("0001");
    expect(reparsed.rows[0]?.content.name["zh-Hant"]).toBe(
      "示範酒莊麗絲玲 2024",
    );
    expect(reparsed.rows[0]?.categories).toEqual([
      ["White Wine", "Germany", "Mosel"],
      ["Top Picks"],
    ]);
    expect(reparsed.rows[0]?.facts.priceHkd).toBe(80);
  });
});
