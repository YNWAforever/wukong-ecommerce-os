import { describe, expect, it } from "vitest";
import { webEvidence, wineIdentity } from "./wine-enrichment-fixtures.js";
import {
  resolveWineSourceAuthority,
  resolveWineSourceReliability,
  wineSourceAuthoritySchema,
} from "./wine-source-authority.js";
export const registryEntry = {
  schemaVersion: 1 as const,
  domain: "example.test",
  subject: { kind: "producer" as const, name: "Fixture Estate" },
  proofUrl: "https://example.test/about",
  proofDigest: "a".repeat(64),
  verifiedAt: "2026-09-01T00:00:00Z",
  expiresAt: "2026-10-01T00:00:00Z",
  revokedAt: null,
  verifierId: "reviewer-1",
};
describe("reviewed wine authority registry", () => {
  it("accepts an active exact producer/domain entry", () =>
    expect(
      resolveWineSourceAuthority(
        webEvidence(),
        { kind: "producer", name: wineIdentity().producer! },
        [registryEntry],
        "2026-09-16T00:00:00Z",
      ),
    ).toEqual(registryEntry));
  it.each([
    [[]],
    [[{ ...registryEntry, expiresAt: "2026-09-10T00:00:00Z" }]],
    [[{ ...registryEntry, revokedAt: "2026-09-15T00:00:00Z" }]],
    [
      [
        {
          ...registryEntry,
          subject: { kind: "producer", name: "Another Estate" },
        },
      ],
    ],
    [[{ ...registryEntry, verifiedAt: "2026-09-20T00:00:00Z" }]],
  ])("does not promote unavailable or invalid authority", (entries) =>
    expect(
      resolveWineSourceAuthority(
        webEvidence({ trust: "verified_official" }),
        { kind: "producer", name: "Fixture Estate" },
        entries as (typeof registryEntry)[],
        "2026-09-16T00:00:00Z",
      ),
    ).toBeNull(),
  );
  it("rejects a claimed domain different from the URL host", () =>
    expect(
      resolveWineSourceAuthority(
        webEvidence({ url: "https://evil.test/wine" }),
        { kind: "producer", name: "Fixture Estate" },
        [registryEntry],
        "2026-09-16T00:00:00Z",
      ),
    ).toBeNull());
  it("validates review provenance", () => {
    expect(wineSourceAuthoritySchema.safeParse(registryEntry).success).toBe(
      true,
    );
    expect(
      wineSourceAuthoritySchema.safeParse({
        ...registryEntry,
        proofDigest: "",
        verifierId: "",
      }).success,
    ).toBe(false);
  });
});

describe("reviewed reliability designation", () => {
  const reliable = {
    ...registryEntry,
    subject: { kind: "reliable_source" as const, name: "example.test" },
  };
  const now = "2026-09-16T00:00:00Z";
  it("accepts canonical domain-scoped reliability provenance", () => {
    expect(wineSourceAuthoritySchema.safeParse(reliable).success).toBe(true);
    expect(
      resolveWineSourceReliability(webEvidence(), [reliable], now),
    ).toEqual(reliable);
  });
  it.each([
    "Example.test",
    "https://example.test",
    "Example Store",
    "example.test.",
  ])("rejects noncanonical reliability subject %s", (name) => {
    const entry = { ...reliable, subject: { ...reliable.subject, name } };
    expect(wineSourceAuthoritySchema.safeParse(entry).success).toBe(false);
    expect(
      resolveWineSourceReliability(webEvidence(), [reliable, entry], now),
    ).toBeNull();
  });
  it.each([
    { expiresAt: "2026-09-15T00:00:00Z" },
    { verifiedAt: "2026-09-17T00:00:00Z" },
    { revokedAt: "2026-09-15T00:00:00Z" },
  ])("withholds expired, future and revoked reviews %j", (override) => {
    expect(
      resolveWineSourceReliability(
        webEvidence(),
        [{ ...reliable, ...override }],
        now,
      ),
    ).toBeNull();
  });
  it("revocation wins over stale active copies", () => {
    expect(
      resolveWineSourceReliability(
        webEvidence(),
        [reliable, { ...reliable, revokedAt: "2026-09-15T00:00:00Z" }],
        now,
      ),
    ).toBeNull();
  });
  it("reliability cannot confer producer or original-authority status", () => {
    for (const kind of ["producer", "authority"] as const)
      expect(
        resolveWineSourceAuthority(
          webEvidence(),
          { kind, name: "example.test" },
          [reliable],
          now,
        ),
      ).toBeNull();
    expect(
      resolveWineSourceReliability(webEvidence(), [registryEntry], now),
    ).toBeNull();
  });
  it("checks URL hostname and server clock independently of source tags", () => {
    expect(
      resolveWineSourceReliability(
        webEvidence({ url: "https://wrong.test/page", trust: "reliable" }),
        [reliable],
        now,
      ),
    ).toBeNull();
    expect(
      resolveWineSourceReliability(webEvidence(), [reliable], "invalid"),
    ).toBeNull();
    expect(
      resolveWineSourceReliability(webEvidence({ trust: "reliable" }), [], now),
    ).toBeNull();
  });
});
