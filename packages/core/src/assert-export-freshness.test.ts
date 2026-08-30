import { describe, expect, it } from "vitest";

import {
  assertExportFreshness,
  type AssertExportFreshnessDeps,
  type AssertExportFreshnessInput,
} from "./assert-export-freshness.js";

const BASE_INPUT: AssertExportFreshnessInput = {
  workspaceId: "ws_opak",
  listingId: "listing_1",
  expectedSourceImportId: "source_import_1",
  expectedRowDigest: "digest_1",
  expectedVersionId: "version_1",
  freshnessAttested: true,
};

function depsWith(
  overrides: Partial<AssertExportFreshnessDeps> = {},
): AssertExportFreshnessDeps {
  return {
    async getPlatformProductLink() {
      return { sourceImportId: "source_import_1", contentDigest: "digest_1" };
    },
    async getActiveVersionId() {
      return "version_1";
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

describe("assertExportFreshness", () => {
  it("succeeds when every check agrees", async () => {
    const result = await assertExportFreshness(BASE_INPUT, depsWith());
    expect(result).toEqual({ ok: true });
  });

  it("rejects when freshness was not attested, before checking anything else", async () => {
    const result = await assertExportFreshness(
      { ...BASE_INPUT, freshnessAttested: false },
      depsWith({
        async getPlatformProductLink() {
          throw new Error("must not be called");
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "not_attested" });
  });

  it("rejects when the listing has no remote product link", async () => {
    const result = await assertExportFreshness(
      BASE_INPUT,
      depsWith({ async getPlatformProductLink() { return null; } }),
    );
    expect(result).toEqual({ ok: false, reason: "no_remote_link" });
  });

  it("rejects when the link's source import id does not match", async () => {
    const result = await assertExportFreshness(
      BASE_INPUT,
      depsWith({
        async getPlatformProductLink() {
          return { sourceImportId: "source_import_other", contentDigest: "digest_1" };
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "source_import_mismatch" });
  });

  it("rejects when the link's content digest does not match", async () => {
    const result = await assertExportFreshness(
      BASE_INPUT,
      depsWith({
        async getPlatformProductLink() {
          return { sourceImportId: "source_import_1", contentDigest: "stale_digest" };
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "row_digest_mismatch" });
  });

  it("rejects when the listing's active version has moved on", async () => {
    const result = await assertExportFreshness(
      BASE_INPUT,
      depsWith({ async getActiveVersionId() { return "version_other"; } }),
    );
    expect(result).toEqual({ ok: false, reason: "version_mismatch" });
  });

  it("rejects when the stored header contract no longer matches the current one", async () => {
    const result = await assertExportFreshness(
      BASE_INPUT,
      depsWith({ currentHeaderContractSha256: () => "contract_new" }),
    );
    expect(result).toEqual({ ok: false, reason: "header_contract_stale" });
  });
});
