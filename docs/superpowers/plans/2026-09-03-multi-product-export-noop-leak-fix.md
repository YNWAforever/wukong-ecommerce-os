# Multi-Product Export No-Op-Row-Leak Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a real correctness bug where a no-op product's row is physically written into a multi-product bulk-form export with its stock-delta cells force-neutralized, even though the manifest correctly excludes it — plus add two related safety checks (reparse-and-assert, mixed-source/store rejection) the same readiness audit found missing.

**Architecture:** Three independent, additive fixes to two existing files (`packages/shopline/src/bulk-form.ts`, `apps/web/lib/bulk-export-service.ts`). No new files, no schema migration, no route-level changes.

**Tech Stack:** TypeScript, Vitest, the existing `@wukong/shopline` bulk-form XLSX read/write pair.

---

**Live-code discipline:** every file:line reference below was verified against the live checkout during this session's planning pass. Even so, **each task's first step is always "read the current file"** — treat quoted code as a starting point to diff against, not a guarantee.

**Environment:** pnpm is not reliably on PATH — use `corepack pnpm` for every command, e.g. `corepack pnpm exec vitest run <path/to/file>` and `corepack pnpm --filter <package> typecheck` (both are scoped commands that don't need turbo, and work directly via Bash). If a repo-root turbo-orchestrated command is ever needed and hits "Unable to find package manager binary", run it via PowerShell instead with `$env:PATH` prefixed by `C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin` (already set up this session) — but this plan's own verification steps are all scoped per-package and shouldn't need it.

---

## Task 1: Fix the core bug in `createBulkFormUpdate`

**Files:**
- Modify: `packages/shopline/src/bulk-form.ts`
- Test: `packages/shopline/src/bulk-form.test.ts`

- [ ] **Step 1: Read the current files**

Read `packages/shopline/src/bulk-form.ts:1072-1149` (`createBulkFormUpdate`) in full and confirm it still matches:

```ts
export function createBulkFormUpdate(
  rows: readonly BulkFormExportRow[],
  enrichments: readonly BulkFormEnrichment[],
  options: BulkFormUpdateOptions = {},
): BulkFormUpdate {
  const issues = validateEnrichments(rows, enrichments);
  if (issues.length > 0) throw new ShoplineBulkFormError(issues);

  const byProductId = new Map(
    enrichments.map((enrichment) => [enrichment.productId, enrichment.values]),
  );
  const include = options.include ?? "changed";

  const changes: BulkFormChange[] = [];
  const neutralizedQuantityDeltas: number[] = [];
  const dataRows: string[][] = [];

  for (const row of rows) {
    const values = byProductId.get(row.productId);
    if (values === undefined && include === "changed") continue;

    const cells = BULK_FORM_COLUMNS.map((column) => {
      const key = column.key;
      const original = row.raw[key];

      if ((QUANTITY_DELTA_COLUMNS as readonly string[]).includes(key)) {
        return original === null ? "" : NEUTRAL_QUANTITY_DELTA;
      }

      if (values === undefined || !isEnrichable(key)) return original ?? "";

      const replacement = values[key];
      if (replacement === undefined) return original ?? "";
      if (original === replacement) return original;

      changes.push({
        rowNumber: row.rowNumber,
        productId: row.productId,
        column: key,
        from: original,
        to: replacement,
      });
      return replacement;
    });

    for (const column of QUANTITY_DELTA_COLUMNS) {
      const original = row.raw[column];
      if (original !== null && original.trim() !== NEUTRAL_QUANTITY_DELTA) {
        neutralizedQuantityDeltas.push(row.rowNumber);
        break;
      }
    }

    dataRows.push(cells);
  }

  if (changes.length === 0) {
    throw new ShoplineBulkFormError([
      {
        code: "enrichment_no_changes",
        productId: null,
        column: null,
        message: "every enriched value already matches the source sheet",
      },
    ]);
  }

  return {
    specVersion: SHOPLINE_BULK_FORM_SPEC_VERSION,
    sheet: [
      BULK_FORM_COLUMNS.map((column) => column.en),
      BULK_FORM_COLUMNS.map((column) => column.zh),
      ...dataRows,
    ],
    changes,
    neutralizedQuantityDeltas,
  };
}
```

Also read `packages/shopline/src/bulk-form.test.ts` around its existing `createBulkFormUpdate` tests (search for `describe("createBulkFormUpdate"` or similar) to find its real `dataRow`/`sheetOf`/enrichment-fixture-building helpers — reuse them exactly, don't invent new ones.

- [ ] **Step 2: Write the failing unit test in `bulk-form.test.ts`**

Add a test proving a mixed batch (one product genuinely enriched, one product whose enrichment values already match its raw row) produces a `sheet` with exactly one data row, not two. Match this file's own existing fixture-building conventions — if it already has a row-builder helper (e.g. a function building a `BulkFormExportRow`) and an enrichment-builder helper, use them; otherwise construct the minimal inputs directly:

```ts
it("excludes a no-op product's row from a mixed batch, not just from the reported changes", () => {
  const rows: BulkFormExportRow[] = [
    {
      productId: "prod-changed",
      rowNumber: 1,
      raw: rawRowFor({ productId: "prod-changed", nameZh: "舊標題" }),
    },
    {
      productId: "prod-noop",
      rowNumber: 2,
      raw: rawRowFor({ productId: "prod-noop", nameZh: "沒有變化" }),
    },
  ];
  const enrichments: BulkFormEnrichment[] = [
    { productId: "prod-changed", values: { nameZh: "新標題" } },
    // Same value as the row's own raw nameZh -- a genuine no-op.
    { productId: "prod-noop", values: { nameZh: "沒有變化" } },
  ];

  const update = createBulkFormUpdate(rows, enrichments, { include: "changed" });

  // 2 header rows + exactly 1 data row (the changed product only).
  expect(update.sheet).toHaveLength(3);
  expect(update.changes).toHaveLength(1);
  expect(update.changes[0]?.productId).toBe("prod-changed");
});
```

Adapt `rawRowFor`/the exact `BulkFormExportRow`/`BulkFormEnrichment` construction to whatever helper this test file already provides — read the file first (per Step 1) and use its real helper names, not the illustrative ones above if they differ.

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm exec vitest run packages/shopline/src/bulk-form.test.ts`
Expected: FAIL — `update.sheet` has length 4 (both rows present), not 3.

- [ ] **Step 4: Apply the fix**

Change the loop body in `createBulkFormUpdate` from:

```ts
  for (const row of rows) {
    const values = byProductId.get(row.productId);
    if (values === undefined && include === "changed") continue;

    const cells = BULK_FORM_COLUMNS.map((column) => {
```

to:

```ts
  for (const row of rows) {
    const values = byProductId.get(row.productId);
    const changesBeforeRow = changes.length;

    const cells = BULK_FORM_COLUMNS.map((column) => {
```

and change:

```ts
    for (const column of QUANTITY_DELTA_COLUMNS) {
      const original = row.raw[column];
      if (original !== null && original.trim() !== NEUTRAL_QUANTITY_DELTA) {
        neutralizedQuantityDeltas.push(row.rowNumber);
        break;
      }
    }

    dataRows.push(cells);
  }
```

to:

```ts
    // Skip a row that produced zero real changes -- e.g. an enrichment
    // whose every value already matches the raw source. Deciding this
    // AFTER building `cells` (rather than before, based on whether an
    // enrichment entry merely exists) is what makes this correct for a
    // MIXED batch: `createBulkExport` always supplies an enrichment entry
    // for every freshness-surviving listing, even genuine no-ops, so
    // "does an entry exist" was never a reliable signal that this specific
    // row actually changed.
    const rowChanged = changes.length > changesBeforeRow;
    if (!rowChanged && include === "changed") continue;

    for (const column of QUANTITY_DELTA_COLUMNS) {
      const original = row.raw[column];
      if (original !== null && original.trim() !== NEUTRAL_QUANTITY_DELTA) {
        neutralizedQuantityDeltas.push(row.rowNumber);
        break;
      }
    }

    dataRows.push(cells);
  }
```

The `changes` array's own construction inside the `.map()` callback is completely unchanged.

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm exec vitest run packages/shopline/src/bulk-form.test.ts`
Expected: PASS, and confirm every pre-existing test in this file still passes (this file has ~150+ tests spanning parsing, validation, and update generation — the same command runs all of them).

- [ ] **Step 6: Write the failing integration-level test in `bulk-export-service.test.ts`**

This is the test that would have caught the *original* bug — today's suite only ever asserts on `manifest`/`rowCount`, never on the actual emitted bytes. Read `apps/web/lib/bulk-export-service.test.ts` in full first (it should still match the version quoted in this plan's research: a `depsWith()` helper building `links`/`versions` records keyed by listing id, with `listing_changed`/`listing_noop`/`listing_stale` fixtures already defined).

Add the import for XLSX parsing at the top of the file:

```ts
import { readBulkFormSheet } from "@wukong/shopline/bulk-form-xlsx";
```

Add the test:

```ts
it("does not write a no-op listing's row into the actual emitted workbook bytes", async () => {
  const result = await createBulkExport(
    {
      workspaceId: "ws_1",
      requestedBy: "user_1",
      listingIds: ["listing_changed", "listing_noop"],
      freshnessAttested: true,
    },
    depsWith(),
  );
  expect(result.rowCount).toBe(1);

  // Parse the actual bytes, not just the manifest/rowCount -- this is what
  // the original bug hid from: the manifest already correctly reported
  // rowCount 1, but the real file contained 2 data rows.
  const sheet = readBulkFormSheet(result.body);
  // 2 header rows + exactly 1 data row.
  expect(sheet).toHaveLength(3);
});
```

- [ ] **Step 7: Run test to verify it fails (against the pre-Task-1-fix code) — already fixed by Task 1, so instead confirm it passes now and would have failed before**

Since Task 1's fix already landed in Step 4, this test should PASS immediately. Run: `corepack pnpm exec vitest run apps/web/lib/bulk-export-service.test.ts` and confirm it's green. To directly confirm this test genuinely exercises the fix (not a tautology), temporarily revert just the Step 4 diff (`git stash` or a manual re-edit reverting the loop-body change), re-run this one test, confirm it now FAILS (`sheet` has length 4), then restore the fix (`git stash pop` or re-apply) and confirm it passes again. Report the before/after output in your task summary.

- [ ] **Step 8: Commit**

```bash
git add packages/shopline/src/bulk-form.ts packages/shopline/src/bulk-form.test.ts apps/web/lib/bulk-export-service.test.ts
git commit -m "fix: exclude no-op rows from a mixed multi-product export, not just from the reported manifest"
```
(Add a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.)

---

## Task 2: Reparse-and-assert in `createBulkExport`

**Files:**
- Modify: `apps/web/lib/bulk-export-service.ts`
- Test: `apps/web/lib/bulk-export-service.test.ts`

- [ ] **Step 1: Read the current file**

Read `apps/web/lib/bulk-export-service.ts` in full. Confirm the tail of `createBulkExport` still matches:

```ts
  const specVersion = update?.specVersion ?? SHOPLINE_BULK_FORM_SPEC_VERSION;
  const body = update ? writeBulkFormWorkbook(update.sheet) : new Uint8Array(0);
  const rowCount = manifest.filter(
    (entry) => entry.outcome === "included",
  ).length;

  return { manifest, rowCount, specVersion, body };
}
```

Confirm the file already imports `writeBulkFormWorkbook` from `@wukong/shopline/bulk-form-xlsx` — you'll add `readBulkFormSheet` to the same import.

- [ ] **Step 2: Write the failing unit test for the comparison helper**

Add near the top of `apps/web/lib/bulk-export-service.test.ts` (after the existing imports), a new `describe` block testing the helper directly — this is the most direct way to prove the self-check's comparison logic is correct, including the null/`""` blank-cell equivalence that would otherwise cause false positives on every blank cell:

```ts
import { sheetsMatch } from "./bulk-export-service.js";

describe("sheetsMatch", () => {
  it("treats a reparsed null cell and an intended empty-string cell as equivalent", () => {
    expect(sheetsMatch([["a", null]], [["a", ""]])).toBe(true);
  });

  it("returns false when a cell value genuinely differs", () => {
    expect(sheetsMatch([["a", "b"]], [["a", "c"]])).toBe(false);
  });

  it("returns false when row counts differ", () => {
    expect(sheetsMatch([["a"]], [["a"], ["b"]])).toBe(false);
  });

  it("returns false when a row's column count differs", () => {
    expect(sheetsMatch([["a", "b"]], [["a"]])).toBe(false);
  });

  it("returns true for identical sheets", () => {
    expect(
      sheetsMatch(
        [
          ["a", "b"],
          ["c", "d"],
        ],
        [
          ["a", "b"],
          ["c", "d"],
        ],
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm exec vitest run apps/web/lib/bulk-export-service.test.ts`
Expected: FAIL — `sheetsMatch` is not exported (module has no such export yet).

- [ ] **Step 4: Implement `sheetsMatch` and wire it into `createBulkExport`**

In `apps/web/lib/bulk-export-service.ts`, update the import line to also bring in `readBulkFormSheet`:

```ts
import { writeBulkFormWorkbook, readBulkFormSheet } from "@wukong/shopline/bulk-form-xlsx";
```

Add the exported helper function (place it near the top of the file, after the type definitions, before `createBulkExport`):

```ts
/**
 * Compares a reparsed workbook grid against the sheet `createBulkFormUpdate`
 * intended to write. `readBulkFormSheet` returns `null` for a blank cell
 * (`packages/shopline/src/bulk-form-xlsx.ts`'s own `cellAt` helper collapses
 * an empty string to `null` on read), while `BulkFormUpdate.sheet`'s blanks
 * are `""` -- both sides are normalized to `""` before comparing, or every
 * blank cell would spuriously fail this check.
 */
export function sheetsMatch(
  reparsed: readonly (readonly (string | null)[])[],
  intended: readonly (readonly string[])[],
): boolean {
  if (reparsed.length !== intended.length) return false;
  for (let row = 0; row < intended.length; row += 1) {
    const reparsedRow = reparsed[row] ?? [];
    const intendedRow = intended[row] ?? [];
    if (reparsedRow.length !== intendedRow.length) return false;
    for (let col = 0; col < intendedRow.length; col += 1) {
      if ((reparsedRow[col] ?? "") !== (intendedRow[col] ?? "")) return false;
    }
  }
  return true;
}
```

Change the tail of `createBulkExport` from:

```ts
  const specVersion = update?.specVersion ?? SHOPLINE_BULK_FORM_SPEC_VERSION;
  const body = update ? writeBulkFormWorkbook(update.sheet) : new Uint8Array(0);
  const rowCount = manifest.filter(
    (entry) => entry.outcome === "included",
  ).length;

  return { manifest, rowCount, specVersion, body };
}
```

to:

```ts
  const specVersion = update?.specVersion ?? SHOPLINE_BULK_FORM_SPEC_VERSION;
  const body = update ? writeBulkFormWorkbook(update.sheet) : new Uint8Array(0);

  // Self-check: re-parse exactly what was just written and confirm it
  // matches what was intended. An all-no-op batch has `update === null`
  // and `body` is an empty placeholder -- nothing to reparse.
  if (update && !sheetsMatch(readBulkFormSheet(body), update.sheet)) {
    throw new Error(
      "generated bulk-form workbook failed its own reparse-and-assert check -- the written bytes do not match the intended sheet",
    );
  }

  const rowCount = manifest.filter(
    (entry) => entry.outcome === "included",
  ).length;

  return { manifest, rowCount, specVersion, body };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm exec vitest run apps/web/lib/bulk-export-service.test.ts`
Expected: PASS, and confirm every pre-existing test in this file still passes (a correct export must never trip this new check — if any existing test now fails here, that indicates a real bug in the reparse-and-assert logic itself, not a test to "fix around").

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/bulk-export-service.ts apps/web/lib/bulk-export-service.test.ts
git commit -m "feat: reparse and assert the emitted export workbook matches what was intended"
```
(Add a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.)

---

## Task 3: Mixed-source/store rejection

**Files:**
- Modify: `packages/shopline/src/bulk-form.ts`
- Modify: `apps/web/lib/bulk-export-service.ts`
- Test: `apps/web/lib/bulk-export-service.test.ts`

- [ ] **Step 1: Read the current files**

Read `packages/shopline/src/bulk-form.ts:909-917` and confirm `BulkFormEnrichmentIssueCode` still matches:

```ts
export type BulkFormEnrichmentIssueCode =
  | "enrichment_empty"
  | "enrichment_no_changes"
  | "enrichment_duplicate"
  | "enrichment_product_unknown"
  | "enrichment_column_not_enrichable"
  | "enrichment_value_blank"
  | "enrichment_value_too_long"
  | "enrichment_value_control_characters";
```

Read `apps/web/lib/bulk-export-service.ts:64-70` and confirm `BulkExportPlatformProductLink` still matches:

```ts
export type BulkExportPlatformProductLink = {
  remoteProductId: string;
  rawRow: Record<string, string | null> | null;
  origin: "import" | "created";
  sourceImportId: string | null;
  contentDigest: string | null;
};
```

Read the per-listing loop inside `createBulkExport` and confirm the shape right after the `origin !== "import"` exclusion still matches:

```ts
  for (const listingId of input.listingIds) {
    const activeVersion = await deps.getActiveVersion(listingId);
    if (!activeVersion) {
      manifest.push({
        listingId,
        versionId: null,
        outcome: "listing_not_found",
      });
      continue;
    }

    const link = await deps.getPlatformProductLink(listingId);
    if (!link || link.origin !== "import") {
      manifest.push({
        listingId,
        versionId: activeVersion.id,
        outcome: "not_import_origin",
      });
      continue;
    }

    const freshness = await assertExportFreshness(
```

- [ ] **Step 2: Write the failing tests**

Add `connectionId` to `bulk-export-service.test.ts`'s existing `depsWith()` helper's `links` record type and every entry, plus the ad-hoc inline override objects in its other tests — this is required BEFORE these new tests can even typecheck, since `BulkExportPlatformProductLink` is about to become a required field. Change:

```ts
  const links: Record<
    string,
    {
      remoteProductId: string;
      rawRow: Record<string, string | null> | null;
      origin: "import" | "created";
      sourceImportId: string | null;
      contentDigest: string | null;
    }
  > = {
    listing_changed: {
      remoteProductId: "prod-changed",
      rawRow: rawRowFor(),
      origin: "import",
      sourceImportId: "import_1",
      contentDigest: "digest_1",
    },
    listing_noop: {
      remoteProductId: "prod-noop",
      rawRow: rawRowFor({
        nameZh: "標題",
        summaryEn: "Desc EN",
        summaryZh: "描述",
        seoTitleEn: "SEO title EN",
        seoTitleZh: "SEO 標題",
        seoDescriptionEn: "SEO desc EN",
        seoDescriptionZh: "SEO 描述",
        seoKeywords: "a, b",
      }),
      origin: "import",
      sourceImportId: "import_1",
      contentDigest: "digest_1",
    },
    listing_stale: {
      remoteProductId: "prod-stale",
      rawRow: rawRowFor(),
      origin: "import",
      sourceImportId: "import_1",
      contentDigest: "digest_1",
    },
  };
```

to (adding `connectionId: "conn_1"` to every entry, and to the type):

```ts
  const links: Record<
    string,
    {
      remoteProductId: string;
      rawRow: Record<string, string | null> | null;
      origin: "import" | "created";
      sourceImportId: string | null;
      contentDigest: string | null;
      connectionId: string;
    }
  > = {
    listing_changed: {
      remoteProductId: "prod-changed",
      rawRow: rawRowFor(),
      origin: "import",
      sourceImportId: "import_1",
      contentDigest: "digest_1",
      connectionId: "conn_1",
    },
    listing_noop: {
      remoteProductId: "prod-noop",
      rawRow: rawRowFor({
        nameZh: "標題",
        summaryEn: "Desc EN",
        summaryZh: "描述",
        seoTitleEn: "SEO title EN",
        seoTitleZh: "SEO 標題",
        seoDescriptionEn: "SEO desc EN",
        seoDescriptionZh: "SEO 描述",
        seoKeywords: "a, b",
      }),
      origin: "import",
      sourceImportId: "import_1",
      contentDigest: "digest_1",
      connectionId: "conn_1",
    },
    listing_stale: {
      remoteProductId: "prod-stale",
      rawRow: rawRowFor(),
      origin: "import",
      sourceImportId: "import_1",
      contentDigest: "digest_1",
      connectionId: "conn_1",
    },
  };
```

Then find every ad-hoc inline `getPlatformProductLink` override object in this file's other tests (there are 3: in `"excludes a create-origin listing with not_import_origin..."`, `"marks a listing whose stored raw row fails isBulkFormRawRow..."`, and `"rethrows a ShoplineBulkFormError instead of silently reporting excluded_no_op..."`) and add `connectionId: "conn_1"` to each — e.g.:

```ts
        return {
          remoteProductId: "prod-created",
          rawRow: null,
          origin: "created" as const,
          sourceImportId: null,
          contentDigest: null,
          connectionId: "conn_1",
        };
```

(same pattern for the other two — read each one in the live file and add the field, keeping every other field unchanged).

Now add the two new tests:

```ts
it("rejects a request mixing listings from two different SHOPLINE connections", async () => {
  const deps = depsWith({
    async getPlatformProductLink(listingId: string) {
      if (listingId === "listing_other_store") {
        return {
          remoteProductId: "prod-other-store",
          rawRow: rawRowFor({ productId: "prod-other-store" }),
          origin: "import" as const,
          sourceImportId: "import_1",
          contentDigest: "digest_1",
          connectionId: "conn_2",
        };
      }
      return depsWith().getPlatformProductLink(listingId);
    },
    async getActiveVersion(listingId: string) {
      if (listingId === "listing_other_store") {
        return {
          id: "version_other_store",
          content: contentFor({ title: { en: "Title EN", "zh-Hant": "新標題" } }),
        };
      }
      return depsWith().getActiveVersion(listingId);
    },
  });

  await expect(
    createBulkExport(
      {
        workspaceId: "ws_1",
        requestedBy: "user_1",
        listingIds: ["listing_changed", "listing_other_store"],
        freshnessAttested: true,
      },
      deps,
    ),
  ).rejects.toMatchObject({
    issues: [expect.objectContaining({ code: "mixed_source_connections" })],
  });
});

it("does not require sourceImportId to match across listings from the same connection", async () => {
  const deps = depsWith({
    async getPlatformProductLink(listingId: string) {
      if (listingId === "listing_other_import") {
        return {
          remoteProductId: "prod-other-import",
          rawRow: rawRowFor({ productId: "prod-other-import" }),
          origin: "import" as const,
          sourceImportId: "import_2",
          contentDigest: "digest_1",
          connectionId: "conn_1",
        };
      }
      return depsWith().getPlatformProductLink(listingId);
    },
    async getActiveVersion(listingId: string) {
      if (listingId === "listing_other_import") {
        return {
          id: "version_other_import",
          content: contentFor({ title: { en: "Title EN", "zh-Hant": "新標題" } }),
        };
      }
      return depsWith().getActiveVersion(listingId);
    },
  });

  const result = await createBulkExport(
    {
      workspaceId: "ws_1",
      requestedBy: "user_1",
      listingIds: ["listing_changed", "listing_other_import"],
      freshnessAttested: true,
    },
    deps,
  );
  expect(result.rowCount).toBe(2);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm exec vitest run apps/web/lib/bulk-export-service.test.ts`
Expected: two failures — the mixed-connection test doesn't reject (no such check exists yet), and the fixture literals without `connectionId` fail to typecheck (vitest will report a TypeScript error). Confirm the `connectionId`-typecheck failures first (fix those per Step 2 before the new tests can even run), then confirm the mixed-connection test specifically fails because nothing throws.

- [ ] **Step 4: Implement the check**

In `packages/shopline/src/bulk-form.ts`, add the new issue code:

```ts
export type BulkFormEnrichmentIssueCode =
  | "enrichment_empty"
  | "enrichment_no_changes"
  | "enrichment_duplicate"
  | "enrichment_product_unknown"
  | "enrichment_column_not_enrichable"
  | "enrichment_value_blank"
  | "enrichment_value_too_long"
  | "enrichment_value_control_characters"
  // Thrown by a caller (apps/web/lib/bulk-export-service.ts), not by
  // anything inside this package -- reuses ShoplineBulkFormError's shared
  // shape/handling for a batch that mixes listings from two different
  // SHOPLINE connections rather than adding a new error type.
  | "mixed_source_connections";
```

In `apps/web/lib/bulk-export-service.ts`, add `connectionId` to the type:

```ts
export type BulkExportPlatformProductLink = {
  remoteProductId: string;
  rawRow: Record<string, string | null> | null;
  origin: "import" | "created";
  sourceImportId: string | null;
  contentDigest: string | null;
  connectionId: string;
};
```

Add a `sharedConnectionId` tracker before the loop and the check right after the `origin !== "import"` exclusion:

```ts
  const survivorRemoteProductIds = new Map<string, string>();
  let sharedConnectionId: string | null = null;

  const freshnessDeps: AssertExportFreshnessDeps = {
```

(only the new `let sharedConnectionId` line is added here — confirm the exact surrounding lines from your Step 1 read and insert accordingly, since `survivorRemoteProductIds` and `freshnessDeps` already exist in the live file)

```ts
    const link = await deps.getPlatformProductLink(listingId);
    if (!link || link.origin !== "import") {
      manifest.push({
        listingId,
        versionId: activeVersion.id,
        outcome: "not_import_origin",
      });
      continue;
    }

    // Checked early, before the freshness gate: fail fast with a clear
    // "you're mixing stores" error rather than a confusing per-listing
    // freshness error when the real mistake is picking listings from two
    // different SHOPLINE connections. sourceImportId is deliberately NOT
    // checked here -- two listings from different import batches of the
    // SAME connection is a normal, expected case.
    if (sharedConnectionId === null) {
      sharedConnectionId = link.connectionId;
    } else if (link.connectionId !== sharedConnectionId) {
      throw new ShoplineBulkFormError([
        {
          code: "mixed_source_connections",
          productId: null,
          column: null,
          message:
            "requested listings resolve to more than one SHOPLINE connection; export one store at a time",
        },
      ]);
    }

    const freshness = await assertExportFreshness(
```

Confirm `ShoplineBulkFormError` is already imported in this file (it should be, since `createBulkExport`'s existing catch block already handles it) — no new import needed.

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm exec vitest run apps/web/lib/bulk-export-service.test.ts`
Expected: PASS, and confirm every pre-existing test in this file still passes.

- [ ] **Step 6: Check `apps/web/app/api/listings/export/route.test.ts` for its own fixtures**

Read `apps/web/app/api/listings/export/route.test.ts` in full. It likely has its own fake `platformProducts`/link fixtures separate from `bulk-export-service.test.ts`'s (this route test file fakes the whole `repositories` object, not just `createBulkExport`'s `deps`). If it does, add `connectionId: "conn_1"` (or whatever value keeps every existing listing on the same connection) to every one of its fixture link objects, following the exact same pattern as Step 2 above. Run `corepack pnpm exec vitest run "apps/web/app/api/listings/export/route.test.ts"` and confirm all pre-existing tests still pass with the field added.

- [ ] **Step 7: Commit**

```bash
git add packages/shopline/src/bulk-form.ts apps/web/lib/bulk-export-service.ts apps/web/lib/bulk-export-service.test.ts "apps/web/app/api/listings/export/route.test.ts"
git commit -m "feat: reject a bulk export that mixes listings from two different SHOPLINE connections"
```
(Add a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer. Omit the route test file from `git add` if Step 6 found nothing needed changing there.)

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run every directly-affected test file**

```bash
corepack pnpm exec vitest run packages/shopline/src/bulk-form.test.ts
corepack pnpm exec vitest run packages/shopline/src/bulk-form-xlsx.test.ts
corepack pnpm exec vitest run apps/web/lib/bulk-export-service.test.ts
corepack pnpm exec vitest run "apps/web/app/api/listings/export/route.test.ts"
corepack pnpm exec vitest run apps/web/lib/delivery-service.review-fix.test.ts
```

Expected: all PASS, with zero failures across all five files. `delivery-service.review-fix.test.ts` in particular must show no change in behavior (per Task 1's design note that the single-row delivery path's observable outcome is unchanged) — if anything in this file fails, that means Task 1's fix broke the single-row path and needs to be revisited, not that the test needs adjusting.

- [ ] **Step 2: Typecheck the two touched packages**

```bash
corepack pnpm --filter @wukong/shopline typecheck
corepack pnpm --filter @wukong/web typecheck
```

Expected: both exit 0, clean.

- [ ] **Step 3: Format check**

```bash
corepack pnpm exec prettier --check packages/shopline/src/bulk-form.ts packages/shopline/src/bulk-form.test.ts apps/web/lib/bulk-export-service.ts apps/web/lib/bulk-export-service.test.ts "apps/web/app/api/listings/export/route.test.ts"
```

If any file fails, run `corepack pnpm exec prettier --write <file>` on it and commit that separately as a small `style:` follow-up commit.

- [ ] **Step 4: Report status**

Do not push or open a pull request — stop here and report back with the full verification checklist's results (Steps 1-3), matching how every prior package/fix this session was handed back for the user's own review/merge.
