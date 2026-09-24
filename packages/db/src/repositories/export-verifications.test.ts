import { expect, it } from "vitest";
import { exportVerificationIdentity } from "./export-verifications.js";
const input = {
  exportAttemptId: "attempt",
  artifactSha256: "a".repeat(64),
  suppliedSha256: "b".repeat(64),
  merchantAttestedExportAt: new Date("2026-09-05T01:00:00Z"),
  connectionId: "store",
  policyVersion: "fresh-export-v1" as const,
};
it("deterministically identifies evidence independently of filename and actor", () => {
  expect(exportVerificationIdentity(input)).toBe(
    exportVerificationIdentity({ ...input }),
  );
  for (const changed of [
    { exportAttemptId: "other" },
    { artifactSha256: "c".repeat(64) },
    { suppliedSha256: "c".repeat(64) },
    { merchantAttestedExportAt: new Date("2026-09-05T01:00:01Z") },
    { connectionId: "other" },
    { policyVersion: "future" },
  ])
    expect(exportVerificationIdentity({ ...input, ...changed })).not.toBe(
      exportVerificationIdentity(input),
    );
});
