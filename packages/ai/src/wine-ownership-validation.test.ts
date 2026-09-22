import { expect, it } from "vitest";
import { wineGenerationRequestSchema } from "./wine-enrichment-schemas.js";
import {
  validateWineGenerationRequest,
  wineCandidateIssues,
} from "./wine-enrichment-content-validation.js";
const metadata = {
  title: { en: "Human", "zh-Hant": "人手" },
  seo: {
    title: { en: "", "zh-Hant": "" },
    description: { en: "", "zh-Hant": "" },
  },
  tags: [],
};
function request(): any {
  return {
    schemaVersion: 1,
    binding: { workspaceId: "w", operationId: "r", inputRevision: 1 },
    claims: [],
    current: null,
    lockedPaths: ["title", "tags"],
    tone: "neutral",
    claimPolicy: [],
    section: null,
    ownership: {
      schemaVersion: 1,
      priorKind: "legacy",
      metadata,
      legacyDescription: { en: "Original whole", "zh-Hant": "原文" },
      lockedPaths: ["title", "tags"],
      provenanceDigest: "a".repeat(64),
    },
  };
}
it("preserves a server-owned legacy artifact without writable candidate description", () => {
  const r = request();
  expect(wineGenerationRequestSchema.parse(r)).toEqual(r);
  expect(() => validateWineGenerationRequest(r)).not.toThrow();
});
it("enforces legacy metadata and locked absence", () => {
  const r = request();
  const c = {
    schemaVersion: 1 as const,
    content: {
      ...metadata,
      title: { en: "Changed", "zh-Hant": "人手" },
      sections: [],
      tags: ["new"],
    },
    annotations: [],
  };
  expect(wineCandidateIssues(r, c)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "protected_content_changed",
        path: "title.en",
      }),
      expect.objectContaining({
        code: "protected_content_introduced",
        path: "tags.0",
      }),
    ]),
  );
});
it("rejects contradictory reader and generation snapshots", () => {
  for (const mutate of [
    (r: any) => (r.lockedPaths = []),
    (r: any) => (r.current = { ...metadata, sections: [] }),
    (r: any) => (r.ownership.legacyDescription = null),
  ]) {
    const r = request();
    mutate(r);
    expect(() => {
      const p = wineGenerationRequestSchema.parse(r);
      validateWineGenerationRequest(p);
    }).toThrow();
  }
});
