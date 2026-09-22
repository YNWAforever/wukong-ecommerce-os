import { expect, it } from "vitest";
import {
  emptyWorkingListing,
  renderWineDescription,
  type ReviewableListing,
  type WineContent,
} from "@wukong/core";
import * as proposal from "./wine-proposal.js";
import { resolveWineGenerationOwnership } from "./wine-generation-ownership.js";
import { listingInputDigest } from "./repositories/listing-inputs.js";
function base(): ReviewableListing {
  return {
    ...emptyWorkingListing(),
    packQuantity: 1,
    producer: "Original",
    title: { en: "Title", "zh-Hant": "Title" },
    description: { en: "Legacy", "zh-Hant": "Legacy" },
    seo: {
      title: { en: "SEO", "zh-Hant": "SEO" },
      description: { en: "Summary", "zh-Hant": "Summary" },
    },
  };
}
function source(current: ReviewableListing, proposed: ReviewableListing) {
  const input: any = {
    inputDigest: "a".repeat(64),
    workingContent: current,
    fieldStates: {},
  };
  const ownership = resolveWineGenerationOwnership(input, current, current, {
    workspaceId: "test",
    listingId: "listing",
    operationId: "run",
    inputRevision: 1,
    baseVersionId: "base",
  });
  return { input, base: current, proposal: proposed, ownership };
}
const metadata = [
  "title.en",
  "title.zh-Hant",
  "seo.title.en",
  "seo.title.zh-Hant",
  "seo.description.en",
  "seo.description.zh-Hant",
  "tags",
];
it.each(["en", "zh-Hant", "both"])(
  "rejects identity change retaining legacy prose in %s even with all metadata selected",
  (locale) => {
    const current = base();
    if (locale === "en") current.description["zh-Hant"] = "";
    if (locale === "zh-Hant") current.description.en = "";
    const attempt = () =>
      proposal.selectWineProposal(
        source(current, { ...current, producer: "Changed" }),
        [...metadata, "producer"],
      );
    if (locale === "both")
      expect(attempt).toThrow("proposal_identity_retained_content");
    else expect(attempt).toThrow();
  },
);
it("canonicalizes selected section order while preserving existing positions", () => {
  const section = (
    key: "introduction" | "tasting" | "pairing",
  ): WineContent["sections"][number] => ({
    key,
    en: key,
    "zh-Hant": key,
    owner: "automatic",
    locked: false,
    claimIds: [],
  });
  const current = base();
  current.wineOwnership = { schemaVersion: 1, sections: [section("tasting")] };
  current.description = {
    en: renderWineDescription(current.wineOwnership, "en"),
    "zh-Hant": renderWineDescription(current.wineOwnership, "zh-Hant"),
  };
  const next = structuredClone(current);
  next.wineOwnership!.sections.push(
    section("pairing"),
    section("introduction"),
  );
  next.description = {
    en: renderWineDescription(next.wineOwnership!, "en"),
    "zh-Hant": renderWineDescription(next.wineOwnership!, "zh-Hant"),
  };
  const first = proposal.selectWineProposal(source(current, next), [
    "sections.pairing",
    "sections.introduction",
  ]);
  const second = proposal.selectWineProposal(source(current, next), [
    "sections.introduction",
    "sections.pairing",
  ]);
  expect(first).toEqual(second);
  expect(listingInputDigest(first)).toBe(listingInputDigest(second));
  expect(first.wineOwnership!.sections.map((s) => s.key)).toEqual([
    "tasting",
    "introduction",
    "pairing",
  ]);
});
it("preserves legacy prose during safe same-identity metadata selection", () => {
  const current = base(),
    next = { ...current, tags: ["Updated"] };
  expect(
    proposal.selectWineProposal(source(current, next), ["tags"]),
  ).toMatchObject({ tags: ["Updated"], description: current.description });
});
it.each([
  "sku",
  "priceHkd",
  "stockQuantity",
  "description.en",
  "wineOwnership",
  "sections.introduction.en",
])("rejects forbidden path %s", (path) => {
  const current = base();
  expect(() =>
    proposal.selectWineProposal(source(current, current), [path]),
  ).toThrow("proposal_selection_invalid");
});
