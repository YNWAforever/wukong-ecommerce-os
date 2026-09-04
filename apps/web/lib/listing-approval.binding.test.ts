import { describe, expect, it } from "vitest";
import {
  BULK_FORM_COLUMNS,
  hashBulkFormRow,
  hashBulkFormHeaderContract,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
} from "@wukong/shopline";
import { approveOne } from "./listing-approval";
import {
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
} from "./review-confirmation-keys";

function fixture() {
  const calls: string[] = [],
    receipts: unknown[] = [];
  const rawRow = Object.fromEntries(
    BULK_FORM_COLUMNS.map((column) => [
      column.key,
      column.key === "productId" ? "remote-1" : "",
    ]),
  );
  const digest = hashBulkFormRow(rawRow as never);
  const sourceRow = {
    id: "snapshot-1",
    listingId: "listing-1",
    connectionId: "connection-1",
    sourceImportId: "import-1",
    remoteProductId: "remote-1",
    rawRow: structuredClone(rawRow),
    sourceRowDigest: digest,
    headerContractSha256: hashBulkFormHeaderContract(),
    specVersion: SHOPLINE_BULK_FORM_SPEC_VERSION,
    createdAt: new Date(),
  };
  const link = {
    ...sourceRow,
    origin: "import",
    contentDigest: digest,
    specVersion: sourceRow.specVersion,
    rawRow,
  };
  const confirmation = {
    listingId: "listing-1",
    versionId: "version-1",
    revision: 2,
    sourceImportId: "import-1",
    rowDigest: digest,
    fieldConfirmations: Object.fromEntries(
      CONFIRMATION_FIELD_KEYS.map((key) => [key, true]),
    ),
    negativeConfirmations: Object.fromEntries(
      CONFIRMATION_NEGATIVE_KEYS.map((key) => [key, true]),
    ),
  };
  const repos = {
    listings: {
      async lockReviewState() {
        calls.push("lock");
      },
      async getReviewSnapshot() {
        calls.push("read");
        return {
          listing: {
            id: "listing-1",
            status: "in_review",
            target: "shopline",
            activeVersionId: "version-1",
          },
          activeVersion: { id: "version-1", content: { imageAssetIds: [] } },
          flags: [],
          evidence: [],
        };
      },
      async approve() {
        calls.push("approve");
      },
      async appendVersion() {
        return { id: "version-final" };
      },
      async promoteAndApprove() {
        calls.push("promote");
      },
      async replaceEvidence() {},
      async replaceFlags() {},
    },
    reviewConfirmations: {
      async getByVersionId() {
        return confirmation;
      },
    },
    platformProducts: {
      async getByListingId() {
        return link;
      },
    },
    sourceRows: {
      async getForProduct(): Promise<typeof sourceRow | null> {
        return sourceRow;
      },
    },
    approvalReceipts: {
      async record(input: unknown) {
        calls.push("receipt");
        receipts.push(input);
        return { id: "receipt-1", wasCreated: true };
      },
    },
    sourceAssets: {
      async create() {
        return { id: "asset-final" };
      },
      async attachToListing() {},
    },
    audit: {
      async write(event: { action: string }) {
        calls.push(event.action);
      },
    },
  };
  const context = {
    workspaceId: "workspace-1",
    actorId: "reviewer-1",
    entityId: "listing-1",
  };
  const deps = {
    expectedVersionId: "version-1",
    confirmationLedgerRevision: 2,
    sourceImportId: "import-1",
    expectedRowDigest: digest,
  };
  return { repos, context, deps, calls, receipts, sourceRow, link };
}

describe("durable Bulk Update approval binding", () => {
  it("locks review state before reading and records the exact approved source and checklist", async () => {
    const { repos, context, deps, calls, receipts } = fixture();
    await approveOne("listing-1", context, repos as never, deps);
    expect(calls.slice(0, 2)).toEqual(["lock", "read"]);
    expect(receipts).toEqual([
      {
        listingId: "listing-1",
        versionId: "version-1",
        sourceSnapshotId: "snapshot-1",
        confirmationVersionId: "version-1",
        confirmationRevision: 2,
        approvedBy: "reviewer-1",
      },
    ]);
    expect(calls.indexOf("receipt")).toBeGreaterThan(calls.indexOf("approve"));
    expect(calls).toContain("listing.bulk_update_approval_bound");
  });
  it("requires a historical source row even when current source and confirmations match", async () => {
    const { repos, context, deps, calls } = fixture();
    repos.sourceRows.getForProduct = async () => null;
    await expect(
      approveOne("listing-1", context, repos as never, deps),
    ).rejects.toMatchObject({ code: "source_snapshot_required" });
    expect(calls).not.toContain("approve");
  });
  it.each([
    "rawRow",
    "sourceRowDigest",
    "connectionId",
    "remoteProductId",
    "listingId",
    "sourceImportId",
    "headerContractSha256",
    "specVersion",
  ])("rejects a changed source snapshot %s before approval", async (key) => {
    const { repos, context, deps, sourceRow, calls } = fixture();
    if (key === "rawRow") sourceRow.rawRow.regularPrice = "500";
    else Object.assign(sourceRow, { [key]: "changed" });
    await expect(
      approveOne("listing-1", context, repos as never, deps),
    ).rejects.toMatchObject({ code: "source_snapshot_required" });
    expect(calls).not.toContain("approve");
  });
  it("rejects pass-through mirror drift concealed by an old digest", async () => {
    const { repos, context, deps, link } = fixture();
    link.rawRow.regularPrice = "500";
    await expect(
      approveOne("listing-1", context, repos as never, deps),
    ).rejects.toMatchObject({ code: "source_snapshot_required" });
  });
  it("binds a promoted product-shot version to the actual reviewed confirmation version", async () => {
    const { repos, context, deps, receipts } = fixture();
    await approveOne("listing-1", context, repos as never, {
      ...deps,
      precomputedFinalAsset: {
        storageKey: "synthetic-key",
        priorFinalAssetIds: [],
      },
    });
    expect(receipts).toEqual([
      expect.objectContaining({
        versionId: "version-final",
        confirmationVersionId: "version-1",
      }),
    ]);
  });
});
