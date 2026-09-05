// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceReadinessSummary } from "./source-readiness-summary";
const base = {
  sourceImportId: "import-1",
  merchantAttestedExportAt: "2026-09-05T04:00:00.000Z",
  currentVersionId: "version-1",
  reviewedBinding: {
    versionId: "version-1",
    sourceImportId: "import-1",
    rowDigest: "digest",
    revision: 3,
  },
  approvedBinding: null,
  headerContractCurrent: true,
  freshnessAttested: false as const,
  eligible: false as const,
  eligibleAfterAttestation: true,
  reason: "not_attested" as const,
  downstreamVerification: "unverified" as const,
  scope: "advisory_current_read" as const,
};
describe("SourceReadinessSummary", () => {
  it("shows eligible-after-attestation as advisory and 未經核實", () => {
    const html = renderToStaticMarkup(
      createElement(SourceReadinessSummary, { readiness: base }),
    );
    expect(html).toContain("來源可供資格檢查");
    expect(html).toContain("修訂 3");
    expect(html).toContain("尚未確認時效");
    expect(html).toContain("未經核實");
  });
  it("shows ineligible and unknown states without claiming readiness", () => {
    const ineligible = renderToStaticMarkup(
      createElement(SourceReadinessSummary, {
        readiness: {
          ...base,
          sourceImportId: null,
          merchantAttestedExportAt: null,
          reviewedBinding: null,
          eligibleAfterAttestation: false,
          reason: "no_remote_link",
        },
      }),
    );
    expect(ineligible).toContain("來源需要處理");
    expect(ineligible).toContain("未有資料");
    expect(
      renderToStaticMarkup(createElement(SourceReadinessSummary, {})),
    ).toContain("來源準備狀態不明");
  });
});
