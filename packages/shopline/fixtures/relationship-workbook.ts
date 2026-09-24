import { writeBulkFormWorkbook } from "../src/bulk-form-xlsx.js";
import { zipOf } from "./synthetic-workbook.js";
type Part = { name: string; text: string };
function parts(sheet: readonly (readonly string[])[]): Part[] {
  const bytes = writeBulkFormWorkbook(sheet),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    decoder = new TextDecoder(),
    result: Part[] = [];
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    const size = view.getUint32(offset + 18, true),
      nameLength = view.getUint16(offset + 26, true),
      extraLength = view.getUint16(offset + 28, true);
    const start = offset + 30 + nameLength + extraLength;
    result.push({
      name: decoder.decode(
        bytes.subarray(offset + 30, offset + 30 + nameLength),
      ),
      text: decoder.decode(bytes.subarray(start, start + size)),
    });
    offset = start + size;
  }
  return result;
}
/** Valid synthetic workbook: first tab Default points at sheet2, Archive at sheet1. */
export function relationshipWorkbook(
  defaultSheet: readonly (readonly string[])[],
  archiveSheet = defaultSheet,
  mutate?: (parts: Part[]) => Part[],
): Uint8Array {
  const archive = parts(archiveSheet),
    current = parts(defaultSheet).find(
      (p) => p.name === "xl/worksheets/sheet1.xml",
    )!;
  const files = archive.map((p) =>
    p.name === "xl/workbook.xml"
      ? {
          ...p,
          text: p.text.replace(
            /<sheets>[\s\S]*?<\/sheets>/,
            '<sheets><sheet name="Default" sheetId="2" r:id="rId2"/><sheet name="Archive" sheetId="1" r:id="rId1"/></sheets>',
          ),
        }
      : p.name === "xl/_rels/workbook.xml.rels"
        ? {
            ...p,
            text: p.text.replace(
              "</Relationships>",
              '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
            ),
          }
        : p.name === "[Content_Types].xml"
          ? {
              ...p,
              text: p.text.replace(
                "</Types>",
                '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
              ),
            }
          : p,
  );
  files.push({ ...current, name: "xl/worksheets/sheet2.xml" });
  return zipOf(mutate ? mutate(files) : files);
}
