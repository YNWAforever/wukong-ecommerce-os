import { inflateRawSync } from "node:zlib";

import type { BulkFormCell, BulkFormSheet } from "./bulk-form.js";

/**
 * Node-only xlsx boundary for the SHOPLINE bulk update form. `bulk-form.ts`
 * stays pure and dependency-free by working on a cell matrix; this adapter is
 * the only place that knows about ZIP containers and worksheet XML.
 *
 * Every cell is read as text and written as an inline string. That is the
 * mechanical guarantee that a SKU like `0013` survives a round-trip: no cell is
 * ever typed as a number, so no engine can renumber it to `13`.
 */

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_EOCD = 0x06054b50;

/**
 * Bounds on untrusted input. This is the only place the product parses a binary
 * upload, and every one of these numbers is attacker-controlled in the file:
 * a worksheet declares its own row and column references, and a zip entry
 * declares nothing about how large it inflates to.
 *
 * The row and column ceilings are Excel's own limits, so no workbook a
 * spreadsheet could have produced is rejected. The inflate ceiling is generous
 * for a worksheet but finite: without it a 272KB upload inflates to 112MB at a
 * realistic compression ratio, and a 4MB one to well over a gigabyte.
 */
const MAX_WORKSHEET_ROWS = 1_048_576;
const MAX_WORKSHEET_COLUMNS = 16_384;
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

export class BulkFormWorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkFormWorkbookError";
  }
}

function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) === ZIP_EOCD) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new BulkFormWorkbookError("file is not a zip container");

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map<string, Uint8Array>();

  for (let n = 0; n < entryCount; n += 1) {
    if (view.getUint32(offset, true) !== ZIP_CENTRAL_HEADER) {
      throw new BulkFormWorkbookError("malformed zip central directory");
    }
    const method = view.getUint16(offset + 10, true);
    // The central directory is authoritative: entries written with a data
    // descriptor carry zeroed sizes in their local header.
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );

    if (view.getUint32(localOffset, true) !== ZIP_LOCAL_HEADER) {
      throw new BulkFormWorkbookError(`malformed local header for ${name}`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressedSize);

    if (method === 0) entries.set(name, raw);
    else if (method === 8) {
      let inflated;
      try {
        inflated = inflateRawSync(raw, { maxOutputLength: MAX_INFLATED_BYTES });
      } catch {
        // zlib throws ERR_BUFFER_TOO_LARGE past maxOutputLength; report it as a
        // rejected workbook rather than leaking a runtime error to the caller.
        throw new BulkFormWorkbookError(
          `zip entry ${name} inflates beyond the supported size`,
        );
      }
      entries.set(name, new Uint8Array(inflated));
    } else
      throw new BulkFormWorkbookError(
        `unsupported zip compression method ${method} for ${name}`,
      );

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

const XML_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

function decodeXmlText(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g,
    (whole, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      }
      if (body.startsWith("#"))
        return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
      return XML_ENTITIES.get(body) ?? whole;
    },
  );
}

/** Concatenates every `<t>` run, which is how a styled cell keeps one value. */
function textRuns(xml: string): string {
  let text = "";
  for (const match of xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) {
    text += decodeXmlText(match[1] ?? "");
  }
  return text;
}

function columnIndexFromRef(ref: string): number {
  let index = 0;
  for (const character of ref) {
    const code = character.charCodeAt(0);
    if (code >= 65 && code <= 90) index = index * 26 + (code - 64);
    else if (code >= 97 && code <= 122) index = index * 26 + (code - 96);
    else break;
    // Bail early rather than at the end: `AAAAAA` would otherwise overflow past
    // any ceiling before we could check it.
    if (index > MAX_WORKSHEET_COLUMNS) {
      throw new BulkFormWorkbookError(
        `cell reference ${ref} exceeds the maximum column count`,
      );
    }
  }
  return index - 1;
}

function columnRef(index: number): string {
  let ref = "";
  let remaining = index + 1;
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    ref = String.fromCharCode(65 + remainder) + ref;
    remaining = Math.floor((remaining - remainder) / 26);
  }
  return ref;
}

function readSharedStrings(entries: Map<string, Uint8Array>): string[] {
  const part = entries.get("xl/sharedStrings.xml");
  if (part === undefined) return [];
  const xml = new TextDecoder().decode(part);
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    strings.push(textRuns(match[1] ?? ""));
  }
  return strings;
}

function firstWorksheetName(entries: Map<string, Uint8Array>): string {
  const sheets = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((left, right) => {
      const leftNumber = Number(/(\d+)\.xml$/.exec(left)?.[1] ?? 0);
      const rightNumber = Number(/(\d+)\.xml$/.exec(right)?.[1] ?? 0);
      return leftNumber - rightNumber;
    });
  const first = sheets[0];
  if (first === undefined)
    throw new BulkFormWorkbookError("workbook contains no worksheet");
  return first;
}

/**
 * Reads the first worksheet of an xlsx workbook into a cell matrix. Missing
 * cells become null; every present cell becomes a string, including numeric and
 * boolean cells, which are surfaced as their stored literal.
 */
export function readBulkFormSheet(bytes: Uint8Array): BulkFormSheet {
  const entries = readZipEntries(bytes);
  const shared = readSharedStrings(entries);
  const worksheet = entries.get(firstWorksheetName(entries));
  if (worksheet === undefined)
    throw new BulkFormWorkbookError("workbook contains no worksheet");
  const xml = new TextDecoder().decode(worksheet);

  const rows: BulkFormCell[][] = [];

  for (const rowMatch of xml.matchAll(/<row(\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(
      /\br="(\d+)"/.exec(rowMatch[1] ?? "")?.[1] ?? rows.length + 1,
    );
    const body = rowMatch[2] ?? "";
    const cells = new Map<number, string | null>();

    for (const cellMatch of body.matchAll(
      /<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const attributes = cellMatch[1] ?? "";
      const content = cellMatch[2];
      const ref = /\br="([A-Za-z]+)\d+"/.exec(attributes)?.[1];
      if (ref === undefined) continue;
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? "n";

      let value: string | null = null;
      if (content !== undefined && content.length > 0) {
        if (type === "s") {
          const index = Number(/<v>([\s\S]*?)<\/v>/.exec(content)?.[1] ?? "");
          value = shared[index] ?? null;
        } else if (type === "inlineStr") {
          value = textRuns(content);
        } else {
          const literal = /<v>([\s\S]*?)<\/v>/.exec(content)?.[1];
          value = literal === undefined ? null : decodeXmlText(literal);
        }
      }
      cells.set(columnIndexFromRef(ref), value);
    }

    // Worksheets omit empty rows entirely; keep the sheet positional so a
    // 1-based row number in an issue points at the operator's spreadsheet.
    // The row number is attacker-controlled, so bound it before allocating:
    // a single `<row r="200000000">` would otherwise exhaust the heap.
    if (!Number.isSafeInteger(rowNumber) || rowNumber > MAX_WORKSHEET_ROWS) {
      throw new BulkFormWorkbookError(
        `row reference ${rowNumber} exceeds the maximum row count`,
      );
    }
    while (rows.length < rowNumber - 1) rows.push([]);

    const width = cells.size === 0 ? 0 : Math.max(...cells.keys()) + 1;
    rows.push(
      Array.from(
        { length: width },
        (_unused, index) => cells.get(index) ?? null,
      ),
    );
  }

  return rows;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[n] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Escapes XML text. Carriage returns and newlines become numeric character
 * references so a multi-path category cell survives XML end-of-line
 * normalization on the way back in.
 */
function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

function worksheetXml(sheet: readonly (readonly string[])[]): string {
  const rows = sheet.map((row, rowIndex) => {
    const cells = row
      .map((value, columnIndex) => {
        if (value.length === 0) return "";
        const ref = `${columnRef(columnIndex)}${rowIndex + 1}`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(value)}</t></is></c>`;
      })
      .join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';

const WORKBOOK_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';

const WORKBOOK_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';

type ZipPart = { name: string; data: Uint8Array };

function buildZip(parts: readonly ZipPart[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const part of parts) {
    const nameBytes = encoder.encode(part.name);
    const crc = crc32(part.data);

    const local = new Uint8Array(30 + nameBytes.length + part.data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, ZIP_LOCAL_HEADER, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 names
    localView.setUint16(8, 0, true); // stored
    // Fixed modification time keeps the output byte-deterministic.
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0x0021, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, part.data.length, true);
    localView.setUint32(22, part.data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(part.data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, ZIP_CENTRAL_HEADER, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0x0021, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, part.data.length, true);
    centralView.setUint32(24, part.data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
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
  eocdView.setUint32(0, ZIP_EOCD, true);
  eocdView.setUint16(8, parts.length, true);
  eocdView.setUint16(10, parts.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...locals, ...centrals, eocd]) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}

/**
 * Writes a cell matrix as a minimal xlsx workbook. Entries are stored
 * uncompressed, so writing needs no deflate and the output is byte-deterministic
 * for a given matrix.
 */
export function writeBulkFormWorkbook(
  sheet: readonly (readonly string[])[],
): Uint8Array {
  const encoder = new TextEncoder();
  return buildZip([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES_XML) },
    { name: "_rels/.rels", data: encoder.encode(ROOT_RELS_XML) },
    { name: "xl/workbook.xml", data: encoder.encode(WORKBOOK_XML) },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: encoder.encode(WORKBOOK_RELS_XML),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: encoder.encode(worksheetXml(sheet)),
    },
  ]);
}
