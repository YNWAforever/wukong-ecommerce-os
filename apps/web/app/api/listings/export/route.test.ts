import {
  BULK_FORM_COLUMNS,
  hashBulkFormHeaderContract,
} from "@wukong/shopline";
import { describe, expect, it } from "vitest";

import { createExportListingsHandler } from "./route.js";

const context = {
  workspaceId: "ws_opak",
  actorId: "reviewer_1",
  role: "reviewer" as const,
};

const HEADER_CONTRACT_SHA = hashBulkFormHeaderContract();

function request(body: unknown) {
  return new Request("http://localhost/api/listings/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function contentFor(zhTitle: string) {
  return {
    title: { en: "Title EN", "zh-Hant": zhTitle },
    description: { en: "Desc EN", "zh-Hant": "描述" },
    seo: {
      title: { en: "SEO title EN", "zh-Hant": "SEO 標題" },
      description: { en: "SEO desc EN", "zh-Hant": "SEO 描述" },
    },
    tags: ["a", "b"],
  };
}

/**
 * A minimal-but-valid bulk-form raw row -- `isBulkFormRawRow` requires every
 * one of the 71 `BULK_FORM_COLUMNS` keys to be present. Mirrors the fixture
 * in `apps/web/lib/bulk-export-service.test.ts`.
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

type ReviewSnapshotFixture = {
  activeVersion: {
    id: string;
    sequence: number;
    content: ReturnType<typeof contentFor>;
  } | null;
} | null;

type PlatformProductFixture = {
  remoteProductId: string;
  rawRow: Record<string, string | null> | null;
  origin: "import" | "created";
  sourceImportId: string | null;
  contentDigest: string | null;
  connectionId: string;
} | null;

const defaultReviewSnapshots: Record<string, ReviewSnapshotFixture> = {
  listing_changed: {
    activeVersion: {
      id: "version_changed",
      sequence: 1,
      content: contentFor("新標題"),
    },
  },
  listing_noop: {
    activeVersion: {
      id: "version_noop",
      sequence: 1,
      content: contentFor("標題"),
    },
  },
  listing_stale: {
    activeVersion: {
      id: "version_stale",
      sequence: 1,
      content: contentFor("新標題"),
    },
  },
};

const defaultPlatformProducts: Record<string, PlatformProductFixture> = {
  listing_changed: {
    remoteProductId: "prod-changed",
    rawRow: rawRowFor(),
    origin: "import",
    sourceImportId: "import_1",
    contentDigest: "digest_1",
    connectionId: "conn_1",
  },
  // A genuine no-op: every enrichable column already matches what the active
  // version's content would write, so no cell in the sheet actually changes.
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

function makeExportAttempts() {
  const store = new Map<
    string,
    {
      id: string;
      requestedBy: string;
      manifest: any[];
      rowCount: number;
      specVersion: string;
      createdAt: Date;
    }
  >();
  let counter = 0;
  const sortKey = (entry: { listingId: string; versionId: string | null }) =>
    `${entry.listingId}:${entry.versionId ?? "null"}`;
  const sorted = (manifest: any[]) =>
    [...manifest].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  return {
    ensureCalls: [] as any[],
    async ensure(input: any) {
      this.ensureCalls.push(input);
      const existing = store.get(input.idempotencyKey);
      if (existing) {
        const manifestMatches =
          JSON.stringify(sorted(existing.manifest)) ===
          JSON.stringify(sorted(input.manifest));
        if (
          existing.rowCount !== input.rowCount ||
          existing.specVersion !== input.specVersion ||
          !manifestMatches
        ) {
          throw new Error(
            "export attempt idempotency key does not match the stored row",
          );
        }
        // Mirrors the real repository's `.onConflictDoNothing().returning()`
        // semantics (packages/db/src/repositories/export-attempts.ts): a
        // repeat call that finds an existing row reports `wasCreated: false`.
        return { ...existing, wasCreated: false };
      }
      counter += 1;
      const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      const created = {
        id,
        requestedBy: input.requestedBy,
        manifest: input.manifest,
        rowCount: input.rowCount,
        specVersion: input.specVersion,
        createdAt: new Date(),
      };
      store.set(input.idempotencyKey, created);
      return { ...created, wasCreated: true };
    },
    async getById(id: string) {
      for (const value of store.values()) {
        if (value.id === id) return value;
      }
      return null;
    },
  };
}

function makeRepositories(
  options: {
    reviewSnapshots?: Record<string, ReviewSnapshotFixture>;
    platformProducts?: Record<string, PlatformProductFixture>;
    headerContractSha256?: string;
    // Simulates an ordinary transient failure (connection drop, pool
    // exhaustion, ...) between `exportAttempts.ensure()` and the callback's
    // return -- i.e. still inside the transaction, so it must roll back
    // whatever `ensure()` just inserted.
    auditWriteThrows?: boolean;
  } = {},
) {
  const reviewSnapshots = options.reviewSnapshots ?? defaultReviewSnapshots;
  const platformProducts = options.platformProducts ?? defaultPlatformProducts;
  const headerContractSha256 =
    options.headerContractSha256 ?? HEADER_CONTRACT_SHA;
  const audits: any[] = [];
  const exportAttempts = makeExportAttempts();
  // Simulates "the row moved between when createBulkExport looked and when
  // assertExportFreshness verified" for listing_stale, same trick as
  // apps/web/lib/bulk-export-service.test.ts: real link on the first call,
  // mismatched digest on every call after.
  let staleCallCount = 0;

  const repositories = {
    listings: {
      async getReviewSnapshot(listingId: string) {
        return reviewSnapshots[listingId] ?? null;
      },
    },
    platformProducts: {
      async getByListingId(listingId: string) {
        const fixture = platformProducts[listingId];
        if (!fixture) return null;
        if (listingId === "listing_stale") {
          staleCallCount += 1;
          if (staleCallCount > 1) {
            return { ...fixture, contentDigest: "mismatched_digest" };
          }
        }
        return fixture;
      },
    },
    sourceImports: {
      async getById(id: string) {
        if (id === "import_1") return { headerContractSha256 };
        return null;
      },
    },
    exportAttempts,
    audit: {
      async write(entry: any) {
        if (options.auditWriteThrows) {
          throw new Error("connection reset");
        }
        audits.push(entry);
      },
    },
  };

  return { repositories, audits, exportAttempts };
}

function makeAssetStore() {
  const calls: any[] = [];
  return {
    calls,
    async writeObject(
      workspaceId: string,
      key: string,
      body: Uint8Array,
      mimeType: string,
    ) {
      calls.push({ workspaceId, key, body, mimeType });
      return { size: body.byteLength, mimeType };
    },
  };
}

function makeHandler(
  options: {
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
    reviewSnapshots?: Record<string, ReviewSnapshotFixture>;
    platformProducts?: Record<string, PlatformProductFixture>;
    headerContractSha256?: string;
    auditWriteThrows?: boolean;
  } = {},
) {
  const { repositories, audits, exportAttempts } = makeRepositories(options);
  const assetStore = makeAssetStore();
  let getDatabaseCalls = 0;

  const handler = createExportListingsHandler({
    sessionContext: {
      async resolve() {
        return { ...context, role: options.role ?? "reviewer" };
      },
    },
    getDatabase: () => {
      getDatabaseCalls += 1;
      return {
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repos: any) => Promise<T>,
        ) {
          return work(repositories);
        },
      };
    },
    getAssetStore: () => assetStore,
  });

  return {
    handler,
    audits,
    assetStore,
    exportAttempts,
    getDatabaseCalls: () => getDatabaseCalls,
  };
}

describe("POST /api/listings/export", () => {
  it("returns 200 with a manifest and rowCount for a mixed 3-listing batch, and writes the export exactly once", async () => {
    const { handler, assetStore, audits } = makeHandler();
    const response = await handler(
      request({
        listingIds: ["listing_changed", "listing_noop", "listing_stale"],
        freshnessAttested: true,
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rowCount).toBe(1);
    expect(body.exportAttemptId).toEqual(expect.any(String));
    expect(body.manifest).toEqual([
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
    expect(assetStore.calls).toHaveLength(1);
    expect(assetStore.calls[0].workspaceId).toBe("ws_opak");
    expect(assetStore.calls[0].mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(audits).toHaveLength(2);
    expect(audits[0].action).toBe("listing.bulk_export_created");
    expect(audits[0].metadata.includedListingIds).toEqual(["listing_changed"]);
    expect(audits[0].metadata.excludedListingIds).toEqual([
      "listing_noop",
      "listing_stale",
    ]);
    // One listing.review_conflict event per excluded_stale manifest entry --
    // listing_noop is excluded too, but as excluded_no_op, not
    // excluded_stale, so it must not get a review_conflict event.
    expect(audits[1]).toMatchObject({
      workspaceId: "ws_opak",
      actorId: "reviewer_1",
      entityId: "listing_stale",
      action: "listing.review_conflict",
      metadata: { reason: "row_digest_mismatch" },
    });
  });

  it.each(["viewer", "operator"] as const)(
    "returns 403 insufficient_role for a %s",
    async (role) => {
      const { handler } = makeHandler({ role });
      const response = await handler(
        request({ listingIds: ["listing_changed"], freshnessAttested: true }),
      );
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.code).toBe("insufficient_role");
    },
  );

  it("rejects an empty listingIds array with 400", async () => {
    const { handler } = makeHandler();
    const response = await handler(
      request({ listingIds: [], freshnessAttested: true }),
    );
    expect(response.status).toBe(400);
  });

  it("returns the same exportAttemptId for two identical requests, and writes only one bulk_export_created and one review_conflict audit event across both", async () => {
    const { handler, audits } = makeHandler();
    // Uses freshnessAttested: false (not the listing_stale fixture) so the
    // excluded_stale outcome is stable across repeat calls to the SAME
    // handler/repositories -- listing_stale's fixture instead simulates a
    // freshness race via a call-count counter that keeps incrementing across
    // repeat calls within one test, which would make the manifest differ
    // between the first and second request and defeat the point of this
    // idempotency assertion.
    const body = {
      listingIds: ["listing_changed"],
      freshnessAttested: false,
    };
    const first = await (await handler(request(body))).json();
    const second = await (await handler(request(body))).json();
    expect(second.exportAttemptId).toBe(first.exportAttemptId);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.rowCount).toBe(first.rowCount);
    // The second call's `ensure()` found the existing row (wasCreated:
    // false) rather than inserting a new one, so it must not duplicate
    // either the bulk_export_created event or the per-excluded_stale-entry
    // review_conflict event for an export attempt that only genuinely
    // happened once.
    expect(audits).toHaveLength(2);
    expect(
      audits.filter((a: any) => a.action === "listing.bulk_export_created"),
    ).toHaveLength(1);
    const conflictAudits = audits.filter(
      (a: any) => a.action === "listing.review_conflict",
    );
    expect(conflictAudits).toHaveLength(1);
    expect(conflictAudits[0]).toMatchObject({
      entityId: "listing_changed",
      metadata: { reason: "not_attested" },
    });
  });

  it("writes one review_conflict event per excluded_stale entry when a request has more than one", async () => {
    // freshnessAttested: false makes every import-origin listing excluded
    // for the same, deterministic reason -- unlike listing_stale's
    // call-count-based fixture, this holds steady within a single request
    // regardless of how many listingIds are in it.
    const { handler, audits } = makeHandler();
    const response = await handler(
      request({
        listingIds: ["listing_changed", "listing_noop"],
        freshnessAttested: false,
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.manifest).toEqual([
      {
        listingId: "listing_changed",
        versionId: "version_changed",
        outcome: "excluded_stale",
        reason: "not_attested",
      },
      {
        listingId: "listing_noop",
        versionId: "version_noop",
        outcome: "excluded_stale",
        reason: "not_attested",
      },
    ]);
    expect(audits).toHaveLength(3);
    expect(audits[0].action).toBe("listing.bulk_export_created");
    const conflictAudits = audits.filter(
      (a: any) => a.action === "listing.review_conflict",
    );
    expect(conflictAudits).toHaveLength(2);
    expect(conflictAudits.map((a: any) => a.entityId).sort()).toEqual([
      "listing_changed",
      "listing_noop",
    ]);
    expect(
      conflictAudits.every((a: any) => a.metadata.reason === "not_attested"),
    ).toBe(true);
  });

  it("reports a listing id that does not resolve in the workspace as listing_not_found, with a 200 overall status", async () => {
    const { handler } = makeHandler();
    const response = await handler(
      request({ listingIds: ["listing_missing"], freshnessAttested: true }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.manifest).toEqual([
      {
        listingId: "listing_missing",
        versionId: null,
        outcome: "listing_not_found",
      },
    ]);
  });

  it("rejects a literal duplicate listing id with 400 before touching any deps", async () => {
    const { handler, getDatabaseCalls } = makeHandler();
    const response = await handler(
      request({
        listingIds: ["listing_changed", "listing_changed"],
        freshnessAttested: true,
      }),
    );
    expect(response.status).toBe(400);
    expect(getDatabaseCalls()).toBe(0);
  });

  it("maps a ShoplineBulkFormError (two different listing ids colliding on one remoteProductId) to a 4xx with the issue details, not a 500", async () => {
    const sharedLink: PlatformProductFixture = {
      remoteProductId: "prod-shared",
      rawRow: rawRowFor(),
      origin: "import",
      sourceImportId: "import_1",
      contentDigest: "digest_1",
      connectionId: "conn_1",
    };
    const { handler } = makeHandler({
      reviewSnapshots: {
        listing_dup_a: {
          activeVersion: {
            id: "version_dup_a",
            sequence: 1,
            content: contentFor("新標題"),
          },
        },
        listing_dup_b: {
          activeVersion: {
            id: "version_dup_b",
            sequence: 1,
            content: contentFor("新標題"),
          },
        },
      },
      platformProducts: {
        listing_dup_a: sharedLink,
        listing_dup_b: sharedLink,
      },
    });
    const response = await handler(
      request({
        listingIds: ["listing_dup_a", "listing_dup_b"],
        freshnessAttested: true,
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const body = await response.json();
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(
      body.issues.some((issue: any) => issue.code === "enrichment_duplicate"),
    ).toBe(true);
  });

  it("does not collide the idempotency key across different freshnessAttested values for the same listingIds/versions", async () => {
    const { handler } = makeHandler();
    const body = {
      listingIds: ["listing_changed"],
      freshnessAttested: false,
    };
    const firstResponse = await handler(request(body));
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.rowCount).toBe(0);
    expect(first.manifest).toEqual([
      {
        listingId: "listing_changed",
        versionId: "version_changed",
        outcome: "excluded_stale",
        reason: "not_attested",
      },
    ]);

    const secondResponse = await handler(
      request({ ...body, freshnessAttested: true }),
    );
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json();
    expect(second.exportAttemptId).not.toBe(first.exportAttemptId);
    expect(second.rowCount).toBe(1);
    expect(second.manifest).toEqual([
      {
        listingId: "listing_changed",
        versionId: "version_changed",
        outcome: "included",
      },
    ]);
  });

  it("never writes the export asset when a failure occurs after ensure() but before the transaction resolves", async () => {
    // Simulates an ordinary transient failure (e.g. the audit insert hitting
    // a dropped connection) between `exportAttempts.ensure()` succeeding and
    // the `forWorkspace` callback returning. That failure rolls back the
    // whole transaction, including the row `ensure()` just inserted -- so
    // the asset-store write (which only happens after `forWorkspace`
    // resolves) must never fire. Firing it anyway would orphan an object
    // under a key nothing will ever reference again, since a client retry
    // recomputes the same idempotency key but gets a fresh INSERT (and thus
    // a new export attempt id, and a new asset key) rather than resurrecting
    // the rolled-back row.
    const { handler, assetStore } = makeHandler({ auditWriteThrows: true });
    const response = await handler(
      request({ listingIds: ["listing_changed"], freshnessAttested: true }),
    );
    expect(response.status).toBe(500);
    expect(assetStore.calls).toHaveLength(0);
  });
});
