import { describe, expect, it } from "vitest";

import { BULK_FORM_COLUMNS, ShoplineBulkFormError } from "@wukong/shopline";
import { readBulkFormSheet } from "@wukong/shopline/bulk-form-xlsx";

import { createBulkExport, sheetsMatch } from "./bulk-export-service.js";

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

  it("treats a row that's shorter due to a blank trailing cell as matching", () => {
    // Mirrors real writer/reader behavior: `writeBulkFormWorkbook` omits the
    // `<c>` element for a blank cell entirely, so a row whose trailing
    // column(s) are blank (e.g. the locked `slKey1`, last in
    // BULK_FORM_COLUMNS) reparses shorter than the fixed-width intended row
    // -- that's a correct round trip, not a mismatch.
    expect(sheetsMatch([["a", "b"]], [["a", "b", ""]])).toBe(true);
  });

  it("still catches a genuine mismatch even when the reparsed row is shorter", () => {
    expect(sheetsMatch([["a", "x"]], [["a", "b", ""]])).toBe(false);
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

function contentFor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: { en: "Title EN", "zh-Hant": "標題" },
    description: { en: "Desc EN", "zh-Hant": "描述" },
    seo: {
      title: { en: "SEO title EN", "zh-Hant": "SEO 標題" },
      description: { en: "SEO desc EN", "zh-Hant": "SEO 描述" },
    },
    tags: ["a", "b"],
    ...overrides,
  };
}

/**
 * A minimal-but-valid bulk-form raw row. `isBulkFormRawRow` (in
 * `@wukong/shopline`'s `bulk-form.ts`) requires every one of the 71
 * `BULK_FORM_COLUMNS` keys to be present on the object (`column.key in
 * value`, checked for all of them) — a row carrying only the enrichable
 * columns fails that check and gets treated as `raw_row_invalid`. Every
 * non-enrichable column is defaulted to a harmless placeholder string here;
 * only the enrichable columns (plus `productId`) are meant to be overridden
 * per-fixture.
 */
function rawRowFor(overrides: Partial<Record<string, string>> = {}) {
  const base: Record<string, string> = {};
  for (const column of BULK_FORM_COLUMNS) {
    base[column.key] = `placeholder-${column.key}`;
  }
  return {
    ...base,
    productId: "prod-1",
    nameZh: "舊標題",
    summaryEn: "old summary",
    summaryZh: "舊摘要",
    seoTitleEn: "old seo title",
    seoTitleZh: "舊 seo 標題",
    seoDescriptionEn: "old seo desc",
    seoDescriptionZh: "舊 seo 描述",
    seoKeywords: "old,keywords",
    ...overrides,
  };
}

function depsWith(
  overrides: Partial<Parameters<typeof createBulkExport>[1]> = {},
) {
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
    // A genuine no-op: every enrichable column already matches what the
    // active version's content would write, so no cell in the sheet
    // actually changes.
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
  const versions: Record<
    string,
    { id: string; content: ReturnType<typeof contentFor> }
  > = {
    listing_changed: {
      id: "version_changed",
      content: contentFor({ title: { en: "Title EN", "zh-Hant": "新標題" } }),
    },
    listing_noop: { id: "version_noop", content: contentFor() },
    listing_stale: {
      id: "version_stale",
      content: contentFor({ title: { en: "Title EN", "zh-Hant": "新標題" } }),
    },
  };
  return {
    async getPlatformProductLink(listingId: string) {
      return links[listingId] ?? null;
    },
    async getActiveVersion(listingId: string) {
      return versions[listingId] ?? null;
    },
    async getSourceImportHeaderContractSha256() {
      return "contract_1";
    },
    currentHeaderContractSha256() {
      return "contract_1";
    },
    ...overrides,
  };
}

describe("createBulkExport", () => {
  it("includes only the changed, fresh listing from a mixed 3-listing batch", async () => {
    // `createBulkExport` reads the platform-product link once up front (to
    // decide origin, and to snapshot what it expects export-time freshness
    // to still agree with), then hands `deps` straight through to
    // `assertExportFreshness`, which re-reads the link a second time to
    // verify nothing moved between those two reads. To exercise a genuine
    // "the row changed underneath us" case (as opposed to a tautological
    // compare-a-value-to-itself), the override here returns the real digest
    // on the first call for `listing_stale` and a mismatched digest on every
    // call after — i.e. the row was still fresh when we looked, but drifted
    // by the time we verified.
    let staleCallCount = 0;
    const deps = depsWith({
      async getPlatformProductLink(listingId: string) {
        const links = await depsWith().getPlatformProductLink(listingId);
        if (listingId === "listing_stale" && links) {
          staleCallCount += 1;
          return staleCallCount === 1
            ? links
            : { ...links, contentDigest: "mismatched_digest" };
        }
        return links;
      },
    });
    const result = await createBulkExport(
      {
        workspaceId: "ws_1",
        requestedBy: "user_1",
        listingIds: ["listing_changed", "listing_noop", "listing_stale"],
        freshnessAttested: true,
      },
      deps,
    );
    expect(result.rowCount).toBe(1);
    expect(result.manifest).toEqual([
      {
        listingId: "listing_changed",
        versionId: "version_changed",
        outcome: "included",
      },
      {
        listingId: "listing_noop",
        versionId: "version_noop",
        outcome: "excluded_no_op",
      },
      {
        listingId: "listing_stale",
        versionId: "version_stale",
        outcome: "excluded_stale",
        reason: "row_digest_mismatch",
      },
    ]);
  });

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

  it("does not trip the reparse-and-assert self-check on a real write/read round trip when the raw row's trailing locked column (slKey1) is blank", async () => {
    // slKey1 is the LAST column in BULK_FORM_COLUMNS and is locked (echoed
    // verbatim, never enriched) -- an ordinary, type-sanctioned blank state,
    // not an edge case. `writeBulkFormWorkbook` omits the `<c>` element for a
    // blank cell entirely, so a row whose trailing cell is blank reparses
    // shorter than the fixed-width sheet `createBulkFormUpdate` intended to
    // write. Before the fix, `sheetsMatch`'s raw length check flagged that as
    // a mismatch and `createBulkExport` threw on this perfectly correct
    // export.
    const deps = depsWith({
      async getPlatformProductLink(listingId: string) {
        if (listingId === "listing_blank_trailing_column") {
          return {
            remoteProductId: "prod-blank-trailing",
            rawRow: rawRowFor({ slKey1: "" }),
            origin: "import" as const,
            sourceImportId: "import_1",
            contentDigest: "digest_1",
          };
        }
        return depsWith().getPlatformProductLink(listingId);
      },
      async getActiveVersion(listingId: string) {
        if (listingId === "listing_blank_trailing_column") {
          return {
            id: "version_blank_trailing",
            content: contentFor({
              title: { en: "Title EN", "zh-Hant": "新標題" },
            }),
          };
        }
        return depsWith().getActiveVersion(listingId);
      },
    });
    const result = await createBulkExport(
      {
        workspaceId: "ws_1",
        requestedBy: "user_1",
        listingIds: ["listing_blank_trailing_column"],
        freshnessAttested: true,
      },
      deps,
    );
    expect(result.rowCount).toBe(1);
    expect(result.manifest).toEqual([
      {
        listingId: "listing_blank_trailing_column",
        versionId: "version_blank_trailing",
        outcome: "included",
      },
    ]);

    // Confirm the round trip actually did produce a shortened trailing row --
    // otherwise this test wouldn't be exercising the bug at all.
    const sheet = readBulkFormSheet(result.body);
    const dataRow = sheet[2] ?? [];
    expect(dataRow.length).toBeLessThan(BULK_FORM_COLUMNS.length);
  });

  it("excludes every import-origin listing with not_attested when freshnessAttested is false", async () => {
    const result = await createBulkExport(
      {
        workspaceId: "ws_1",
        requestedBy: "user_1",
        listingIds: ["listing_changed"],
        freshnessAttested: false,
      },
      depsWith(),
    );
    expect(result.rowCount).toBe(0);
    expect(result.manifest).toEqual([
      {
        listingId: "listing_changed",
        versionId: "version_changed",
        outcome: "excluded_stale",
        reason: "not_attested",
      },
    ]);
  });

  it("excludes a create-origin listing with not_import_origin, without calling assertExportFreshness for it", async () => {
    const deps = depsWith({
      async getPlatformProductLink() {
        return {
          remoteProductId: "prod-created",
          rawRow: null,
          origin: "created" as const,
          sourceImportId: null,
          contentDigest: null,
        };
      },
      async getActiveVersion() {
        return { id: "version_created", content: contentFor() };
      },
    });
    const result = await createBulkExport(
      {
        workspaceId: "ws_1",
        requestedBy: "user_1",
        listingIds: ["listing_created"],
        freshnessAttested: true,
      },
      deps,
    );
    expect(result.manifest).toEqual([
      {
        listingId: "listing_created",
        versionId: "version_created",
        outcome: "not_import_origin",
      },
    ]);
    expect(result.rowCount).toBe(0);
  });

  it("produces rowCount 0 with a full manifest, not an error, when every listing is excluded", async () => {
    const result = await createBulkExport(
      {
        workspaceId: "ws_1",
        requestedBy: "user_1",
        listingIds: ["listing_noop"],
        freshnessAttested: true,
      },
      depsWith(),
    );
    expect(result.rowCount).toBe(0);
    expect(result.manifest).toHaveLength(1);
  });

  it("excludes an unknown listing id with listing_not_found", async () => {
    const result = await createBulkExport(
      {
        workspaceId: "ws_1",
        requestedBy: "user_1",
        listingIds: ["listing_missing"],
        freshnessAttested: true,
      },
      depsWith({
        async getActiveVersion() {
          return null;
        },
      }),
    );
    expect(result.manifest).toEqual([
      {
        listingId: "listing_missing",
        versionId: null,
        outcome: "listing_not_found",
      },
    ]);
  });

  it("marks a listing whose stored raw row fails isBulkFormRawRow as raw_row_invalid", async () => {
    const deps = depsWith({
      async getPlatformProductLink(listingId: string) {
        if (listingId === "listing_invalid_row") {
          return {
            remoteProductId: "prod-invalid",
            // Missing almost all of the 71 required columns —
            // isBulkFormRawRow rejects this.
            rawRow: { productId: "prod-invalid" },
            origin: "import" as const,
            sourceImportId: "import_1",
            contentDigest: "digest_1",
          };
        }
        return depsWith().getPlatformProductLink(listingId);
      },
      async getActiveVersion(listingId: string) {
        if (listingId === "listing_invalid_row") {
          return { id: "version_invalid", content: contentFor() };
        }
        return depsWith().getActiveVersion(listingId);
      },
    });
    const result = await createBulkExport(
      {
        workspaceId: "ws_1",
        requestedBy: "user_1",
        listingIds: ["listing_invalid_row"],
        freshnessAttested: true,
      },
      deps,
    );
    expect(result.manifest).toEqual([
      {
        listingId: "listing_invalid_row",
        versionId: "version_invalid",
        outcome: "raw_row_invalid",
      },
    ]);
    expect(result.rowCount).toBe(0);
  });

  it("rethrows a ShoplineBulkFormError instead of silently reporting excluded_no_op when two survivors collide on the same remote product id", async () => {
    // Nothing upstream of this function rejects duplicate listing ids (the
    // planned bulk-export route's zod schema doesn't either), so two
    // requested listings can resolve to the same remoteProductId.
    // createBulkFormUpdate's own validateEnrichments throws
    // ShoplineBulkFormError({ code: "enrichment_duplicate" }) for the whole
    // batch call in that case — a real validation failure, not "nothing
    // changed" — so it must propagate rather than being swallowed as
    // excluded_no_op with a silently-dropped rowCount.
    const sharedLink = {
      remoteProductId: "prod-shared",
      rawRow: rawRowFor(),
      origin: "import" as const,
      sourceImportId: "import_1",
      contentDigest: "digest_1",
    };
    const deps = depsWith({
      async getPlatformProductLink(listingId: string) {
        if (listingId === "listing_dup_a" || listingId === "listing_dup_b") {
          return sharedLink;
        }
        return depsWith().getPlatformProductLink(listingId);
      },
      async getActiveVersion(listingId: string) {
        if (listingId === "listing_dup_a") {
          return {
            id: "version_dup_a",
            content: contentFor({
              title: { en: "Title EN", "zh-Hant": "新標題" },
            }),
          };
        }
        if (listingId === "listing_dup_b") {
          return {
            id: "version_dup_b",
            content: contentFor({
              title: { en: "Title EN", "zh-Hant": "新標題" },
            }),
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
          listingIds: ["listing_dup_a", "listing_dup_b"],
          freshnessAttested: true,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShoplineBulkFormError);
  });
});
