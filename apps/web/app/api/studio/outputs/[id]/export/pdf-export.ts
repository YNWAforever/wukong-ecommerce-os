import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

import { parseCopyProposalPayload } from "../../../../../../lib/studio/copy-proposal";

/**
 * Server-side PDF rendering for Studio artifact exports (B2).
 *
 * `pdf-lib` was already a web dependency and `serverExternalPackages` already
 * lists it, so this module only runs in the route handler (never in a client
 * component). It renders a readable document from the same persisted payload
 * the JSON export carries; nothing is fetched and no additional data is read.
 *
 * The standard PDF fonts only encode WinAnsi, and the repository has no bundled
 * Unicode font and no new-dependency budget. Characters outside WinAnsi (for
 * example CJK proposed values) are therefore rendered as their code point
 * (`[U+4E2D]`) rather than silently dropped or corrupted; the runbook records
 * that limitation and points at the canonical JSON export when exact text
 * matters. Everything the document says is either a reviewed artifact field or
 * the packet's own digest.
 */

export type StudioExportPdfInput = {
  outputId: string;
  kind: string;
  title: string;
  status: string;
  revision: number;
  asOf: string;
  scope: unknown;
  payload: Record<string, unknown>;
  payloadSha256: string;
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LINE_HEIGHT = 14;
const FONT_SIZE = 10;
const SMALL_SIZE = 8;

function sanitizeForStandardFont(text: string): string {
  let output = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n" || character === "\r" || character === "\t") {
      output += " ";
    } else if (code >= 0x20 && code <= 0x7e) {
      output += character;
    } else if (code >= 0xa0 && code <= 0xff) {
      // WinAnsi maps most of Latin-1; pdf-lib accepts these directly.
      output += character;
    } else {
      output += `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]`;
    }
  }
  return output;
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  width: number,
): string[] {
  const clean = sanitizeForStandardFont(text).trim();
  if (clean.length === 0) return [""];
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length > 0) lines.push(current);
    current = "";
  };
  for (const word of words) {
    const candidate = current.length > 0 ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      current = candidate;
      continue;
    }
    flush();
    if (font.widthOfTextAtSize(word, size) <= width) {
      current = word;
      continue;
    }
    // A single token longer than the column: break it by characters so no
    // content silently disappears.
    let chunk = "";
    for (const character of word) {
      const next = chunk + character;
      if (font.widthOfTextAtSize(next, size) <= width) {
        chunk = next;
      } else {
        if (chunk.length > 0) lines.push(chunk);
        chunk = character;
      }
    }
    current = chunk;
  }
  flush();
  return lines.length > 0 ? lines : [""];
}

function flattenPayload(
  value: unknown,
  prefix: string,
  lines: string[],
  depth: number,
): void {
  if (lines.length >= 400) return;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    lines.push(`${prefix}: ${String(value)}`);
    return;
  }
  if (typeof value === "string") {
    lines.push(`${prefix}: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${prefix}: []`);
      return;
    }
    value.slice(0, 50).forEach((entry, index) => {
      flattenPayload(entry, `${prefix}[${index}]`, lines, depth + 1);
    });
    if (value.length > 50) lines.push(`${prefix}: … ${value.length - 50} more`);
    return;
  }
  if (typeof value === "object") {
    if (depth > 6) {
      lines.push(`${prefix}: [nested object]`);
      return;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      lines.push(`${prefix}: {}`);
      return;
    }
    for (const [key, entry] of entries) {
      flattenPayload(
        entry,
        prefix.length > 0 ? `${prefix}.${key}` : key,
        lines,
        depth + 1,
      );
      if (lines.length >= 400) return;
    }
    return;
  }
  lines.push(`${prefix}: [unavailable]`);
}

class PdfWriter {
  private page: ReturnType<PDFDocument["addPage"]>;
  private y = PAGE_HEIGHT - MARGIN;

  constructor(
    private readonly document: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  }

  private newPage(): void {
    this.page = this.document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  private ensure(height: number): void {
    if (this.y - height < MARGIN) this.newPage();
  }

  heading(text: string): void {
    const lines = wrapText(text, this.bold, 12, CONTENT_WIDTH);
    this.ensure(lines.length * LINE_HEIGHT + 10);
    for (const line of lines) {
      this.page.drawText(line, {
        x: MARGIN,
        y: this.y,
        size: 12,
        font: this.bold,
        color: rgb(0.1, 0.1, 0.1),
      });
      this.y -= LINE_HEIGHT;
    }
    this.y -= 6;
  }

  paragraph(text: string, size = FONT_SIZE, font = this.font): void {
    const lines = wrapText(text, font, size, CONTENT_WIDTH);
    this.ensure(lines.length * LINE_HEIGHT);
    for (const line of lines) {
      this.page.drawText(line, { x: MARGIN, y: this.y, size, font });
      this.y -= LINE_HEIGHT;
    }
  }

  table(
    headers: readonly string[],
    rows: ReadonlyArray<readonly string[]>,
    widths: readonly number[],
  ): void {
    const drawRow = (
      cells: readonly string[],
      font: PDFFont,
      size: number,
      headerRow: boolean,
    ) => {
      const wrapped = cells.map((cell, index) =>
        wrapText(cell, font, size, (widths[index] ?? 80) - 8),
      );
      const lineCount = Math.max(1, ...wrapped.map((cell) => cell.length));
      const rowHeight = lineCount * LINE_HEIGHT + 6;
      this.ensure(rowHeight);
      const rowTop = this.y;
      let x = MARGIN;
      wrapped.forEach((cell, index) => {
        const width = widths[index] ?? 80;
        cell.forEach((line, lineIndex) => {
          this.page.drawText(line, {
            x: x + 4,
            y: rowTop - 4 - lineIndex * LINE_HEIGHT,
            size,
            font,
          });
        });
        x += width;
      });
      this.page.drawLine({
        start: { x: MARGIN, y: rowTop - rowHeight + 3 },
        end: { x: MARGIN + CONTENT_WIDTH, y: rowTop - rowHeight + 3 },
        thickness: headerRow ? 0.8 : 0.3,
        color: rgb(0.75, 0.75, 0.75),
      });
      this.y = rowTop - rowHeight;
    };
    drawRow(headers, this.bold, FONT_SIZE, true);
    for (const row of rows) drawRow(row, this.font, FONT_SIZE, false);
    this.y -= 8;
  }

  finish(): Promise<Uint8Array> {
    const pages = this.document.getPages();
    pages.forEach((page, index) => {
      page.drawText(`Page ${index + 1} of ${pages.length}`, {
        x: PAGE_WIDTH - MARGIN - 70,
        y: MARGIN / 2,
        size: SMALL_SIZE,
        font: this.font,
        color: rgb(0.45, 0.45, 0.45),
      });
    });
    return this.document.save();
  }
}

/** Build the PDF bytes for one persisted, digest-checked artifact packet. */
export async function buildStudioOutputPdf(
  input: StudioExportPdfInput,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);

  document.setTitle(sanitizeForStandardFont(`Studio output: ${input.title}`));
  document.setSubject(
    sanitizeForStandardFont(
      `${input.kind} · ${input.status} · revision ${input.revision}`,
    ),
  );
  document.setKeywords([
    input.outputId,
    `revision ${input.revision}`,
    `payload sha256 ${input.payloadSha256}`,
  ]);
  document.setProducer("Wukong Studio");
  document.setCreator("Wukong E-commerce OS");

  const writer = new PdfWriter(document, font, bold);
  writer.heading(sanitizeForStandardFont(input.title));
  const copyProposal = parseCopyProposalPayload(input.payload);
  writer.paragraph(
    [
      `Kind: ${input.kind}`,
      `Status: ${input.status}`,
      `Revision: ${input.revision}`,
      `As of: ${input.asOf}`,
      `Output id: ${input.outputId}`,
      copyProposal ? `Listing id: ${copyProposal.listingId}` : null,
      `Payload SHA-256: ${input.payloadSha256}`,
      `Scope: ${JSON.stringify(input.scope ?? null)}`,
    ]
      .filter((line): line is string => line !== null)
      .join("  ·  "),
    SMALL_SIZE,
  );
  writer.paragraph("");

  if (copyProposal) {
    writer.heading("Proposed fields");
    writer.table(
      ["Field", "Current", "Proposed", "Evidence"],
      copyProposal.fields.map((field) => [
        field.field,
        field.current ?? "Not provided",
        field.proposed,
        field.evidenceRefs.length > 0
          ? field.evidenceRefs.join(", ")
          : "No evidence",
      ]),
      [95, 145, 165, 94],
    );
    if (copyProposal.limitations.length > 0) {
      writer.heading("Limitations");
      for (const limitation of copyProposal.limitations) {
        writer.paragraph(`- ${limitation}`);
      }
      writer.paragraph("");
    }
    writer.paragraph(
      "This proposal was generated by Studio. It is not applied to canonical listing data; a person must review and apply it in the review workspace.",
    );
  } else {
    writer.heading("Payload");
    const lines: string[] = [];
    flattenPayload(input.payload, "", lines, 0);
    for (const line of lines) writer.paragraph(line);
    writer.paragraph("");
    writer.paragraph(
      "This artifact is exported from Studio. It is not applied automatically.",
    );
  }

  return writer.finish();
}
