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
  it("shows eligible-after-attestation as advisory and unverified", () => {
    const html = renderToStaticMarkup(
      createElement(SourceReadinessSummary, { readiness: base }),
    );
    expect(html).toContain("Source ready for eligibility check");
    expect(html).toContain("revision 3");
    expect(html).toContain("Freshness is not attested");
    expect(html).toContain("unverified");
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
    expect(ineligible).toContain("Source action required");
    expect(ineligible).toContain("not available");
    expect(
      renderToStaticMarkup(createElement(SourceReadinessSummary, {})),
    ).toContain("Source readiness unknown");
  });
});
