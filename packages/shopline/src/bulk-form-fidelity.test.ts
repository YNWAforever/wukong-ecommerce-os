import { describe, expect, it } from "vitest";
import headers from "../fixtures/shopline-bulk-form-headers.json" with { type: "json" };
import { zipOf } from "../fixtures/synthetic-workbook.js";
import { createBulkFormUpdate, parseBulkForm } from "./bulk-form.js";
import { readBulkFormSheet, writeBulkFormWorkbook } from "./bulk-form-xlsx.js";

// Independent positions: do not derive expected policy from production column lists.
const allowed = [2, 3, 4, 5, 6, 7, 8, 9];
const locked = [0, 38, 47, 48, 49, 50, 66, 67, 69, 70];
const deltas = [39, 51];
const passThrough = [
  1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 36, 37, 40, 41, 42, 43, 44, 45, 46, 52, 53, 54,
  55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 68,
];
const values = {
  nameZh: "新版名稱",
  summaryEn: "New summary",
  summaryZh: "新摘要",
  seoTitleEn: "New SEO",
  seoTitleZh: "新標題",
  seoDescriptionEn: "New description",
  seoDescriptionZh: "新簡介",
  seoKeywords: "new,synthetic",
};
function sourceRow(): string[] {
  const row = Array.from({ length: 71 }, (_, i) => "synthetic-" + i);
  for (const i of [10, 11, 14, 16, 17, 22, 34, 35, 68]) row[i] = "N";
  for (let i = 26; i <= 33; i++) row[i] = "00100.00";
  row[0] = "00001A";
  row[37] = "000013";
  row[38] = "-3";
  row[36] = "4.20e1";
  row[40] = "00.7500";
  row[23] = "White Wine>Germany\r\nTop Picks";
  row[43] = " line 1\nline 2 & <tag> ";
  for (const i of [47, 48, 49, 50]) row[i] = "";
  row[39] = "+5";
  row[51] = "";
  row[64] = "";
  row[65] = "000000123";
  return row;
}
function ref(i: number): string {
  return i < 26
    ? String.fromCharCode(65 + i)
    : String.fromCharCode(64 + Math.floor(i / 26)) +
        String.fromCharCode(65 + (i % 26));
}
function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}
function sourceWorkbook(rows: string[][], typed = false): Uint8Array {
  const xml = rows
    .map(
      (row, r) =>
        '<row r="' +
        (r + 1) +
        '">' +
        row
          .map((value, i) => {
            const attrs = ' r="' + ref(i) + (r + 1) + '"';
            if (typed && r === 2 && i === 26)
              return "<c" + attrs + ' t="n" s="1"><v>' + value + "</v></c>";
            return (
              "<c" +
              attrs +
              ' t="inlineStr"><is><t xml:space="preserve">' +
              escape(value) +
              "</t></is></c>"
            );
          })
          .join("") +
        "</row>",
    )
    .join("");
  return zipOf([
    {
      name: "xl/workbook.xml",
      text: '<workbook><sheets><sheet name="Default" sheetId="1"/></sheets></workbook>',
    },
    {
      name: "xl/worksheets/sheet1.xml",
      text: "<worksheet><sheetData>" + xml + "</sheetData></worksheet>",
    },
  ]);
}
// Read the stored ZIP's local records independently; never call the production reader for output evidence.
function part(bytes: Uint8Array, name: string): string {
  const b = Buffer.from(bytes);
  let at = 0;
  while (b.readUInt32LE(at) === 0x04034b50) {
    const size = b.readUInt32LE(at + 18),
      n = b.readUInt16LE(at + 26),
      extra = b.readUInt16LE(at + 28);
    const start = at + 30 + n + extra;
    if (b.toString("utf8", at + 30, at + 30 + n) === name)
      return b.toString("utf8", start, start + size);
    at = start + size;
  }
  throw new Error("missing synthetic part " + name);
}
function outputCells(bytes: Uint8Array, rowNumber = 3): (string | null)[] {
  const xml = part(bytes, "xl/worksheets/sheet1.xml");
  const row = new RegExp('<row r="' + rowNumber + '">([\\s\\S]*?)</row>').exec(
    xml,
  )![1]!;
  return Array.from({ length: 71 }, (_, i) => {
    const cell = new RegExp(
      '<c r="' +
        ref(i) +
        rowNumber +
        '" t="inlineStr"><is><t xml:space="preserve">([\\s\\S]*?)</t></is></c>',
    ).exec(row);
    return cell
      ? cell[1]!
          .replaceAll("&#13;", "\r")
          .replaceAll("&#10;", "\n")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&")
      : null;
  });
}
function exportRow(row: string[], typed = false) {
  const input = sourceWorkbook([headers.en, headers.zh, row], typed);
  const parsed = parseBulkForm(readBulkFormSheet(input));
  expect(parsed.rows).toHaveLength(1);
  const update = createBulkFormUpdate(parsed.rows, [
    { productId: row[0]!, values },
  ]);
  return { input, parsed, output: writeBulkFormWorkbook(update.sheet) };
}
describe("independent synthetic workbook fidelity", () => {
  it("compares every position: eight allowed, ten locked, 51 pass-through, two neutral deltas", () => {
    expect([
      allowed.length,
      locked.length,
      passThrough.length,
      deltas.length,
    ]).toEqual([8, 10, 51, 2]);
    expect(
      [...allowed, ...locked, ...passThrough, ...deltas].sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 71 }, (_, i) => i));
    const row = sourceRow();
    const { output } = exportRow(row);
    const cells = outputCells(output);
    for (const i of [...locked, ...passThrough])
      expect(cells[i], headers.en[i]).toBe(row[i] || null);
    allowed.forEach((i, n) =>
      expect(cells[i], headers.en[i]).toBe(Object.values(values)[n]),
    );
    expect(cells[39]).toBe("+0");
    expect(cells[51]).toBeNull();
    expect(part(output, "xl/workbook.xml")).toContain(
      '<sheet name="Default" sheetId="1" r:id="rId1"/>',
    );
    expect(outputCells(output, 1)).toEqual(headers.en);
    expect(outputCells(output, 2)).toEqual(headers.zh);
  });
  it("separates typed/raw loss from exact stored lexical preservation", () => {
    const { input, output, parsed } = exportRow(sourceRow(), true);
    expect(part(input, "xl/worksheets/sheet1.xml")).toContain(
      '<c r="AA3" t="n" s="1"><v>00100.00</v></c>',
    );
    expect(part(output, "xl/worksheets/sheet1.xml")).toContain(
      '<c r="AA3" t="inlineStr">',
    );
    expect(part(output, "xl/worksheets/sheet1.xml")).not.toContain('s="1"');
    expect(output).not.toEqual(input);
    expect(parsed.rows[0]!.pricing.regular).toBe(100);
    expect(outputCells(output)[26]).toBe("00100.00");
    expect(outputCells(output)[36]).toBe("4.20e1");
  });
  it("records whitespace-only cell normalization separately", () => {
    const row = sourceRow();
    row[64] = "  ";
    const { input, output, parsed } = exportRow(row);
    expect(readBulkFormSheet(input)[2]![64]).toBe("  ");
    expect(parsed.rows[0]!.raw.mpn).toBeNull();
    expect(outputCells(output)[64]).toBeNull();
  });
  it.each(["000013", "00AB-01"])("preserves string identifiers %s", (sku) => {
    const row = sourceRow();
    row[37] = sku;
    expect(outputCells(exportRow(row).output)[37]).toBe(sku);
  });
  it.each(["", "   "])("refuses an empty product identity %j", (id) => {
    const row = sourceRow();
    row[0] = id;
    const parsed = parseBulkForm([headers.en, headers.zh, row]);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.issues.some((x) => x.code === "product_id_missing")).toBe(
      true,
    );
  });
  it.each(["無限數量", "-3"])("preserves stock literal %s", (quantity) => {
    const row = sourceRow();
    row[38] = quantity;
    expect(outputCells(exportRow(row).output)[38]).toBe(quantity);
  });
  it("refuses variant identity", () => {
    const row = sourceRow();
    row[47] = "variant-001";
    const parsed = parseBulkForm([headers.en, headers.zh, row]);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.issues.some((x) => x.code === "variant_row_blocked")).toBe(
      true,
    );
  });
  it("rejects an added nonempty header column instead of silently dropping it", () => {
    expect(
      parseBulkForm([
        [...headers.en, "Unexpected column"],
        headers.zh,
        sourceRow(),
      ]).rows,
    ).toHaveLength(0);
    expect(
      parseBulkForm([
        headers.en,
        [...headers.zh, "Unexpected column"],
        sourceRow(),
      ]).localeHeaderRow,
    ).toBeNull();
  });
  it("accepts trailing blank formatting cells without extending the contract", () => {
    expect(
      parseBulkForm([[...headers.en, "", "  "], headers.zh, sourceRow()]).rows,
    ).toHaveLength(1);
  });
  it.each(["", "+0", "+5", "-8"])(
    "handles both delta columns with source %j",
    (delta) => {
      const row = sourceRow();
      row[39] = delta;
      row[51] = delta;
      const cells = outputCells(exportRow(row).output);
      expect([cells[39], cells[51]]).toEqual(
        delta === "" ? [null, null] : ["+0", "+0"],
      );
    },
  );
  it("refuses an empty SKU instead of inventing an identifier", () => {
    const row = sourceRow();
    row[37] = "";
    const parsed = parseBulkForm([headers.en, headers.zh, row]);
    expect(parsed.issues.some((x) => x.code === "sku_missing")).toBe(true);
    expect(parsed.rows).toHaveLength(0);
  });
  it("rejects reordered or renamed English headers", () => {
    for (const header of [
      headers.en.toReversed(),
      headers.en.map((x, i) => (i === 37 ? "Changed SKU" : x)),
    ])
      expect(
        parseBulkForm([header, headers.zh, sourceRow()]).rows,
      ).toHaveLength(0);
  });
});
