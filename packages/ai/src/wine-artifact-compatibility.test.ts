import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as ai from "./index.js";
import * as core from "@wukong/core";
const cid = "00000000-0000-4000-8000-000000000001",
  eid = "00000000-0000-4000-8000-000000000002";
const request = (): any => ({
  schemaVersion: 1,
  binding: { workspaceId: "w", operationId: "o", inputRevision: 1 },
  claims: [
    {
      id: cid,
      field: "volumeMl",
      value: 750,
      kind: "fact",
      scope: "product",
      evidenceIds: [eid],
      premiseClaimIds: [],
      state: "accepted",
      reason: "trusted",
    },
  ],
  current: null,
  lockedPaths: [],
  tone: "neutral",
  claimPolicy: [],
  section: null,
});
const candidate = (): any => ({
  schemaVersion: 1,
  content: {
    title: { en: "", "zh-Hant": "" },
    seo: {
      title: { en: "", "zh-Hant": "" },
      description: { en: "", "zh-Hant": "" },
    },
    tags: [],
    sections: [
      {
        key: "introduction",
        en: "750 ml",
        "zh-Hant": "750 毫升",
        claimIds: [cid],
        locked: false,
        owner: "automatic",
      },
    ],
  },
  annotations: [
    {
      path: "sections.introduction.en",
      span: "750 ml",
      claimId: cid,
      value: 750,
      evidenceIds: [eid],
      premiseClaimIds: [],
    },
    {
      path: "sections.introduction.zh-Hant",
      span: "750 毫升",
      claimId: cid,
      value: 750,
      evidenceIds: [eid],
      premiseClaimIds: [],
    },
  ],
});

const frozen = () => ({
  schemaVersion: 1,
  binding: request().binding,
  identity: core.wineIdentity(),
  sources: [core.webEvidence()],
  supports: [{ sourceId: eid, field: "volumeMl", value: 750, span: "750 ml" }],
  authorities: [],
  reliableSourceIds: [],
  trustedObservationSourceIds: [],
  acceptedPremises: request().claims,
  verifiedAliases: [],
  lockedFields: [],
  now: "2026-09-16T00:00:00.000Z",
});
const legacy = () => ({
  ...request(),
  lockedPaths: ["title", "tags"],
  ownership: {
    schemaVersion: 1,
    priorKind: "legacy",
    metadata: {
      title: { en: "Human", "zh-Hant": "人手" },
      seo: candidate().content.seo,
      tags: [],
    },
    legacyDescription: { en: "Original whole", "zh-Hant": "原文" },
    lockedPaths: ["title", "tags"],
    provenanceDigest: "a".repeat(64),
  },
});
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
it("pins pre-extraction persisted artifact parsing and property order", () => {
  expect([
    hash(ai.wineFrozenContextSchema.parse(frozen())),
    hash(ai.wineGenerationRequestSchema.parse(request())),
    hash(ai.wineGenerationRequestSchema.parse(legacy())),
    hash(ai.wineGenerationCandidateSchema.parse(candidate())),
    hash(ai.wineCheckResponseSchema.parse({ schemaVersion: 1, issues: [] })),
  ]).toMatchInlineSnapshot(`
    [
      "583f0bc8cf57b02047f8369cca42594ddbbe5e07deb164fe54558a9c83192f0a",
      "e3e0bc7a810e67d8334490bf27e91d7a4ef82ee37896943011e5771a926b83af",
      "57472fe3ab353b49da3796430a7059c0f4eb05bc3f370acc9374aede3d579a16",
      "8b86f923ad2637f03440cde196d95321eac083980b6c771dacde484d38118143",
      "8b80454a48dc7a582f75fbfba3092f385856095f8af428460aa547a62424cb0c",
    ]
  `);
});

it("validates persisted artifacts through core with the same accepted bytes and decisions", () => {
  expect(core).toHaveProperty(
    "validateWineGenerationRequest",
    expect.any(Function),
  );
  expect(core).toHaveProperty("wineFrozenContextSchema");
  expect(hash(core.wineFrozenContextSchema.parse(frozen()))).toBe(
    hash(ai.wineFrozenContextSchema.parse(frozen())),
  );
  for (const raw of [request(), legacy()]) {
    const parsed = core.wineGenerationRequestSchema.parse(raw);
    expect(hash(parsed)).toBe(hash(ai.wineGenerationRequestSchema.parse(raw)));
    expect(() => core.validateWineGenerationRequest(parsed)).not.toThrow();
    const c = core.wineGenerationCandidateSchema.parse(candidate());
    expect(hash(c)).toBe(
      hash(ai.wineGenerationCandidateSchema.parse(candidate())),
    );
    expect(core.wineCandidateIssues(parsed, c)).toEqual(
      ai.wineCandidateIssues(parsed, c),
    );
  }
  expect(core.wineCandidateIssues(request(), candidate())).toEqual([]);
});

it.each([
  ["unaccepted", "Writing requires accepted claims"],
  ["duplicate", "Duplicate claims"],
  ["ownership", "Ownership locks disagree"],
  ["lock", "Unknown locked content path"],
  ["premise", "Unknown wine reference"],
])("preserves %s rejection messages and AI error identity", (kind, message) => {
  expect(core).toHaveProperty(
    "validateWineGenerationRequest",
    expect.any(Function),
  );
  const r = kind === "ownership" ? legacy() : request();
  if (kind === "unaccepted") r.claims[0].state = "unknown";
  if (kind === "duplicate") r.claims.push(r.claims[0]);
  if (kind === "ownership") r.lockedPaths = [];
  if (kind === "lock") r.lockedPaths = ["price"];
  if (kind === "premise")
    r.claims.push({
      ...r.claims[0],
      id: eid,
      kind: "recommendation",
      field: "pairing",
      premiseClaimIds: [eid],
    });
  expect(() => core.validateWineGenerationRequest(r)).toThrow(
    core.WineArtifactValidationError,
  );
  expect(() => core.validateWineGenerationRequest(r)).toThrow(message);
  let caught: unknown;
  try {
    ai.validateWineGenerationRequest(r);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ai.ProviderOutputError);
  expect(caught).toBeInstanceOf(ai.ListingProviderError);
  expect(caught).toMatchObject({
    name: "ProviderOutputError",
    message,
    diagnostic: {
      category: "internal",
      retryable: false,
      httpStatus: null,
      providerCode: null,
      requestId: null,
    },
  });
});

it.each([
  ["number", "unsupported_number_or_unit"],
  ["binding", "claim_binding"],
  ["annotation", "invalid_annotation"],
  ["coverage", "unannotated_output"],
  ["locked", "protected_content_changed"],
  ["owner", "protected_section_changed"],
])("shares blocking %s decisions across boundaries", (kind, code) => {
  expect(core).toHaveProperty("wineCandidateIssues", expect.any(Function));
  const r = request(),
    c = candidate();
  if (kind === "number")
    c.content.sections[0].en = c.annotations[0].span = "750 cl";
  if (kind === "binding") c.annotations[0].value = 75;
  if (kind === "annotation") c.annotations[0].claimId = eid;
  if (kind === "coverage") c.content.title.en = "Unsupported prose";
  if (kind === "locked") {
    r.current = candidate().content;
    r.lockedPaths = ["title"];
    c.content.title.en = "Changed";
  }
  if (kind === "owner") {
    r.current = candidate().content;
    r.current.sections[0].owner = "operator";
    c.content.sections[0].en = "Changed";
  }
  const issues = core.wineCandidateIssues(r, c);
  expect(issues).toEqual(ai.wineCandidateIssues(r, c));
  expect(issues).toContainEqual(
    expect.objectContaining({ code, blocking: true, evidenceIds: [] }),
  );
});

it("rejects unannotated trailing text after an astral character", () => {
  const r = request(),
    c = candidate();
  c.content.sections[0].en = "\u{1F377}750 ml";
  c.annotations[0].span = c.content.sections[0].en;
  expect(core.wineCandidateIssues(r, c)).toEqual([]);

  c.content.sections[0].en += "X";
  expect(core.wineCandidateIssues(r, c)).toContainEqual(
    expect.objectContaining({
      path: "sections.introduction.en",
      code: "unannotated_output",
    }),
  );
});

it("preserves strict versioned parsing, optional ownership and required nested observations", () => {
  expect(core).toHaveProperty("wineGenerationRequestSchema");
  expect(core.wineGenerationRequestSchema.parse(request())).not.toHaveProperty(
    "ownership",
  );
  const raw = frozen();
  delete (raw.identity.observations.producer as any).evidenceIds;
  expect(core.wineFrozenContextSchema.safeParse(raw).success).toBe(false);
  expect(ai.wineFrozenContextSchema.safeParse(raw).success).toBe(false);
  for (const [schema, fixture] of [
    [core.wineFrozenContextSchema, frozen()],
    [core.wineGenerationRequestSchema, request()],
    [core.wineGenerationCandidateSchema, candidate()],
    [core.wineCheckResponseSchema, { schemaVersion: 1, issues: [] }],
  ] as const) {
    expect(schema.safeParse({ ...fixture, schemaVersion: 2 }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...fixture, extra: "untrusted" }).success).toBe(
      false,
    );
  }
  expect(
    core.wineGenerationCandidateSchema.safeParse({
      ...candidate(),
      content: { ...candidate().content, price: 10 },
    }).success,
  ).toBe(false);
  expect(
    core.wineSupportProposalSchema.safeParse({
      ...frozen().supports[0],
      trust: "official",
    }).success,
  ).toBe(false);
  expect(
    core.wineOutputAnnotationSchema.safeParse({
      ...candidate().annotations[0],
      extra: true,
    }).success,
  ).toBe(false);
});

it("does not translate unrelated caller errors at the AI boundary", () => {
  const failure = new Error("caller failure");
  const r = request();
  Object.defineProperty(r, "ownership", {
    get() {
      throw failure;
    },
  });
  expect(() => ai.validateWineGenerationRequest(r)).toThrow(failure);
  try {
    ai.validateWineGenerationRequest(r);
  } catch (e) {
    expect(e).toBe(failure);
  }
});
