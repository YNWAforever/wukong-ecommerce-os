import { it, expect } from "vitest";
import { relationshipWorkbook } from "../fixtures/relationship-workbook.js";
import {
  readDefaultBulkFormSheet,
  readBulkFormSheet,
  writeBulkFormWorkbook,
} from "./bulk-form-xlsx.js";
it("reads Default through its relationship and keeps legacy reader selection unchanged", () => {
  const bytes = relationshipWorkbook([["changed"]], [["original"]]);
  expect(readDefaultBulkFormSheet(bytes)).toEqual([["changed"]]);
  expect(readBulkFormSheet(bytes)).toEqual([["original"]]);
});
it("accepts the existing single-sheet writer output", () =>
  expect(
    readDefaultBulkFormSheet(writeBulkFormWorkbook([["001", "繁體"]])),
  ).toEqual([["001", "繁體"]]));
it.each([
  "../sheet2.xml",
  "https://example.invalid/sheet2.xml",
  "worksheets/%2e%2e/sheet2.xml",
  "worksheets\\sheet2.xml",
  "worksheets/missing.xml",
])("rejects unsafe or absent selected target %s", (target) => {
  const bytes = relationshipWorkbook([["changed"]], [["original"]], (parts) =>
    parts.map((p) =>
      p.name === "xl/_rels/workbook.xml.rels"
        ? {
            ...p,
            text: p.text.replace(
              'Target="worksheets/sheet2.xml"',
              'Target="' + target + '"',
            ),
          }
        : p,
    ),
  );
  expect(() => readDefaultBulkFormSheet(bytes)).toThrow();
});
it.each([
  "missing-rels",
  "duplicate-rel",
  "external-rel",
  "wrong-type",
  "duplicate-default",
  "duplicate-zip",
  "missing-package",
  "shared-strings",
])("fails closed for %s", (mode) => {
  const bytes = relationshipWorkbook([["changed"]], [["original"]], (parts) => {
    if (mode === "missing-rels")
      return parts.filter((p) => p.name !== "xl/_rels/workbook.xml.rels");
    if (mode === "missing-package")
      return parts.filter((p) => p.name !== "_rels/.rels");
    if (mode === "duplicate-zip")
      return [
        ...parts,
        parts.find((p) => p.name === "xl/worksheets/sheet2.xml")!,
      ];
    if (mode === "shared-strings")
      return [...parts, { name: "xl/sharedStrings.xml", text: "<sst/>" }];
    return parts.map((p) =>
      mode === "duplicate-default" && p.name === "xl/workbook.xml"
        ? { ...p, text: p.text.replace('name="Archive"', 'name="Default"') }
        : p.name === "xl/_rels/workbook.xml.rels"
          ? {
              ...p,
              text:
                mode === "duplicate-rel"
                  ? p.text.replace('Id="rId1"', 'Id="rId2"')
                  : mode === "external-rel"
                    ? p.text.replace(
                        'Id="rId2"',
                        'Id="rId2" TargetMode="External"',
                      )
                    : p.text.replace(
                        'Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"',
                        'Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet"',
                      ),
            }
          : p,
    );
  });
  expect(() => readDefaultBulkFormSheet(bytes)).toThrow();
});
it("accepts a canonical absolute internal worksheet target", () => {
  const bytes = relationshipWorkbook([["changed"]], [["original"]], (parts) =>
    parts.map((p) =>
      p.name === "xl/_rels/workbook.xml.rels"
        ? {
            ...p,
            text: p.text.replace(
              'Target="worksheets/sheet2.xml"',
              'Target="/xl/worksheets/sheet2.xml"',
            ),
          }
        : p,
    ),
  );
  expect(readDefaultBulkFormSheet(bytes)).toEqual([["changed"]]);
});

it("reads canonical relationship-bound shared strings for the selected worksheet", () => {
  const bytes = relationshipWorkbook([["unused"]], [["archive"]], (parts) => [
    ...parts.map((p) =>
      p.name === "xl/worksheets/sheet2.xml"
        ? {
            ...p,
            text: '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
          }
        : p.name === "xl/_rels/workbook.xml.rels"
          ? {
              ...p,
              text: p.text.replace(
                "</Relationships>",
                '<Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
              ),
            }
          : p,
    ),
    {
      name: "xl/sharedStrings.xml",
      text: '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>changed</t></si></sst>',
    },
  ]);
  expect(readDefaultBulkFormSheet(bytes)).toEqual([["changed"]]);
});
it.each(["namespace", "unbound", "duplicate-attribute"])(
  "rejects ambiguous selected worksheet metadata %s",
  (mode) => {
    const bytes = relationshipWorkbook([["changed"]], [["archive"]], (parts) =>
      parts.map((p) =>
        p.name === "xl/workbook.xml" && mode === "namespace"
          ? {
              ...p,
              text: p.text.replace(
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
                'xmlns:r="https://example.invalid/relationships"',
              ),
            }
          : p.name === "xl/_rels/workbook.xml.rels"
            ? {
                ...p,
                text:
                  mode === "unbound"
                    ? p.text.replace('Id="rId2"', 'Id="unbound"')
                    : mode === "duplicate-attribute"
                      ? p.text.replace('Id="rId2"', 'Id="rId2" Id="rId1"')
                      : p.text,
              }
            : p,
      ),
    );
    expect(() => readDefaultBulkFormSheet(bytes)).toThrow();
  },
);
