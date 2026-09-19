import { describe, expect, it } from "vitest";
import * as core from "@wukong/core";
import * as api from "./index.js";
import { listingInputDigest as hash } from "./repositories/listing-inputs.js";
import type { AdoptedWineDependencies } from "./wine-adopted-dependencies.js";
import type { WineGenerationOwnership } from "./wine-generation-ownership.js";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const policy = core.wineEnrichmentPolicySchema.parse({ enabled: true });
  const identity = core.wineIdentity({ status: "matched" });
  const source = core.webEvidence({
    kind: "merchant",
    url: null,
    domain: null,
    contentScope: "note",
  });
  const claim: core.SupportedClaim = {
    id: id(2),
    field: "producer",
    value: "Fixture Estate",
    kind: "fact",
    scope: "product",
    evidenceIds: [source.id],
    premiseClaimIds: [],
    state: "accepted",
    reason: "fixture",
  };
  const current: core.WineContent = {
    title: { en: "", "zh-Hant": "" },
    seo: {
      title: { en: "", "zh-Hant": "" },
      description: { en: "", "zh-Hant": "" },
    },
    tags: [],
    sections: [
      {
        key: "introduction",
        en: "Fixture Estate",
        "zh-Hant": "Fixture Estate",
        claimIds: [claim.id],
        locked: false,
        owner: "automatic",
      },
    ],
  };
  const frozen: core.WineFrozenContext = {
    schemaVersion: 1,
    binding: { workspaceId: "WS", operationId: id(3), inputRevision: 1 },
    identity,
    sources: [source],
    supports: [],
    authorities: [],
    reliableSourceIds: [],
    trustedObservationSourceIds: [source.id],
    acceptedPremises: [claim],
    verifiedAliases: [],
    lockedFields: [],
    now: "2026-09-16T00:00:00.000Z",
  };
  const origin = {
    workspaceId: "WS",
    listingId: id(4),
    versionId: id(5),
    runId: id(3),
    inputRevision: 1,
    baseVersionId: null,
    inputDigest: hash("old input"),
    sourceDigest: hash("old sources"),
    acceptedAt: frozen.now,
    mode: "full" as const,
    modelPolicy: core.WINE_EXECUTION_SNAPSHOT,
    policy,
    frozenVerification: frozen,
    claims: [claim],
  };
  const adopted: Extract<AdoptedWineDependencies, { status: "available" }> = {
    status: "available",
    schemaVersion: 1,
    versionId: id(5),
    originRunId: id(3),
    inputRevision: 2,
    outcome: "complete",
    current,
    adopted: current,
    origins: [origin],
    supports: ["en", "zh-Hant"].map((lang) => ({
      path: `sections.introduction.${lang}`,
      claimId: claim.id,
      claim,
      evidenceIds: claim.evidenceIds,
      premiseClaimIds: [],
      text: "Fixture Estate",
      span: "Fixture Estate",
      originRunId: id(3),
      originVersionId: id(5),
      originInputRevision: 1,
      sources: [source],
      valid: true,
      invalidReason: null,
    })),
    unavailableSections: [],
    refreshRequired: false,
    provenanceDigest: hash("read clock A"),
  };
  const input = {
    workspaceId: "WS",
    listingId: id(4),
    revision: 2,
    inputDigest: hash("new input"),
    sources: [],
  };
  const ownership: Extract<WineGenerationOwnership, { status: "available" }> = {
    status: "available",
    schemaVersion: 1,
    binding: {
      workspaceId: "WS",
      listingId: id(4),
      operationId: id(6),
      inputRevision: 2,
      baseVersionId: id(5),
    },
    prior: {
      kind: "structured",
      current,
      metadata: { title: current.title, seo: current.seo, tags: current.tags },
    },
    lockedPaths: [],
    provenance: {
      inputDigest: input.inputDigest,
      baseVersionId: id(5),
      contentDigest: hash(current),
    },
    provenanceDigest: hash("ownership"),
  };
  return {
    adopted,
    input,
    ownership,
    policy,
    model: core.WINE_EXECUTION_SNAPSHOT,
    mode: "section" as const,
    section: "introduction" as const,
  };
}
describe("compact adopted copy dependency contract", () => {
  it("creates a bounded original-pointer snapshot without copying source pools", () => {
    const f = fixture(),
      result = api.buildWineCopySnapshot(f);
    expect(result.snapshot).toMatchObject({
      schemaVersion: 1,
      mode: "section",
      section: "introduction",
      baseVersionId: id(5),
      inputRevision: 2,
      targetPaths: [
        "sections.introduction.en",
        "sections.introduction.zh-Hant",
      ],
    });
    expect(result.claims).toEqual(f.adopted.origins[0]!.claims);
    expect(result.snapshot.origins[0]).toMatchObject({
      runId: id(3),
      frozenContextDigest: hash(f.adopted.origins[0]!.frozenVerification),
    });
    expect(JSON.stringify(result.snapshot)).not.toContain("excerpt");
    expect(core.wineCopySnapshotSchema.safeParse(result.snapshot).success).toBe(
      true,
    );
  });
  it("separates live read audit from stable dependency binding", () => {
    const f = fixture(),
      first = api.buildWineCopySnapshot(f);
    f.adopted.provenanceDigest = hash("read clock B");
    const second = api.buildWineCopySnapshot(f);
    expect(first.snapshot.dependencyDigest).toBe(
      second.snapshot.dependencyDigest,
    );
    expect(first.snapshot.adoptedProvenanceDigest).not.toBe(
      second.snapshot.adoptedProvenanceDigest,
    );
    f.adopted.origins[0]!.frozenVerification.now = "2026-09-16T00:00:01.000Z";
    expect(api.buildWineCopySnapshot(f).snapshot.dependencyDigest).not.toBe(
      second.snapshot.dependencyDigest,
    );
  });
  it.each([
    "invalid_support",
    "foreign_origin",
    "missing_origin",
    "locked_target",
    "unavailable_target",
    "changed_text",
    "wrong_revision",
    "source_mismatch",
    "claim_mismatch",
  ])("fails closed for %s", (cause) => {
    const f = fixture();
    if (cause === "invalid_support") f.adopted.supports[0]!.valid = false;
    if (cause === "foreign_origin") f.adopted.origins[0]!.workspaceId = "other";
    if (cause === "missing_origin") f.adopted.origins = [];
    if (cause === "locked_target")
      f.ownership.lockedPaths = ["sections.introduction"];
    if (cause === "unavailable_target")
      f.adopted.unavailableSections = [
        {
          path: "sections.introduction.en",
          claimIds: [],
          reason: "ancestry_unavailable",
        },
      ];
    if (cause === "changed_text") f.adopted.supports[0]!.text = "changed";
    if (cause === "wrong_revision") f.input.revision = 3;
    if (cause === "source_mismatch") f.adopted.supports[0]!.sources = [];
    if (cause === "claim_mismatch")
      f.adopted.supports[0]!.claim = {
        ...f.adopted.supports[0]!.claim,
        value: "forged",
      };
    expect(() => api.buildWineCopySnapshot(f)).toThrow(
      "evidence_refresh_required",
    );
  });
  it("allows protected unavailable outside-section text and binds it unchanged", () => {
    const f = fixture();
    f.adopted.current!.title.en = "Operator text";
    f.ownership.lockedPaths = ["title.en"];
    f.adopted.unavailableSections = [
      { path: "title.en", claimIds: [id(90)], reason: "ancestry_unavailable" },
    ];
    f.adopted.refreshRequired = true;
    const a = api.buildWineCopySnapshot(f).snapshot;
    f.adopted.current!.title.en = "Changed operator text";
    expect(api.buildWineCopySnapshot(f).snapshot.dependencyDigest).not.toBe(
      a.dependencyDigest,
    );
    expect(a.targetPaths).not.toContain("title.en");
  });
  it("requires an allowed domain for retained web evidence, without granting search", () => {
    const f = fixture(),
      source = f.adopted.origins[0]!.frozenVerification.sources[0]!;
    Object.assign(source, {
      kind: "web",
      contentScope: "document",
      url: "https://example.test/wine",
      domain: "example.test",
    });
    expect(() => api.buildWineCopySnapshot(f)).toThrow(
      "evidence_refresh_required",
    );
    f.policy = core.wineEnrichmentPolicySchema.parse({
      enabled: true,
      allowedDomains: ["example.test"],
    });
    expect(api.buildWineCopySnapshot(f).snapshot.mode).toBe("section");
  });
  it("does not trim excess support to fit the snapshot", () => {
    const f = fixture();
    f.adopted.supports = Array.from(
      { length: 513 },
      () => f.adopted.supports[0]!,
    );
    expect(() => api.buildWineCopySnapshot(f)).toThrow(
      "evidence_refresh_required",
    );
  });
});

describe("copy snapshot complete closure and strict shape", () => {
  it("rejects a section that names a claim absent from its selected support", () => {
    const f = fixture();
    f.adopted.current!.sections[0]!.claimIds.push(id(99));
    expect(() => api.buildWineCopySnapshot(f)).toThrow(
      "evidence_refresh_required",
    );
  });
  it("retains factual premise closure without inventing new claim IDs", () => {
    const f = fixture(),
      original = f.adopted.origins[0]!.claims[0]!;
    const recommendation: core.SupportedClaim = {
      ...original,
      id: id(9),
      field: "pairing",
      value: "Serve with food",
      kind: "recommendation",
      evidenceIds: [],
      premiseClaimIds: [original.id],
    };
    f.adopted.origins[0]!.claims.push(recommendation);
    f.adopted.current!.sections[0]!.claimIds = [recommendation.id];
    f.adopted.supports.forEach((s) =>
      Object.assign(s, {
        claimId: recommendation.id,
        claim: recommendation,
        evidenceIds: [],
        premiseClaimIds: [original.id],
      }),
    );
    const result = api.buildWineCopySnapshot(f);
    expect(result.claims.map((c) => c.id)).toEqual([
      original.id,
      recommendation.id,
    ]);
    expect(
      result.snapshot.claims.find((c) => c.claimId === recommendation.id)
        ?.sources,
    ).toEqual(
      result.snapshot.claims.find((c) => c.claimId === original.id)?.sources,
    );
    original.premiseClaimIds = [recommendation.id];
    expect(() => api.buildWineCopySnapshot(f)).toThrow(
      "evidence_refresh_required",
    );
  });
  it("rejects reused IDs from distinct original bindings", () => {
    const f = fixture(),
      other = structuredClone(f.adopted.origins[0]!);
    other.runId = id(30);
    other.versionId = id(31);
    other.frozenVerification.binding.operationId = other.runId;
    f.adopted.origins.push(other);
    Object.assign(f.adopted.supports[1]!, {
      originRunId: other.runId,
      originVersionId: other.versionId,
    });
    expect(() => api.buildWineCopySnapshot(f)).toThrow(
      "evidence_refresh_required",
    );
  });
  it("binds source capture and full contrary pool even when adopted text is unchanged", () => {
    const f = fixture(),
      before = api.buildWineCopySnapshot(f).snapshot;
    f.adopted.origins[0]!.frozenVerification.sources.push(
      core.webEvidence({ id: id(88), excerpt: "Contrary original source" }),
    );
    expect(api.buildWineCopySnapshot(f).snapshot.dependencyDigest).not.toBe(
      before.dependencyDigest,
    );
    f.adopted.origins[0]!.frozenVerification.sources[0]!.capturedAt =
      "2026-09-15T00:00:00.000Z";
    expect(
      api.buildWineCopySnapshot(f).snapshot.origins[0]!.frozenContextDigest,
    ).not.toBe(before.origins[0]!.frozenContextDigest);
  });
  it("excludes proposed new-run ID from ownership digest but includes locks and all metadata", () => {
    const f = fixture(),
      before = api.buildWineCopySnapshot(f).snapshot;
    f.ownership.binding.operationId = id(50);
    f.ownership.provenanceDigest = hash("new binding");
    expect(api.buildWineCopySnapshot(f).snapshot.dependencyDigest).toBe(
      before.dependencyDigest,
    );
    f.ownership.lockedPaths = ["title.en"];
    expect(api.buildWineCopySnapshot(f).snapshot.dependencyDigest).not.toBe(
      before.dependencyDigest,
    );
  });
  it("builds copy targets only from unlocked automatic paths", () => {
    const f = fixture();
    f.ownership.lockedPaths = ["title.en", "seo", "tags"];
    const result = api.buildWineCopySnapshot({
      ...f,
      mode: "copy",
      section: null,
    });
    expect(result.snapshot.targetPaths).toContain("sections.introduction.en");
    expect(result.snapshot.targetPaths).not.toContain("title.en");
    expect(result.snapshot.targetPaths.some((p) => p.startsWith("seo."))).toBe(
      false,
    );
  });
  it.each([
    "extras",
    "wrong_section",
    "duplicate_origin",
    "duplicate_claim",
    "missing_premise",
    "wrong_support_origin",
    "oversized",
  ])("strict schema rejects %s", (cause) => {
    const snapshot: any = api.buildWineCopySnapshot(fixture()).snapshot;
    if (cause === "extras") snapshot.sources = [];
    if (cause === "wrong_section") snapshot.section = "pairing";
    if (cause === "duplicate_origin")
      snapshot.origins.push(snapshot.origins[0]);
    if (cause === "duplicate_claim") snapshot.claims.push(snapshot.claims[0]);
    if (cause === "missing_premise")
      snapshot.claims[0].premiseClaimIds = [id(99)];
    if (cause === "wrong_support_origin")
      snapshot.supports[0].originRunId = id(99);
    if (cause === "oversized")
      snapshot.claims = Array.from({ length: 128 }, (_, i) => ({
        ...snapshot.claims[0],
        claimId: i === 0 ? id(2) : id(100 + i),
        sources: Array.from({ length: 128 }, (_, j) => ({
          id: id(1000 + j),
          digest: hash(j),
        })),
      }));
    expect(core.wineCopySnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});
