import { crc32, deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  BULK_FORM_COLUMNS,
  createBulkFormUpdate,
  parseBulkForm,
} from "./bulk-form.js";
import {
  BulkFormWorkbookError,
  readBulkFormSheet,
  writeBulkFormWorkbook,
} from "./bulk-form-xlsx.js";

/**
 * Builds a stored-entry xlsx independently of `writeBulkFormWorkbook`, so the
 * reader is exercised against a package it did not produce — in particular the
 * shared-string layout Excel writes when an operator opens and re-saves a form.
 */
function zipOf(
  files: readonly { name: string; text?: string; raw?: Uint8Array }[],
): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    // `raw` carries an already-deflated payload, so the entry is written with
    // method 8 and the reader has to inflate it.
    const deflated = file.raw !== undefined;
    const uncompressed = encoder.encode(file.text ?? "");
    const data = file.raw ?? uncompressed;
    const crc = crc32(uncompressed);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, deflated ? 8 : 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, uncompressed.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, deflated ? 8 : 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, uncompressed.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce(
    (total, entry) => total + entry.length,
    0,
  );
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const output = new Uint8Array(offset + centralSize + eocd.length);
  let cursor = 0;
  for (const chunk of [...locals, ...centrals, eocd]) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}

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
