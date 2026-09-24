import type {
  EvidenceSource,
  FieldObservation,
  ProductIdentity,
} from "./wine-enrichment-contracts.js";

const EVIDENCE_ID = "00000000-0000-4000-8000-000000000001";

function observed(value: string | number | string[]): FieldObservation {
  return { value, state: "observed", evidenceIds: [EVIDENCE_ID] };
}

export function wineIdentity(
  overrides: Partial<ProductIdentity> = {},
): ProductIdentity {
  const identity = {
    schemaVersion: 1,
    kind: "wine",
    producer: "Fixture Estate",
    productName: "Reserve Red",
    aliases: [],
    cuvee: null,
    vintage: { state: "unknown", year: null },
    volumeMl: null,
    packQuantity: null,
    marketVariant: null,
    barcode: null,
    abvPercent: null,
    category: {},
    observations: {},
    status: "candidate",
    ...overrides,
  } as ProductIdentity;
  if (overrides.category === undefined) identity.category = {};
  if (overrides.observations === undefined) {
    identity.observations = {};
    const values = [
      ["producer", identity.producer],
      ["productName", identity.productName],
      ["aliases", identity.aliases.length ? [...identity.aliases] : null],
      ["cuvee", identity.cuvee],
      [
        "vintage",
        identity.vintage.state === "known" ? identity.vintage.year : null,
      ],
      ["volumeMl", identity.volumeMl],
      ["packQuantity", identity.packQuantity],
      ["marketVariant", identity.marketVariant],
      ["barcode", identity.barcode],
      ["abvPercent", identity.abvPercent],
    ] as const;
    for (const [field, value] of values) {
      if (value !== null) identity.observations[field] = observed(value);
    }
  }
  return identity;
}

export function webEvidence(
  overrides: Partial<EvidenceSource> = {},
): EvidenceSource {
  return {
    schemaVersion: 1,
    id: EVIDENCE_ID,
    kind: "web",
    assetId: null,
    url: "https://example.test/wine",
    title: "Synthetic wine evidence",
    domain: "example.test",
    capturedAt: "2026-09-16T00:00:00.000Z",
    excerpt: "Synthetic fixture evidence for Reserve Red.",
    location: "fixture paragraph 1",
    documentDigest: "sha256:fixture-wine-evidence",
    contentScope: "document",
    truncated: false,
    identity: wineIdentity(),
    trust: "unverified",
    independenceKey: "example.test",
    ...overrides,
  };
}
