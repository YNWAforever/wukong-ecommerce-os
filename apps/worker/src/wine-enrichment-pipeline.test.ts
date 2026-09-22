import { listingInputDigest } from "@wukong/db";
import { expect, it } from "vitest";
import { wineIdentity, emptyWorkingListing } from "@wukong/core";
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
it("accepts only strict server cache provenance on search results", () => {
  const basic = {
    schemaVersion: 1,
    state: "succeeded",
    stage: "search_basic",
    evidence: [],
    partial: false,
    issues: [],
    cacheOrigin: {
      schemaVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      snapshotId: "00000000-0000-4000-8000-000000000002",
    },
  };
  expect(parseWineStageResult(basic, "search_basic")).toEqual(basic);
  for (const cacheOrigin of [
    { ...basic.cacheOrigin, forceRefresh: false },
    { ...basic.cacheOrigin, runId: "invalid" },
    { ...basic.cacheOrigin, schemaVersion: 2 },
  ])
    expect(() =>
      parseWineStageResult({ ...basic, cacheOrigin }, "search_basic"),
    ).toThrow();
  expect(() =>
    parseWineStageResult(
      { ...extraction, cacheOrigin: basic.cacheOrigin },
      "extraction",
    ),
  ).toThrow();
});

const frozenGeneration = () => {
  const content = {
    title: { en: "Fixture", "zh-Hant": "測試" },
    sections: [],
    seo: {
      title: { en: "", "zh-Hant": "" },
      description: { en: "", "zh-Hant": "" },
    },
    tags: [],
  };
  return {
    schemaVersion: 1,
    state: "succeeded",
    stage: "generation",
    content,
    issues: [],
    frozenQuality: {
      schemaVersion: 1,
      request: {
        schemaVersion: 1,
        binding: {
          workspaceId: "fixture",
          operationId: "fixture",
          inputRevision: 0,
        },
        claims: [],
        current: null,
        lockedPaths: ["tags"],
        tone: "neutral",
        claimPolicy: [],
        section: null,
      },
      candidate: {
        schemaVersion: 1,
        content: structuredClone(content),
        annotations: [
          {
            path: "title.en",
            span: "Fixture",
            claimId: "00000000-0000-4000-8000-000000000001",
            value: "Fixture",
            evidenceIds: ["00000000-0000-4000-8000-000000000002"],
            premiseClaimIds: [],
          },
        ],
      },
    },
  };
};
it("preserves complete frozen quality request and annotations without shared references", () => {
  const value = frozenGeneration();
  const parsed = parseWineStageResult(value, "generation");
  expect(parsed).toEqual(value);
  value.frozenQuality.candidate.annotations[0]!.span = "mutated";
  value.frozenQuality.request.lockedPaths.push("title");
  expect(parsed).not.toEqual(value);
});
it("rejects malformed frozen quality wrapper, request, candidate and content mismatch", () => {
  for (const alter of [
    (x: any) => {
      x.frozenQuality.extra = true;
    },
    (x: any) => {
      x.frozenQuality.schemaVersion = 2;
    },
    (x: any) => {
      x.frozenQuality.request.claimedAuthority = true;
    },
    (x: any) => {
      x.frozenQuality.candidate.accepted = true;
    },
    (x: any) => {
      x.frozenQuality.candidate.annotations[0].claimId = "invalid";
    },
    (x: any) => {
      x.frozenQuality.candidate.content.title.en = "different";
    },
  ]) {
    const value = frozenGeneration();
    alter(value);
    expect(() => parseWineStageResult(value, "generation")).toThrow();
  }
});
it("frozen verification parsing copies exact context and rejects added trusted fields", () => {
  const frozen = {
    schemaVersion: 1,
    binding: { workspaceId: "ws", operationId: "run", inputRevision: 1 },
    identity: wineIdentity(),
    sources: [],
    supports: [],
    authorities: [],
    reliableSourceIds: [],
    trustedObservationSourceIds: [],
    acceptedPremises: [],
    verifiedAliases: [],
    lockedFields: ["title.en"],
    now: "2026-09-16T00:00:00.000Z",
  };
  const value = {
    schemaVersion: 1,
    state: "succeeded",
    stage: "verification",
    identity: wineIdentity(),
    claims: [],
    needsDeepSearch: false,
    deepSearchReasons: [],
    issues: [],
    frozenVerification: frozen,
  };
  const parsed = parseWineStageResult(value, "verification");
  frozen.lockedFields.push("tags");
  expect(parsed).toMatchObject({
    frozenVerification: { lockedFields: ["title.en"] },
  });
  expect(() =>
    parseWineStageResult(
      { ...value, frozenVerification: { ...frozen, trusted: true } },
      "verification",
    ),
  ).toThrow();
  expect(() =>
    parseWineStageResult(
      { ...value, frozenVerification: { ...frozen, now: "invalid" } },
      "verification",
    ),
  ).toThrow();
});

function proposedResult() {
  const content = {
    ...emptyWorkingListing(),
    packQuantity: 1,
    title: { en: "Title", "zh-Hant": "標題" },
    description: { en: "Description", "zh-Hant": "描述" },
    seo: {
      title: { en: "SEO", "zh-Hant": "搜尋" },
      description: { en: "SEO description", "zh-Hant": "搜尋描述" },
    },
  };
  return {
    schemaVersion: 1,
    stage: "commit_candidate",
    state: "succeeded",
    versionId: null,
    outcome: "proposed",
    proposal: {
      schemaVersion: 1,
      inputRevision: 2,
      baseVersionId: "11111111-1111-4111-8111-111111111111",
      content,
      contentDigest: listingInputDigest(content),
    },
  };
}
it("accepts an immutable proposed artifact with a canonical content digest", () => {
  const value = proposedResult();
  expect(parseWineStageResult(value, "commit_candidate")).toEqual(value);
});
it.each([
  "digest",
  "base",
  "revision",
  "unknown",
  "version",
  "content",
  "wrong-outcome",
])("rejects invalid proposed artifact %s", (kind) => {
  const value: any = proposedResult();
  if (kind === "digest") value.proposal.contentDigest = "0".repeat(64);
  if (kind === "base") value.proposal.baseVersionId = null;
  if (kind === "revision") value.proposal.inputRevision = 0;
  if (kind === "unknown") value.proposal.claims = [];
  if (kind === "version") value.versionId = value.proposal.baseVersionId;
  if (kind === "content") value.proposal.content.title.en = "changed";
  if (kind === "wrong-outcome") value.outcome = "needs_info";
  expect(() => parseWineStageResult(value, "commit_candidate")).toThrow();
});
