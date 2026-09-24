import type { ReviewableListing } from "@wukong/core";

/**
 * Where one AI-writable confirmation field lives, in content and in evidence.
 */
export type ReviewFieldBinding = {
  /** The confirmed value, read from the version content as stored. */
  read(content: ReviewableListing): string | readonly string[];
  /**
   * Matches `field_evidence.fieldPath` exactly -- `evidenceFor` in
   * `listing-review-client.tsx` compares with `===`.
   */
  evidenceKey: string;
};

/**
 * Each confirmation key's content path and evidence key.
 *
 * Two maps already existed and neither fit. `listing-review-client.tsx`'s field
 * descriptors are client code, and three of their keys differ from these
 * (`titleZhHant`, `descriptionEn`, `descriptionZhHant`).
 * `canonical-listing-gaps.ts` uses these keys but omits `seoDescriptionZh` and
 * reads keywords as a joined string, which is right for gap checks and wrong
 * for a digest.
 *
 * A leaf with only a type import, so the review UI can consume the evidence
 * keys and the ledger can consume the readers without either pulling in the
 * other's dependencies. Hashing lives in `review-field-records.ts`, which is
 * server-only.
 *
 * The keys are the bulk-form column keys too: `BULK_FORM_COLUMNS` carries all
 * eight under these exact names, which is how the imported cell is found.
 */
export const REVIEW_FIELD_BINDINGS = {
  nameZh: {
    read: (content) => content.title["zh-Hant"],
    evidenceKey: "title.zh-Hant",
  },
  summaryEn: {
    read: (content) => content.description.en,
    evidenceKey: "description.en",
  },
  summaryZh: {
    read: (content) => content.description["zh-Hant"],
    evidenceKey: "description.zh-Hant",
  },
  seoTitleEn: {
    read: (content) => content.seo.title.en,
    evidenceKey: "seo.title.en",
  },
  seoTitleZh: {
    read: (content) => content.seo.title["zh-Hant"],
    evidenceKey: "seo.title.zh-Hant",
  },
  seoDescriptionEn: {
    read: (content) => content.seo.description.en,
    evidenceKey: "seo.description.en",
  },
  seoDescriptionZh: {
    read: (content) => content.seo.description["zh-Hant"],
    evidenceKey: "seo.description.zh-Hant",
  },
  seoKeywords: {
    // The array, not `tags.join(", ")`: joining is not injective, so one
    // keyword containing a comma and two keywords would digest identically.
    read: (content) => content.tags,
    evidenceKey: "tags",
  },
} satisfies Record<string, ReviewFieldBinding>;
