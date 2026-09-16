import { expect, it } from "vitest";
import { wineIdentity } from "@wukong/core";
import { parseWineStageResult } from "./wine-enrichment-pipeline.js";
const extraction = {
  schemaVersion: 1,
  state: "succeeded",
  stage: "extraction",
  observedAt: "2026-09-16T00:00:00.000Z",
  identity: wineIdentity(),
  evidence: [],
  issues: [],
};
it("validates exact stage binding and rejects unknown output fields", () => {
  expect(() =>
    parseWineStageResult(
      { ...extraction, workspaceId: "override" },
      "extraction",
    ),
  ).toThrow();
  expect(() => parseWineStageResult(extraction, "generation")).toThrow();
});
it("does not accept raw model deep-search intent without bounded deterministic reasons", () => {
  const verification = {
    schemaVersion: 1,
    state: "succeeded",
    stage: "verification",
    identity: wineIdentity(),
    claims: [],
    needsDeepSearch: true,
    deepSearchReasons: [],
    issues: [],
  };
  expect(() => parseWineStageResult(verification, "verification")).toThrow();
  expect(() =>
    parseWineStageResult(
      { ...verification, deepSearchReasons: ["optional_copy"] },
      "verification",
    ),
  ).toThrow();
  expect(
    parseWineStageResult(
      { ...verification, deepSearchReasons: ["core_fact_gap"] },
      "verification",
    ),
  ).toMatchObject({ needsDeepSearch: true });
});
it("freezes returned checkpoint data by copying provider-owned references", () => {
  const value = structuredClone(extraction);
  const result = parseWineStageResult(value, "extraction");
  value.identity.producer = "changed";
  expect(result).toMatchObject({ identity: { producer: "Fixture Estate" } });
});
it("unknown outcomes have a bounded sanitized code and no arbitrary provider payload", () => {
  expect(() =>
    parseWineStageResult(
      {
        schemaVersion: 1,
        state: "unknown",
        stage: "extraction",
        code: "x".repeat(129),
      },
      "extraction",
    ),
  ).toThrow();
  expect(() =>
    parseWineStageResult(
      {
        schemaVersion: 1,
        state: "unknown",
        stage: "extraction",
        code: "failed",
        response: "private",
      },
      "extraction",
    ),
  ).toThrow();
});
it("complete projection requires a version coordinate", () => {
  expect(() =>
    parseWineStageResult(
      {
        schemaVersion: 1,
        state: "succeeded",
        stage: "commit_candidate",
        outcome: "complete",
        versionId: null,
      },
      "commit_candidate",
    ),
  ).toThrow();
});
it("projection version coordinates must be genuine UUIDs", () => {
  expect(() =>
    parseWineStageResult(
      {
        schemaVersion: 1,
        state: "succeeded",
        stage: "commit_candidate",
        outcome: "complete",
        versionId: "-".repeat(36),
      },
      "commit_candidate",
    ),
  ).toThrow();
});
it("requires exact server observation timestamp even for empty extraction", () => {
  expect(parseWineStageResult(extraction, "extraction")).toMatchObject({
    observedAt: extraction.observedAt,
  });
  for (const observedAt of [
    undefined,
    "yesterday",
    "2026-02-30T00:00:00.000Z",
    "2026-09-16T00:00:00+08:00",
  ])
    expect(() =>
      parseWineStageResult({ ...extraction, observedAt }, "extraction"),
    ).toThrow();
});
