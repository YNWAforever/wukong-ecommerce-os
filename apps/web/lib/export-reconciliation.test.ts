import { it, expect } from "vitest";
import {
  buildExportReconciliation,
  resultCapabilities,
} from "./export-reconciliation";
const attempt: any = {
  id: "a",
  manifest: [
    { listingId: "one", versionId: "v1", outcome: "included" },
    { listingId: "two", versionId: "v2", outcome: "included" },
    { listingId: "three", versionId: "v3", outcome: "included" },
    { listingId: "noop", versionId: "v4", outcome: "excluded_no_op" },
    { listingId: "excluded", versionId: null, outcome: "excluded_unapproved" },
  ],
};
it("counts latest operator reports over included versions only and preserves correction order", () => {
  const result = buildExportReconciliation(attempt, [
    {
      id: "first",
      listingId: "one",
      versionId: "v1",
      mode: "export",
      exportAttemptId: "a",
      outcome: "accepted",
      revision: 1,
    },
    {
      id: "second",
      listingId: "one",
      versionId: "v1",
      mode: "export",
      exportAttemptId: "a",
      outcome: "rejected",
      revision: 2,
    },
    {
      id: "two",
      listingId: "two",
      versionId: "v2",
      mode: "export",
      exportAttemptId: "a",
      outcome: "accepted",
      revision: 1,
    },
    {
      id: "legacy",
      listingId: "three",
      exportAttemptId: "a",
      mode: "legacy_historical",
      outcome: "accepted",
    },
    {
      id: "manual",
      listingId: "three",
      versionId: "v3",
      exportAttemptId: null,
      mode: "historical_manual",
      outcome: "accepted",
    },
  ] as any);
  expect(result.counts).toEqual({
    requested: 5,
    included: 3,
    noOp: 1,
    excluded: 1,
    accepted: 1,
    rejected: 1,
    unreported: 1,
  });
  expect(result.members[0]?.history.map((x) => x.id)).toEqual([
    "second",
    "first",
  ]);
  expect(result.verificationStatus).toBe("unverified");
});
it("derives separate generation and recording capabilities from server role", () => {
  expect(resultCapabilities("viewer")).toEqual({
    canGenerateBulkUpdate: false,
    canRecordImportResult: false,
  });
  expect(resultCapabilities("operator")).toEqual({
    canGenerateBulkUpdate: false,
    canRecordImportResult: true,
  });
  expect(resultCapabilities("reviewer")).toEqual({
    canGenerateBulkUpdate: true,
    canRecordImportResult: true,
  });
});
