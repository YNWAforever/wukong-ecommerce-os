/**
 * The AI-written fields and negative conditions a reviewer must confirm
 * before a listing can be approved.
 *
 * Extracted out of the client-only `ConfirmationChecklist` component
 * (`../components/confirmation-checklist.tsx`) so server-side route handlers
 * -- notably `POST /api/listings/[id]/approve` -- can import the key lists
 * and the `allConfirmed` gate without pulling React/JSX into a route bundle.
 * `confirmation-checklist.tsx` re-exports these three symbols so its
 * existing importers are unaffected.
 *
 * These two lists must stay in the same order and cover the same fields as
 * `FIELD_LABELS`/`NEGATIVE_LABELS` in `confirmation-checklist.tsx` --
 * `confirmation-checklist.test.tsx`'s "cover the 8 AI-writable fields and 7
 * negative conditions" test is what catches drift between the two.
 */
export const CONFIRMATION_FIELD_KEYS = [
  "nameZh",
  "summaryEn",
  "summaryZh",
  "seoTitleEn",
  "seoTitleZh",
  "seoDescriptionEn",
  "seoDescriptionZh",
  "seoKeywords",
];

export const CONFIRMATION_NEGATIVE_KEYS = [
  "priceUnchanged",
  "membershipUnchanged",
  "categoryUnchanged",
  "statusUnchanged",
  "supplierUnchanged",
  "quantityDeltaNeutral",
  "noImageChange",
];

export function allConfirmed(
  fieldConfirmations: Record<string, boolean>,
  negativeConfirmations: Record<string, boolean>,
): boolean {
  return (
    CONFIRMATION_FIELD_KEYS.every((key) => fieldConfirmations[key] === true) &&
    CONFIRMATION_NEGATIVE_KEYS.every(
      (key) => negativeConfirmations[key] === true,
    )
  );
}
