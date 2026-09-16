import { expect, it } from "vitest";
import {
  emptyWorkingListing,
  workingListingSchema,
  applyWorkingChanges,
  workingBaselineForReview,
} from "./working-listing.js";
import { reviewableListingSchema } from "./listing-schema.js";
const section = {
  key: "introduction",
  en: "Original",
  "zh-Hant": "原文",
  claimIds: [],
  locked: false,
  owner: "automatic",
} as const;
function listing() {
  return {
    ...emptyWorkingListing(),
    title: { en: "Title", "zh-Hant": "標題" },
    description: { en: "Original", "zh-Hant": "原文" },
    seo: {
      title: { en: "Title", "zh-Hant": "標題" },
      description: { en: "Copy", "zh-Hant": "內容" },
    },
    wineOwnership: {
      schemaVersion: 1,
      sections: [{ ...section, claimIds: [] }],
    },
  };
}
it("retains exact structured ownership in working and review parsing", () => {
  const c = listing();
  expect(workingListingSchema.parse(c)).toEqual(c);
  expect(reviewableListingSchema.parse({ ...c, packQuantity: 1 })).toEqual({
    ...c,
    packQuantity: 1,
  });
});
it("invalidates structure after whole-description edit and preserves other locale verbatim", () => {
  const c = listing();
  const result = applyWorkingChanges(c, {}, [
    { field: "description.en", value: "Human whole paragraph" },
  ]);
  expect(result.content).not.toHaveProperty("wineOwnership");
  expect(result.content.description["zh-Hant"]).toBe("原文");
  expect(result.fieldStates["description.en"]?.owner).toBe("operator");
});
it("retains authoritative active version section mapping in editable baseline", () => {
  const result = workingBaselineForReview(emptyWorkingListing(), {}, listing());
  expect(result.workingContent).toHaveProperty(
    "wineOwnership.sections.0.key",
    "introduction",
  );
});
import {
  editWineSections,
  mergeWineSections,
  renderWineDescription,
  inheritWineOwnership,
} from "./wine-content.js";
it("preserves omitted protected sections and renders optional paragraphs deterministically", () => {
  const current = {
    ...listing(),
    sections: [{ ...section, claimIds: [], owner: "operator" as const }],
  };
  const merged = mergeWineSections(current, { ...current, sections: [] });
  expect(merged.sections).toEqual(current.sections);
  expect(
    renderWineDescription(
      {
        sections: [
          { ...section, en: "  " },
          { ...section, en: " Text " },
        ],
      } as any,
      "en",
    ),
  ).toBe("Text");
});
it("section edits reject forged ownership, missing mappings and unrecognized keys", () => {
  const c = workingListingSchema.parse(listing());
  expect(
    editWineSections(c, [
      { key: "introduction", en: "Human", "zh-Hant": "人手" },
    ]).wineOwnership?.sections[0],
  ).toMatchObject({ owner: "operator", claimIds: [] });
  expect(() =>
    editWineSections(c, [{ key: "pairing", en: "Human", "zh-Hant": "人手" }]),
  ).toThrow();
  expect(() =>
    editWineSections(c, [
      {
        key: "introduction",
        en: "Human",
        "zh-Hant": "人手",
        owner: "automatic",
      } as any,
    ]),
  ).toThrow();
  expect(() => editWineSections(emptyWorkingListing(), [])).toThrow();
  expect(() => inheritWineOwnership(null, c)).toThrow(
    "wine_ownership_server_only",
  );
});
it("legacy candidates cannot erase protected structured sections", () => {
  const c = workingListingSchema.parse(listing());
  c.wineOwnership!.sections[0]!.owner = "operator";
  const candidate = {
    ...emptyWorkingListing(),
    description: { en: "New legacy", "zh-Hant": "新文" },
  };
  const result = workingBaselineForReview(c, {}, candidate);
  expect(result.workingContent.description).toEqual(c.description);
  expect(result.workingContent.wineOwnership).toEqual(c.wineOwnership);
});
it.each(
  (["en", "zh-Hant"] as const).flatMap((locale) =>
    (["operator", "lock"] as const).flatMap((fieldProtection) =>
      (["operator", "lock"] as const).map((sectionProtection) => ({
        locale,
        fieldProtection,
        sectionProtection,
      })),
    ),
  ),
)(
  "composes $locale whole-field $fieldProtection with bilingual section $sectionProtection",
  ({ locale, fieldProtection, sectionProtection }) => {
    const current = workingListingSchema.parse(listing());
    current.wineOwnership!.sections[0]!.owner =
      sectionProtection === "operator" ? "operator" : "automatic";
    current.wineOwnership!.sections[0]!.locked = sectionProtection === "lock";
    const candidate = workingListingSchema.parse(listing());
    candidate.wineOwnership!.sections[0]!.en = "Candidate English";
    candidate.wineOwnership!.sections[0]!["zh-Hant"] = "Candidate Chinese";
    candidate.description = {
      en: "Candidate English",
      "zh-Hant": "Candidate Chinese",
    };
    const states = {
      [`description.${locale}`]: {
        owner:
          fieldProtection === "operator"
            ? ("operator" as const)
            : ("ai" as const),
        state: "manual" as const,
        locked: fieldProtection === "lock",
        evidenceRefs: [],
      },
    };
    const result = workingBaselineForReview(
      current,
      states,
      candidate,
    ).workingContent;
    expect(result.description).toEqual(current.description);
    expect(result.wineOwnership).toEqual(current.wineOwnership);
    expect(result.description.en).toBe(
      renderWineDescription(result.wineOwnership!, "en"),
    );
    expect(result.description["zh-Hant"]).toBe(
      renderWineDescription(result.wineOwnership!, "zh-Hant"),
    );
  },
);
