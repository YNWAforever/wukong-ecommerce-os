import { wineIdentityAssertionText } from "./wine-identity-selection.js";
import { expect, it } from "vitest";
import { groundWineEvidence } from "./wine-evidence-grounding.js";
import { wineIdentity, webEvidence } from "./wine-enrichment-fixtures.js";

const binding = { workspaceId: "test", operationId: "run", inputRevision: 2 };
const original = wineIdentity({
  volumeMl: 750,
  packQuantity: 1,
  status: "needs_confirmation",
});
const assertion = webEvidence({
  id: "00000000-0000-4000-8000-000000000002",
  kind: "merchant",
  url: null,
  domain: null,
  contentScope: "note",
  title: "Merchant identity selection (not observed evidence)",
  excerpt:
    "Merchant identity selection: " +
    JSON.stringify({
      kind: "wine",
      producer: "Fixture Estate",
      productName: "Reserve Red",
      cuvee: null,
      vintage: { state: "known", year: 2020 },
      volumeMl: 750,
      packQuantity: 1,
      marketVariant: null,
      barcode: null,
    }),
  location: "wine:identity-selection:run",
  identity: null,
  trust: "unverified",
});
const coordinates = {
  kind: "wine",
  producer: "Fixture Estate",
  productName: "Reserve Red",
  cuvee: null,
  vintage: { state: "known", year: 2020 },
  volumeMl: 750,
  packQuantity: 1,
  marketVariant: null,
  barcode: null,
};
function ground(contrary = false, mutate?: (value: any) => void) {
  const source = webEvidence({
    kind: "merchant",
    url: null,
    domain: null,
    contentScope: "note",
    excerpt:
      "Producer: Fixture Estate\nProduct: Reserve Red\nVolume: 750 ml\nPack quantity: 1 bottles" +
      (contrary ? "\nVintage: 2021" : ""),
    identity: original,
  });
  const input = {
    accepted: {
      binding,
      assets: [],
      note: source.excerpt,
      lockedFields: ["priceHkd"],
      verifiedAliases: [],
      identitySelection: { identity: coordinates, source: assertion },
    },
    extraction: { binding, identity: original },
    records: [
      {
        binding,
        assetDigest: null,
        documentDigest: source.documentDigest,
        source,
      },
      {
        binding,
        assetDigest: null,
        documentDigest: assertion.documentDigest,
        source: assertion,
      },
    ],
    authorities: [],
    now: "2026-09-20T00:00:00.000Z",
  } as Parameters<typeof groundWineEvidence>[0];
  mutate?.(input);
  return groundWineEvidence(input);
}
it("resolves missing vintage through a server selection without inventing observed facts", () => {
  const result = ground();
  expect(result.context.identity.vintage).toEqual({
    state: "known",
    year: 2020,
  });
  expect(result.context.identity.status).toBe("matched");
  expect(result.context.identity.observations.vintage).toMatchObject({
    value: 2020,
    state: "normalized",
    evidenceIds: [assertion.id],
  });
  expect(result.context.trustedObservationSourceIds).not.toContain(
    assertion.id,
  );
  expect(result.context.supports.some((s) => s.field === "vintage")).toBe(
    false,
  );
  expect(result.context.sources[0]!.identity!.vintage.state).toBe("unknown");
  expect(
    result.issues.find((i) => i.code === "observation_identity_ambiguous")
      ?.blocking,
  ).toBe(false);
});
it("keeps contrary merchant vintage as a blocking conflict after selection", () => {
  const result = ground(true);
  expect(result.context.identity.vintage.year).toBe(2020);
  expect(result.context.identity.status).toBe("needs_confirmation");
  expect(result.context.supports).toContainEqual(
    expect.objectContaining({ field: "vintage", value: 2021 }),
  );
  expect(result.issues).toContainEqual(
    expect.objectContaining({
      code: "selected_identity_conflict",
      blocking: true,
    }),
  );
});

it.each(["coordinate", "record", "id", "unbound"])(
  "rejects forged assertion %s",
  (kind) => {
    expect(() =>
      ground(false, (input) => {
        input.accepted.identitySelection = structuredClone(
          input.accepted.identitySelection,
        );
        input.records = structuredClone(input.records);
        if (kind === "coordinate")
          input.accepted.identitySelection.identity.vintage.year = 2021;
        if (kind === "record") input.records[1].source.excerpt = "forged";
        if (kind === "id")
          input.accepted.identitySelection.source.id =
            "00000000-0000-4000-8000-000000000009";
        if (kind === "unbound") delete input.accepted.identitySelection;
      }),
    ).toThrow(/identity_selection/);
  },
);

it("a candidate missing an optional coordinate does not erase a bound original barcode", () => {
  const result = ground(false, (input) => {
    input.extraction = structuredClone(input.extraction);
    input.records = structuredClone(input.records);
    const source = input.records[0].source;
    source.excerpt += "\nBarcode: 123456";
    input.accepted.note = source.excerpt;
    input.extraction.identity.barcode = "123456";
    input.extraction.identity.observations.barcode = {
      value: "123456",
      state: "observed",
      evidenceIds: [source.id],
    };
    source.identity = structuredClone(input.extraction.identity);
  });
  expect(result.context.identity.barcode).toBe("123456");
  expect(
    result.context.identity.observations.barcode!.evidenceIds,
  ).not.toContain(assertion.id);
});

it("keeps contrary wine category evidence visible when a spirits identity is selected", () => {
  const result = ground(false, (input) => {
    input.extraction = structuredClone(input.extraction);
    input.records = structuredClone(input.records);
    input.accepted.identitySelection = structuredClone(
      input.accepted.identitySelection,
    );
    const source = input.records[0].source;
    source.excerpt += "\nAppellation: Bordeaux";
    input.accepted.note = source.excerpt;
    input.extraction.identity.category = {
      appellation: {
        value: "Bordeaux",
        state: "observed",
        evidenceIds: [source.id],
      },
    };
    source.identity = structuredClone(input.extraction.identity);
    input.accepted.identitySelection.identity.kind = "spirits";
    input.accepted.identitySelection.source.excerpt = wineIdentityAssertionText(
      input.accepted.identitySelection.identity,
    );
    input.records[1].source = structuredClone(
      input.accepted.identitySelection.source,
    );
  });
  expect(result.context.identity.kind).toBe("spirits");
  expect(result.context.identity.status).toBe("needs_confirmation");
  expect(result.context.sources[0]!.identity!.category).toHaveProperty(
    "appellation.value",
    "Bordeaux",
  );
  expect(
    result.issues.some(
      (i) => i.blocking && i.code === "observation_identity_conflict",
    ),
  ).toBe(true);
});

it("preserves contrary photo evidence as a blocker after selection", () => {
  const result = ground(true, (input) => {
    input.records = structuredClone(input.records);
    const source = input.records[0].source;
    source.kind = "photo";
    source.assetId = "00000000-0000-4000-8000-000000000003";
    source.contentScope = "label";
    input.records[0].assetDigest = "accepted-image-digest";
    input.accepted.assets = [
      { id: source.assetId, digest: "accepted-image-digest" },
    ];
  });
  expect(result.context.identity.status).toBe("needs_confirmation");
  expect(result.context.sources[0]!.kind).toBe("photo");
  expect(result.context.sources[0]!.excerpt).toContain("Vintage: 2021");
  expect(
    result.issues.some(
      (i) => i.code === "selected_identity_conflict" && i.blocking,
    ),
  ).toBe(true);
});
