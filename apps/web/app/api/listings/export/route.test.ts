import { createHash } from "node:crypto";
import { AssetObjectMissingError } from "@wukong/assets";
import type { ReviewConfirmation } from "@wukong/db";
import { readBulkFormSheet } from "@wukong/shopline/bulk-form-xlsx";
import {
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
} from "../../../../lib/review-confirmation-keys";
import {
  BULK_FORM_COLUMNS,
  hashBulkFormHeaderContract,
  hashBulkFormRow,
  isBulkFormRawRow,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
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
  listing?: { id: string; status: string; activeVersionId: string };
  flags?: { severity: string; status: string; field: string; rule: string }[];
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
      provenance: Record<string, unknown> | null;
      artifactSha256: string | null;
      artifactStatus: string | null;
      artifactErrorCode: string | null;
      artifactReadyAt: Date | null;
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
        provenance: input.provenance ?? null,
        artifactSha256: input.artifactSha256 ?? null,
        artifactStatus: input.provenance ? "pending" : null,
        artifactErrorCode: null,
        artifactReadyAt: null,
      };
      store.set(input.idempotencyKey, created);
      return { ...created, wasCreated: true };
    },
    async markReady(input: any) {
      const row = [...store.values()].find(
        (row) =>
          row.id === input.id && row.artifactSha256 === input.artifactSha256,
      )!;
      Object.assign(row, {
        artifactStatus: "ready",
        artifactErrorCode: null,
        artifactReadyAt: new Date(),
      });
      return { ...row };
    },
    async markFailed(input: any) {
      const row = [...store.values()].find(
        (row) =>
          row.id === input.id && row.artifactSha256 === input.artifactSha256,
      )!;
      if (row.artifactStatus !== "ready")
        Object.assign(row, {
          artifactStatus: "failed",
          artifactErrorCode: input.errorCode,
        });
      return { ...row };
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
    missingConfirmations?: boolean;
    confirmationOverrides?: Record<string, Partial<ReviewConfirmation> | null>;
    beforeTransaction?: (repositories: any, call: number) => void;
  } = {},
) {
  const reviewSnapshots = options.reviewSnapshots ?? defaultReviewSnapshots;
  const platformProducts =
    options.platformProducts ?? structuredClone(defaultPlatformProducts);
  for (const link of Object.values(platformProducts)) {
    if (
      link?.contentDigest === "digest_1" &&
      link.rawRow &&
      isBulkFormRawRow(link.rawRow)
    )
      link.contentDigest = hashBulkFormRow(link.rawRow);
  }
  const headerContractSha256 =
    options.headerContractSha256 ?? HEADER_CONTRACT_SHA;
  const audits: any[] = [];
  const exportAttempts = makeExportAttempts();
  // Simulates "the row moved between when createBulkExport looked and when
  // assertExportFreshness verified" for listing_stale, same trick as
  // apps/web/lib/bulk-export-service.test.ts: real link on the first call,
  // mismatched digest on every call after.
  let staleCallCount = 0;

  const sourceSnapshots = Object.entries(platformProducts).flatMap(
    ([listingId, link]) =>
      !link
        ? []
        : [
            {
              id: `snapshot_${listingId}`,
              workspaceId: context.workspaceId,
              listingId,
              sourceImportId: link.sourceImportId,
              connectionId: link.connectionId,
              remoteProductId: link.remoteProductId,
              sourceRowDigest: link.contentDigest,
              rawRow: structuredClone(link.rawRow),
              headerContractSha256: HEADER_CONTRACT_SHA,
              specVersion: SHOPLINE_BULK_FORM_SPEC_VERSION,
            },
          ],
  );
  const receipts = sourceSnapshots.map((snapshot) => ({
    ...snapshot,
    id: `receipt_${snapshot.listingId}`,
    sourceSnapshotId: snapshot.id,
    versionId: reviewSnapshots[snapshot.listingId]?.activeVersion?.id,
    confirmationVersionId:
      reviewSnapshots[snapshot.listingId]?.activeVersion?.id,
    confirmationRevision: 0,
  }));
  const repositories = {
    sourceRows: {
      async getForProduct(input: any) {
        return (
          sourceSnapshots.find(
            (row) =>
              row.sourceImportId === input.sourceImportId &&
              row.connectionId === input.connectionId &&
              row.remoteProductId === input.remoteProductId,
          ) ?? null
        );
      },
    },
    approvalReceipts: {
      async getByVersionId(versionId: string) {
        return receipts.find((row) => row.versionId === versionId) ?? null;
      },
    },
    listings: {
      async lockReviewState() {},
      async getReviewSnapshot(listingId: string) {
        const snapshot = reviewSnapshots[listingId];
        if (!snapshot) return null;
        return {
          listing: {
            id: listingId,
            status: "approved",
            activeVersionId: snapshot.activeVersion?.id,
          },
          flags: [],
          ...snapshot,
        };
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
        if (id === "import_1" || id === "import_2")
          return { headerContractSha256 };
        return null;
      },
    },
    reviewConfirmations: {
      async getByVersionId(versionId: string) {
        if (
          options.missingConfirmations ||
          options.confirmationOverrides?.[versionId] === null
        )
          return null;
        const listingId = Object.keys(reviewSnapshots).find(
          (id) => reviewSnapshots[id]?.activeVersion?.id === versionId,
        )!;
        const link = platformProducts[listingId];
        return {
          id: "confirmation",
          listingId,
          versionId,
          revision: 0,
          fieldConfirmations: Object.fromEntries(
            CONFIRMATION_FIELD_KEYS.map((key) => [key, true]),
          ),
          negativeConfirmations: Object.fromEntries(
            CONFIRMATION_NEGATIVE_KEYS.map((key) => [key, true]),
          ),
          sourceImportId: link?.sourceImportId ?? null,
          rowDigest: link?.contentDigest ?? null,
          ...options.confirmationOverrides?.[versionId],
        };
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
  const objects = new Map<string, Uint8Array>();
  return {
    calls,
    objects,
    async writeObject(
      workspaceId: string,
      key: string,
      body: Uint8Array,
      mimeType: string,
    ) {
      calls.push({ workspaceId, key, body, mimeType });
      objects.set(key, new Uint8Array(body));
      return { size: body.byteLength, mimeType };
    },
    async writeObjectIfAbsent(
      workspaceId: string,
      key: string,
      body: Uint8Array,
      mimeType: string,
    ) {
      if (objects.has(key)) return false;
      await this.writeObject(workspaceId, key, body, mimeType);
      return true;
    },
    async readObject(_workspaceId: string, key: string) {
      const bytes = objects.get(key);
      if (!bytes) throw new AssetObjectMissingError();
      return new Uint8Array(bytes);
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
    missingConfirmations?: boolean;
    confirmationOverrides?: Record<string, Partial<ReviewConfirmation> | null>;
    beforeTransaction?: (repositories: any, call: number) => void;
  } = {},
) {
  const { repositories, audits, exportAttempts } = makeRepositories(options);
  const assetStore = makeAssetStore();
  let getDatabaseCalls = 0;
  let transactionCalls = 0;
  const workspaces: string[] = [];

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
          workspaces.push(_workspaceId);
          options.beforeTransaction?.(repositories, ++transactionCalls);
          return work(repositories);
        },
      };
    },
    getAssetStore: () => assetStore,
  });

  return {
    handler,
    repositories,
    audits,
    assetStore,
    exportAttempts,
    getDatabaseCalls: () => getDatabaseCalls,
    workspaces,
  };
}

describe("POST /api/listings/export", () => {
  it.each([
    ["in_review", [], false, "excluded_unapproved"],
    [
      "approved",
      [
        {
          severity: "blocking",
          status: "open",
          field: "title",
          rule: "unverified_claim",
        },
      ],
      false,
      "excluded_blocked",
    ],
    ["approved", [], true, "excluded_unconfirmed"],
  ] as const)(
    "does not export %s content without current review eligibility (%j)",
    async (status, flags, missingConfirmations, outcome) => {
      const { handler, assetStore, audits, exportAttempts } = makeHandler({
        missingConfirmations,
        reviewSnapshots: {
          listing_changed: {
            ...defaultReviewSnapshots.listing_changed!,
            listing: {
              id: "listing_changed",
              status,
              activeVersionId: "version_changed",
            },
            flags: [...flags],
          },
        },
      });
      const response = await handler(
        request({ listingIds: ["listing_changed"], freshnessAttested: true }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.rowCount).toBe(0);
      expect(body.exportAttemptId).toBeNull();
      expect(body.manifest[0].outcome).toBe(outcome);
      expect(assetStore.calls).toHaveLength(0);
      expect(exportAttempts.ensureCalls).toHaveLength(0);
      expect(audits).toEqual([]);
    },
  );

  it("writes only the eligible changed product in a mixed review selection", async () => {
    const ids = [
      "ready",
      "review",
      "blocked",
      "missing",
      "revoked_field",
      "revoked_negative",
      "noop",
    ];
    const reviewSnapshots = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          listing: {
            id,
            status: id === "review" ? "in_review" : "approved",
            activeVersionId: "version_" + id,
          },
          activeVersion: {
            id: "version_" + id,
            sequence: 1,
            content: contentFor("標題"),
          },
          flags:
            id === "blocked"
              ? [
                  {
                    severity: "blocking",
                    status: "open",
                    field: "title",
                    rule: "unverified_claim",
                  },
                ]
              : [],
        },
      ]),
    );
    const platformProducts = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          ...defaultPlatformProducts[
            id === "noop" ? "listing_noop" : "listing_changed"
          ]!,
          remoteProductId: "product-" + id,
          rawRow: {
            ...defaultPlatformProducts[
              id === "noop" ? "listing_noop" : "listing_changed"
            ]!.rawRow!,
            productId: "product-" + id,
          },
        },
      ]),
    );
    const { handler, assetStore, audits, workspaces } = makeHandler({
      reviewSnapshots,
      platformProducts,
      confirmationOverrides: {
        version_missing: null,
        version_revoked_field: { fieldConfirmations: {} },
        version_revoked_negative: {
          negativeConfirmations: { priceUnchanged: false },
        },
      },
    });
    const response = await handler(
      request({ listingIds: ids, freshnessAttested: true }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rowCount).toBe(1);
    expect(
      body.manifest.map((entry: any) => [entry.listingId, entry.outcome]),
    ).toEqual([
      ["blocked", "excluded_blocked"],
      ["missing", "excluded_unconfirmed"],
      ["noop", "excluded_no_op"],
      ["ready", "included"],
      ["review", "excluded_unapproved"],
      ["revoked_field", "excluded_unconfirmed"],
      ["revoked_negative", "excluded_unconfirmed"],
    ]);
    expect(assetStore.calls).toHaveLength(1);
    const sheet = readBulkFormSheet(assetStore.calls[0].body);
    const productColumn = BULK_FORM_COLUMNS.findIndex(
      (column) => column.key === "productId",
    );
    expect(sheet.slice(2).map((row) => row[productColumn])).toEqual([
      "product-ready",
    ]);
    expect(audits[0].metadata.includedListingIds).toEqual(["ready"]);
    expect(audits[0].metadata.excludedListingIds).toEqual(ids.slice(1).sort());
    expect(workspaces).toEqual([
      context.workspaceId,
      context.workspaceId,
      context.workspaceId,
    ]);
  });

  it.each([
    ["version", "version_mismatch"],
    ["status", "approval_required"],
    ["flags", "blocking_flags"],
    ["revocation", "confirmation_required"],
    ["revision", "confirmation_changed"],
    ["source", "source_import_mismatch"],
    ["digest", "row_digest_mismatch"],
    ["remote", "remote_link_changed"],
    ["connection", "remote_link_changed"],
    ["origin", "not_import_origin"],
    ["header", "header_contract_stale"],
  ])(
    "rejects %s drift at the final transaction before attempt, audit or upload",
    async (change, reason) => {
      const { handler, assetStore, audits, exportAttempts } = makeHandler({
        beforeTransaction(repositories, call) {
          if (call !== 2) return;
          const readSnapshot = repositories.listings.getReviewSnapshot;
          repositories.listings.getReviewSnapshot = async (id: string) => {
            const snapshot = await readSnapshot(id);
            if (change === "version")
              snapshot.listing = {
                ...snapshot.listing,
                activeVersionId: "version_new",
              };
            if (change === "status")
              snapshot.listing = { ...snapshot.listing, status: "in_review" };
            if (change === "flags")
              snapshot.flags = [
                {
                  severity: "blocking",
                  status: "open",
                  field: "title",
                  rule: "unverified_claim",
                },
              ];
            return snapshot;
          };
          const readConfirmation =
            repositories.reviewConfirmations.getByVersionId;
          repositories.reviewConfirmations.getByVersionId = async (
            id: string,
          ) => {
            const confirmation = await readConfirmation(id);
            if (change === "revocation")
              confirmation.fieldConfirmations.nameZh = false;
            if (change === "revision") confirmation.revision += 1;
            return confirmation;
          };
          const readLink = repositories.platformProducts.getByListingId;
          repositories.platformProducts.getByListingId = async (id: string) => {
            const link = { ...(await readLink(id)) };
            if (change === "source") link.sourceImportId = "new_import";
            if (change === "digest") link.contentDigest = "new_digest";
            if (change === "remote") link.remoteProductId = "different_product";
            if (change === "connection") link.connectionId = "different_store";
            if (change === "origin") link.origin = "created";
            return link;
          };
          if (change === "header")
            repositories.sourceImports.getById = async () => ({
              headerContractSha256: "changed",
            });
        },
      });
      const response = await handler(
        request({ listingIds: ["listing_changed"], freshnessAttested: true }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "export_eligibility_changed",
        rowCount: 0,
        manifest: [{ reason }],
      });
      expect(assetStore.calls).toEqual([]);
      expect(exportAttempts.ensureCalls).toEqual([]);
      expect(audits).toEqual([]);
    },
  );

  it("reuses an eligible attempt and writes the same bytes without duplicate success events", async () => {
    const { handler, assetStore, audits } = makeHandler();
    const payload = {
      listingIds: ["listing_changed", "listing_noop"],
      freshnessAttested: true,
    };
    const first = await (await handler(request(payload))).json();
    const second = await (await handler(request(payload))).json();
    expect(first.rowCount).toBe(1);
    expect(second).toEqual(first);
    expect(assetStore.calls).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it("records a new manifest when a formerly eligible row becomes blocked", async () => {
    const snapshots = structuredClone(defaultReviewSnapshots);
    const { handler, assetStore } = makeHandler({ reviewSnapshots: snapshots });
    // Give both selected rows a content change.
    snapshots.listing_noop!.activeVersion!.content = contentFor("更新內容");
    const payload = {
      listingIds: ["listing_changed", "listing_noop"],
      freshnessAttested: true,
    };
    const first = await (await handler(request(payload))).json();
    snapshots.listing_noop!.flags = [
      {
        severity: "blocking",
        status: "open",
        field: "title",
        rule: "new_blocker",
      },
    ];
    const response = await handler(request(payload));
    expect(response.status).toBe(200);
    const second = await response.json();
    expect(first.rowCount).toBe(2);
    expect(second.rowCount).toBe(1);
    expect(second.exportAttemptId).not.toBe(first.exportAttemptId);
    expect(second.manifest[1].outcome).toBe("excluded_blocked");
    expect(readBulkFormSheet(assetStore.calls[1].body).slice(2)).toHaveLength(
      1,
    );
  });

  it("does not create an empty downloadable workbook for an all-no-op request", async () => {
    const { handler, assetStore, audits, exportAttempts } = makeHandler();
    const response = await handler(
      request({ listingIds: ["listing_noop"], freshnessAttested: true }),
    );
    expect(await response.json()).toMatchObject({
      rowCount: 0,
      exportAttemptId: null,
      manifest: [{ outcome: "excluded_no_op" }],
    });
    expect(assetStore.calls).toEqual([]);
    expect(exportAttempts.ensureCalls).toEqual([]);
    expect(audits).toEqual([]);
  });

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

  it("repeats an all-excluded request without creating an attempt or success audit", async () => {
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
    expect(first.exportAttemptId).toBeNull();
    expect(audits).toEqual([]);
  });

  it("returns every stale exclusion without creating a successful export", async () => {
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
    expect(body.exportAttemptId).toBeNull();
    expect(audits).toEqual([]);
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
        listing_dup_b: { ...sharedLink, sourceImportId: "import_2" },
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

describe("durable artifact creation", () => {
  it("commits canonical provenance and a hash of exactly the downloadable rows", async () => {
    const { handler, assetStore, exportAttempts } = makeHandler();
    const first = await (
      await handler(
        request({
          listingIds: ["listing_noop", "listing_changed"],
          freshnessAttested: true,
        }),
      )
    ).json();
    const repeat = await (
      await handler(
        request({
          listingIds: ["listing_changed", "listing_noop"],
          freshnessAttested: true,
        }),
      )
    ).json();
    expect(repeat.exportAttemptId).toBe(first.exportAttemptId);
    expect(assetStore.calls).toHaveLength(1);
    const attempt = await exportAttempts.getById(first.exportAttemptId);
    expect(attempt?.artifactStatus).toBe("ready");
    expect(attempt?.artifactSha256).toBe(
      createHash("sha256").update(assetStore.calls[0].body).digest("hex"),
    );
    expect(attempt?.provenance).toMatchObject({
      identityVersion: 1,
      headerContractSha256: HEADER_CONTRACT_SHA,
      rowOrder: ["listing_changed"],
    });
  });
  it("records upload failure then recovers the same committed artifact", async () => {
    const { handler, assetStore, exportAttempts } = makeHandler();
    const original = assetStore.writeObjectIfAbsent.bind(assetStore);
    assetStore.writeObjectIfAbsent = async () => {
      throw new Error("upload unavailable");
    };
    const payload = {
      listingIds: ["listing_changed"],
      freshnessAttested: true,
    };
    const response = await handler(request(payload));
    expect(response.status).toBe(503);
    const failure = await response.json();
    expect(
      (await exportAttempts.getById(failure.exportAttemptId))?.artifactStatus,
    ).toBe("failed");
    assetStore.writeObjectIfAbsent = original;
    const recovered = await (await handler(request(payload))).json();
    expect(recovered.exportAttemptId).toBe(failure.exportAttemptId);
    expect(
      (await exportAttempts.getById(recovered.exportAttemptId))?.artifactStatus,
    ).toBe("ready");
  });
  it("does not replace corrupted stored bytes on retry", async () => {
    const { handler, assetStore } = makeHandler();
    const payload = {
      listingIds: ["listing_changed"],
      freshnessAttested: true,
    };
    await handler(request(payload));
    const key = assetStore.calls[0].key;
    const corrupt = new Uint8Array([9]);
    assetStore.objects.set(key, corrupt);
    const response = await handler(request(payload));
    expect(response.status).toBe(409);
    expect(assetStore.calls).toHaveLength(1);
    expect(assetStore.objects.get(key)).toEqual(corrupt);
  });
  it("recovers uploaded bytes after the readiness transaction fails", async () => {
    let failReady = true;
    const { handler, assetStore, exportAttempts } = makeHandler({
      beforeTransaction: (repos, call) => {
        if (call === 3 && failReady) {
          failReady = false;
          throw new Error("commit unavailable");
        }
      },
    });
    const payload = {
      listingIds: ["listing_changed"],
      freshnessAttested: true,
    };
    expect((await handler(request(payload))).status).toBe(503);
    const recovered = await (await handler(request(payload))).json();
    expect(
      (await exportAttempts.getById(recovered.exportAttemptId))?.artifactStatus,
    ).toBe("ready");
    expect(assetStore.calls).toHaveLength(1);
  });
});

it("a renewed durable approval gets a new artifact identity while preserving earlier bytes", async () => {
  const { handler, repositories, assetStore, exportAttempts } = makeHandler();
  const payload = { listingIds: ["listing_changed"], freshnessAttested: true };
  const first = await (await handler(request(payload))).json();
  const readReceipt = repositories.approvalReceipts.getByVersionId;
  repositories.approvalReceipts.getByVersionId = async (versionId) => {
    const receipt = await readReceipt(versionId);
    return receipt ? { ...receipt, id: "renewed-receipt" } : null;
  };
  const second = await (await handler(request(payload))).json();
  expect(second.exportAttemptId).not.toBe(first.exportAttemptId);
  expect(assetStore.calls).toHaveLength(2);
  expect(assetStore.calls[1].body).toEqual(assetStore.calls[0].body);
  const earlier = await exportAttempts.getById(first.exportAttemptId);
  expect((earlier?.provenance?.evidence as any[])[0].approvalReceiptId).toBe(
    "receipt_listing_changed",
  );
});

it("fresh source evidence and approval create a new attempt without replacing the earlier artifact", async () => {
  const products = structuredClone(defaultPlatformProducts);
  const { handler, repositories, assetStore, exportAttempts } = makeHandler({
    platformProducts: products,
  });
  const payload = { listingIds: ["listing_changed"], freshnessAttested: true };
  const first = await (await handler(request(payload))).json();
  const oldBytes = new Uint8Array(assetStore.calls[0].body);
  const oldReceipt =
    await repositories.approvalReceipts.getByVersionId("version_changed");
  const oldSnapshot = await repositories.sourceRows.getForProduct({
    sourceImportId: "import_1",
    connectionId: "conn_1",
    remoteProductId: "prod-changed",
  });
  products.listing_changed!.sourceImportId = "import_2";
  products.listing_changed!.rawRow = rawRowFor({
    slKey1: "new locked source value",
  });
  const newRaw = products.listing_changed!.rawRow!;
  if (!isBulkFormRawRow(newRaw)) throw new Error("invalid fixture");
  products.listing_changed!.contentDigest = hashBulkFormRow(newRaw);
  const snapshot = {
    ...oldSnapshot!,
    id: "renewed-snapshot",
    sourceImportId: "import_2",
    rawRow: structuredClone(products.listing_changed!.rawRow),
    sourceRowDigest: products.listing_changed!.contentDigest,
  };
  repositories.sourceRows.getForProduct = async () => snapshot;
  repositories.approvalReceipts.getByVersionId = async () => ({
    ...oldReceipt!,
    sourceSnapshotId: snapshot.id,
    sourceImportId: "import_2",
    sourceRowDigest: snapshot.sourceRowDigest,
    id: "renewed-receipt",
  });
  const second = await (await handler(request(payload))).json();
  expect(second.exportAttemptId).not.toBe(first.exportAttemptId);
  expect(second.rowCount).toBe(1);
  expect(assetStore.calls).toHaveLength(2);
  expect(assetStore.objects.get(assetStore.calls[0].key)).toEqual(oldBytes);
  expect(
    (await exportAttempts.getById(first.exportAttemptId))?.artifactSha256,
  ).not.toBe(
    (await exportAttempts.getById(second.exportAttemptId))?.artifactSha256,
  );
});
