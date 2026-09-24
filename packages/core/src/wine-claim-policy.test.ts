import { describe, expect, it } from "vitest";
import { webEvidence, wineIdentity } from "./wine-enrichment-fixtures.js";
import {
  supportedClaimSchema,
  type SupportedClaim,
} from "./wine-enrichment-contracts.js";
import { decideWineClaim, type WineClaimContext } from "./wine-claim-policy.js";
const id = "00000000-0000-4000-8000-000000000001",
  second = "00000000-0000-4000-8000-000000000002";
const identity = wineIdentity({
  marketVariant: "HK",
  vintage: { state: "known", year: 2019 },
});
const source = webEvidence({
  identity,
  excerpt: "Reserve Red 2019 ABV 13.5%",
  trust: "verified_official",
});
const claim: SupportedClaim = {
  id: second,
  field: "abvPercent",
  value: 13.5,
  kind: "fact",
  scope: "product",
  evidenceIds: [id],
  premiseClaimIds: [],
  state: "unknown",
  reason: "",
};
const context: WineClaimContext = {
  now: "2026-09-16T00:00:00Z",
  authorities: [
    {
      schemaVersion: 1,
      domain: "example.test",
      subject: { kind: "producer", name: "Fixture Estate" },
      proofUrl: "https://example.test/about",
      proofDigest: "a".repeat(64),
      verifiedAt: "2026-09-01T00:00:00Z",
      expiresAt: "2026-10-01T00:00:00Z",
      revokedAt: null,
      verifierId: "reviewer-1",
    },
  ],
  supports: [
    { sourceId: id, field: "abvPercent", value: 13.5, span: "ABV 13.5%" },
  ],
};
const decide = (
  overrides: Partial<Parameters<typeof decideWineClaim>[0]> = {},
) =>
  decideWineClaim({
    identity,
    claim,
    sources: [source],
    lockedFields: new Set(),
    context,
    ...overrides,
  });
describe("wine claim adoption", () => {
  it("adopts precise registered official support", () =>
    expect(decide().state).toBe("accepted"));
  it("fails closed without trusted context", () =>
    expect(decide({ context: undefined }).state).toBe("unknown"));
  it("locks always win", () =>
    expect(decide({ lockedFields: new Set(["abvPercent"]) }).reason).toBe(
      "operator_locked",
    ));
  it.each(["sku", "priceHkd", "stockQuantity"])(
    "rejects non-merchant %s",
    (field) =>
      expect(
        decide({ claim: { ...claim, field } as SupportedClaim }).reason,
      ).toBe("merchant_only"),
  );
  it("does not promote official-looking sources", () =>
    expect(decide({ context: { ...context, authorities: [] } }).state).toBe(
      "rejected",
    ));
  it("requires every evidence ID to resolve uniquely", () => {
    expect(
      decide({ claim: { ...claim, evidenceIds: [id, second] } }).reason,
    ).toBe("missing_or_duplicate_source");
    expect(decide({ sources: [source, source] }).reason).toBe(
      "missing_or_duplicate_source",
    );
  });
  it.each([
    { contentScope: "snippet" as const },
    { truncated: true },
    { excerpt: "Unrelated text" },
  ])("does not adopt incomplete supporting spans", (change) =>
    expect(decide({ sources: [{ ...source, ...change }] }).state).toBe(
      "unknown",
    ),
  );
  it("does not accept unsupported values merely because a source is official", () =>
    expect(decide({ claim: { ...claim, value: 99 } }).state).toBe("unknown"));
  it("rejects wrong-product noise without a blocking conflict", () =>
    expect(
      decide({
        sources: [
          {
            ...source,
            identity: wineIdentity({ ...identity, productName: "White" }),
          },
        ],
      }).state,
    ).toBe("rejected"));
  it("requires known market for specifications", () =>
    expect(
      decide({ identity: wineIdentity({ vintage: identity.vintage }) }).state,
    ).toBe("unknown"));
  it("adopts brand history without product or market match", () => {
    const history = {
      ...claim,
      field: "brand_background" as const,
      scope: "brand" as const,
      value: "Founded in 1900",
    };
    expect(
      decide({
        identity: wineIdentity(),
        claim: history,
        sources: [
          {
            ...source,
            identity: wineIdentity({ productName: null }),
            excerpt: "Founded in 1900",
          },
        ],
        context: {
          ...context,
          supports: [
            {
              sourceId: id,
              field: history.field,
              value: history.value,
              span: history.value,
            },
          ],
        },
      }).state,
    ).toBe("accepted");
    expect(decide({ claim: { ...claim, scope: "brand" } }).state).toBe(
      "rejected",
    );
  });
  it("requires two independently reliable agreeing sources", () => {
    const reliable = { ...source, trust: "reliable" as const };
    const other = {
      ...reliable,
      id: second,
      url: "https://second.test/wine",
      domain: "second.test",
      independenceKey: "second",
      documentDigest: "different",
      excerpt: "Technical sheet ABV 13.5%",
    };
    const ctx = {
      ...context,
      authorities: [],
      reliableSourceIds: new Set([id, second]),
      supports: [
        ...context.supports!,
        { ...context.supports![0]!, sourceId: second },
      ],
    };
    expect(decide({ sources: [reliable], context: ctx }).state).toBe("unknown");
    expect(
      decide({
        claim: { ...claim, evidenceIds: [id, second] },
        sources: [reliable, other],
        context: ctx,
      }).state,
    ).toBe("accepted");
    expect(
      decide({
        claim: { ...claim, evidenceIds: [id, second] },
        sources: [reliable, { ...other, excerpt: reliable.excerpt }],
        context: ctx,
      }).state,
    ).toBe("unknown");
    expect(
      decide({
        claim: { ...claim, evidenceIds: [id, second] },
        sources: [
          reliable,
          { ...other, independenceKey: reliable.independenceKey },
        ],
        context: ctx,
      }).state,
    ).toBe("unknown");
  });
  it("reports trusted observed contradictions only after exact trusted support", () => {
    const observed = wineIdentity({
      marketVariant: "HK",
      vintage: identity.vintage,
      abvPercent: 14,
    });
    const photo = {
      ...webEvidence(),
      kind: "photo" as const,
      url: null,
      domain: null,
      assetId: second,
      id: second,
      contentScope: "label" as const,
    };
    observed.observations.abvPercent!.evidenceIds = [second];
    expect(
      decide({
        identity: observed,
        sources: [source, photo],
        context: { ...context, trustedObservationSourceIds: new Set([second]) },
      }).state,
    ).toBe("conflict");
    expect(
      decide({
        identity: observed,
        sources: [{ ...source, trust: "unverified" }, photo],
        context: {
          ...context,
          authorities: [],
          trustedObservationSourceIds: new Set([second]),
        },
      }).state,
    ).toBe("rejected");
  });
  it("recommendations require resolved accepted factual premises", () => {
    const recommendation = {
      ...claim,
      id: "00000000-0000-4000-8000-000000000003",
      field: "pairing" as const,
      kind: "recommendation" as const,
      value: "Try roast duck",
      evidenceIds: [],
      premiseClaimIds: [second],
    };
    expect(decide({ claim: recommendation }).state).toBe("unknown");
    expect(
      decide({
        claim: recommendation,
        context: { ...context, acceptedPremises: [decide()] },
      }).state,
    ).toBe("accepted");
    expect(
      decide({
        claim: recommendation,
        context: {
          ...context,
          acceptedPremises: [{ ...claim, state: "conflict" }],
        },
      }).state,
    ).toBe("unknown");
  });
  it.each(["criticScores", "awards", "drinkingWindow"] as const)(
    "supports the explicit %s contract",
    (field) =>
      expect(supportedClaimSchema.safeParse({ ...claim, field }).success).toBe(
        true,
      ),
  );
  it("requires original authority and exact vintage for a score", () => {
    const score = {
      ...claim,
      field: "criticScores" as const,
      value: "Critic A: 95",
    };
    const scoreSource = { ...source, excerpt: "Critic A: 95", identity };
    const support = {
      sourceId: id,
      field: score.field,
      value: score.value,
      span: score.value,
      originalAuthority: "Critic A",
      applicableVintage: identity.vintage,
    };
    const ctx = { ...context, supports: [support] };
    expect(
      decide({ claim: score, sources: [scoreSource], context: ctx }).state,
    ).toBe("unknown");
    const authorities = [
      {
        ...context.authorities![0]!,
        subject: { kind: "authority" as const, name: "Critic A" },
      },
    ];
    expect(
      decide({
        claim: score,
        sources: [scoreSource],
        context: { ...ctx, authorities },
      }).state,
    ).toBe("accepted");
    expect(
      decide({
        claim: score,
        sources: [scoreSource],
        context: {
          ...ctx,
          authorities,
          supports: [
            { ...support, applicableVintage: { state: "known", year: 2020 } },
          ],
        },
      }).state,
    ).toBe("unknown");
  });
});

describe("adversarial evidence integrity", () => {
  it("reports incompatible exact official facts as blocking conflicts", () => {
    const other = { ...source, id: second, excerpt: "ABV 14%" };
    const ctx = {
      ...context,
      supports: [
        ...context.supports!,
        { sourceId: second, field: claim.field, value: 14, span: "ABV 14%" },
      ],
    };
    expect(decide({ sources: [source, other], context: ctx }).state).toBe(
      "conflict",
    );
  });
  it("rejects forged reliable domain metadata", () => {
    const other = {
      ...source,
      id: second,
      url: "https://evil.test/wine",
      domain: "second.test",
      trust: "reliable" as const,
      independenceKey: "second",
      documentDigest: "different",
      excerpt: "Specifications ABV 13.5%",
    };
    const ctx = {
      ...context,
      authorities: [],
      reliableSourceIds: new Set([id, second]),
      supports: [
        ...context.supports!,
        { ...context.supports![0]!, sourceId: second },
      ],
    };
    expect(
      decide({
        claim: { ...claim, evidenceIds: [id, second] },
        sources: [{ ...source, trust: "reliable" }, other],
        context: ctx,
      }).state,
    ).toBe("unknown");
  });
  it("does not transfer a vintage-dependent score to an unknown vintage", () => {
    expect(
      decide({
        identity: wineIdentity({ marketVariant: "HK" }),
        claim: { ...claim, field: "criticScores", value: "95" },
      }).state,
    ).not.toBe("accepted");
  });
  it("does not reuse brand premises for product recommendations", () => {
    expect(
      decide({
        claim: {
          ...claim,
          id: "00000000-0000-4000-8000-000000000003",
          kind: "recommendation",
          field: "pairing",
          premiseClaimIds: [second],
        },
        context: {
          ...context,
          acceptedPremises: [
            {
              ...claim,
              state: "accepted",
              scope: "brand",
              field: "brand_background",
            },
          ],
        },
      }).state,
    ).toBe("unknown");
  });
});

describe("adoption applicability and citations", () => {
  it("does not import a known-year tasting profile into an unknown vintage", () => {
    const tasting = {
      ...claim,
      field: "tasting" as const,
      value: "Dark cherry",
    };
    expect(
      decide({
        identity: wineIdentity({ marketVariant: "HK" }),
        claim: tasting,
        sources: [{ ...source, excerpt: "Dark cherry" }],
        context: {
          ...context,
          supports: [
            {
              sourceId: id,
              field: tasting.field,
              value: tasting.value,
              span: tasting.value,
            },
          ],
        },
      }).state,
    ).toBe("unknown");
  });
  it("limits unknown-market enrichment to brand facts", () => {
    const tasting = {
      ...claim,
      field: "tasting" as const,
      value: "Dark cherry",
    };
    expect(
      decide({
        identity: wineIdentity({ vintage: identity.vintage }),
        claim: tasting,
        sources: [{ ...source, excerpt: "Dark cherry" }],
        context: {
          ...context,
          supports: [
            {
              sourceId: id,
              field: tasting.field,
              value: tasting.value,
              span: tasting.value,
            },
          ],
        },
      }).state,
    ).toBe("unknown");
  });
  it("retains only sources that actually support an accepted fact", () => {
    expect(
      decide({
        claim: { ...claim, evidenceIds: [id, second] },
        sources: [
          source,
          {
            ...source,
            id: second,
            identity: wineIdentity({ productName: "Other" }),
          },
        ],
      }).evidenceIds,
    ).toEqual([id]);
  });
});

describe("recommendation citation integrity", () => {
  const recommendation = {
    ...claim,
    id: "00000000-0000-4000-8000-000000000003",
    field: "pairing" as const,
    kind: "recommendation" as const,
    value: "Try roast duck",
    premiseClaimIds: [second],
  };
  it.each(["missing", "unrelated"] as const)(
    "derives premise citations instead of retaining %s citations",
    (scenario) => {
      const unsupported = "00000000-0000-4000-8000-000000000004";
      const sources =
        scenario === "missing"
          ? [source]
          : [
              source,
              {
                ...source,
                id: unsupported,
                identity: wineIdentity({ productName: "Other" }),
              },
            ];
      const result = decide({
        claim: { ...recommendation, evidenceIds: [unsupported] },
        sources,
        context: { ...context, acceptedPremises: [decide()] },
      });
      expect(result.state).toBe("accepted");
      expect(result.evidenceIds).toEqual([id]);
    },
  );
  it("does not derive citations from unavailable premise sources", () => {
    expect(
      decide({
        claim: { ...recommendation, evidenceIds: [] },
        sources: [],
        context: { ...context, acceptedPremises: [decide()] },
      }).state,
    ).toBe("unknown");
  });
  it("does not derive citations from a source for another product", () => {
    expect(
      decide({
        claim: { ...recommendation, evidenceIds: [] },
        sources: [
          { ...source, identity: wineIdentity({ productName: "Other" }) },
        ],
        context: { ...context, acceptedPremises: [decide()] },
      }).state,
    ).toBe("unknown");
  });
});

describe("recommendation claim scope", () => {
  it("rejects brand recommendations with otherwise valid product premises", () => {
    const result = decide({
      claim: {
        ...claim,
        id: "00000000-0000-4000-8000-000000000003",
        field: "pairing",
        value: "Consider grilled vegetables",
        kind: "recommendation",
        scope: "brand",
        premiseClaimIds: [second],
      },
      context: {
        ...context,
        acceptedPremises: [{ ...claim, state: "accepted" }],
      },
    });
    expect(result.state).toBe("rejected");
    expect(result.reason).toBe("invalid_recommendation_scope");
  });
});
