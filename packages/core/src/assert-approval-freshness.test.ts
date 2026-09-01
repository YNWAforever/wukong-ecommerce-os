import { describe, expect, it } from "vitest";

import {
  assertApprovalFreshness,
  type AssertApprovalFreshnessDeps,
  type AssertApprovalFreshnessInput,
} from "./assert-approval-freshness.js";

const BASE_INPUT: AssertApprovalFreshnessInput = {
  workspaceId: "ws_opak",
  listingId: "listing_1",
  expectedSourceImportId: "source_import_1",
  expectedRowDigest: "digest_1",
  expectedVersionId: "version_1",
};

function depsWith(
  overrides: Partial<AssertApprovalFreshnessDeps> = {},
): AssertApprovalFreshnessDeps {
  return {
    async getPlatformProductLink() {
      return { sourceImportId: "source_import_1", contentDigest: "digest_1" };
    },
    async getActiveVersionId() {
      return "version_1";
    },
    ...overrides,
  };
}

describe("assertApprovalFreshness", () => {
  it("succeeds when every check agrees", async () => {
    const result = await assertApprovalFreshness(BASE_INPUT, depsWith());
    expect(result).toEqual({ ok: true });
  });

  it("rejects when the listing has no remote product link", async () => {
    const result = await assertApprovalFreshness(
      BASE_INPUT,
      depsWith({
        async getPlatformProductLink() {
          return null;
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "no_remote_link" });
  });

  it("rejects when the link's source import id does not match", async () => {
    const result = await assertApprovalFreshness(
      BASE_INPUT,
      depsWith({
        async getPlatformProductLink() {
          return {
            sourceImportId: "source_import_other",
            contentDigest: "digest_1",
          };
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "source_import_mismatch" });
  });

  it("rejects when the link's content digest does not match", async () => {
    const result = await assertApprovalFreshness(
      BASE_INPUT,
      depsWith({
        async getPlatformProductLink() {
          return {
            sourceImportId: "source_import_1",
            contentDigest: "stale_digest",
          };
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "row_digest_mismatch" });
  });

  it("rejects when the listing's active version has moved on", async () => {
    const result = await assertApprovalFreshness(
      BASE_INPUT,
      depsWith({
        async getActiveVersionId() {
          return "version_other";
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "version_mismatch" });
  });
});
