# Workbook Task 1 Implementation Report

## Status

DONE

## Scope and files

- Created `packages/shopline/src/workbook-base.ts`.
- Created `packages/shopline/src/workbook-base.test.ts` with synthetic 71-column fixtures only.
- Updated `packages/shopline/src/index.ts` to export the projection functions and types.
- Left `bulk-form.ts`, connected imports, services, production state, and merchant workbooks unchanged.

## RED evidence

Command:

```text
corepack.cmd pnpm@11.7.0 --filter @wukong/shopline exec vitest run src/workbook-base.test.ts
```

Expected failure recorded before implementation:

```text
FAIL src/workbook-base.test.ts
Error: Cannot find module './workbook-base.js'
Test Files 1 failed (1)
exit code 1
```

## GREEN evidence

Focused contract:

```text
corepack.cmd pnpm@11.7.0 --filter @wukong/shopline exec vitest run src/workbook-base.test.ts
Test Files 1 passed (1)
Tests 7 passed (7)
exit code 0
```

Complete SHOPLINE package suite:

```text
corepack.cmd pnpm@11.7.0 --filter @wukong/shopline test
Test Files 13 passed (13)
Tests 255 passed (255)
exit code 0
```

Package typecheck:

```text
corepack.cmd pnpm@11.7.0 --filter @wukong/shopline typecheck
tsc -p tsconfig.json --noEmit
exit code 0
```

Formatting used repository Prettier on the three package files. `git diff --check` returned no errors before the report was written.

## Exported interfaces

```ts
export type WorkbookBaseProduct = {
  rowNumber: number;
  productId: string;
  sku: string;
  title: BulkFormText;
  priceHkd: number | null;
  raw: BulkFormRawRow;
};

export type InferredWorkbookTime = {
  value: string;
  source: 'filename';
  timeZone: null;
};

export type PreparedWorkbookBase = {
  specVersion: string;
  sheet: BulkFormSheet;
  products: WorkbookBaseProduct[];
  totalRows: number;
  excludedRows: number;
  issues: BulkFormIssue[];
  inferredExportTime: InferredWorkbookTime | null;
};

export function inferWorkbookExportTime(filename: string): InferredWorkbookTime | null;
export function prepareWorkbookBase(sheet: BulkFormSheet, filename: string): PreparedWorkbookBase;
```

## Self-review

- Filename inference uses a strict SHOPLINE suffix pattern, validates the Gregorian calendar and 24-hour time, preserves the original local minute string, and returns no `Date`, timezone, or attestation.
- Projection delegates eligibility and issue classification to `parseBulkForm`, so variants, missing IDs/SKUs, and duplicate IDs retain the existing connected-parser behavior.
- `totalRows` starts after the recognized English/locale header rows and counts only nonblank data rows. A malformed header reports parser issues with zero products and zero counted data rows.
- The returned `sheet` is the original sheet reference, including rejected and variant rows. Eligible products preserve every normalized raw cell, leading-zero SKUs, bilingual titles, effective price, and original worksheet row number.
- No service, database, network, provider, AI, workbook I/O, or production behavior was added.
- No outstanding concerns found within Task 1 scope.
