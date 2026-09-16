import { scanCompliance, type GroundedClaims } from "./compliance.js";
import {
  externalClaimSchema,
  type ExternalClaim,
} from "./external-claim-support.js";
export const claimCopyFields = [
  "title.en",
  "title.zh-Hant",
  "description.en",
  "description.zh-Hant",
  "seo.title.en",
  "seo.title.zh-Hant",
  "seo.description.en",
  "seo.description.zh-Hant",
] as const;
export type ClaimCopyField = (typeof claimCopyFields)[number];
export const complianceCopyField: Record<ClaimCopyField, string> = {
  "title.en": "titleEn",
  "title.zh-Hant": "titleZhHant",
  "description.en": "descriptionEn",
  "description.zh-Hant": "descriptionZhHant",
  "seo.title.en": "seoTitleEn",
  "seo.title.zh-Hant": "seoTitleZhHant",
  "seo.description.en": "seoDescriptionEn",
  "seo.description.zh-Hant": "seoDescriptionZhHant",
};
export function renderExternalClaim(
  input: ExternalClaim,
  locale: "en" | "zh-Hant",
): string {
  const claim = externalClaimSchema.parse(input);
  if (claim.kind === "rating")
    return locale === "en"
      ? claim.critic +
          ": " +
          claim.value +
          "/" +
          claim.scale +
          " points (" +
          claim.year +
          ")."
      : claim.critic +
          "：" +
          claim.value +
          "/" +
          claim.scale +
          " 分（" +
          claim.year +
          "）。";
  return claim.name + " (" + claim.edition + ").";
}
export function claimIdentitySnapshot(content: Record<string, unknown>) {
  return Object.fromEntries(
    [
      "producer",
      "productType",
      "country",
      "region",
      "vintage",
      "volumeMl",
      "packQuantity",
      "title",
    ].map((key) => [key, content[key] ?? null]),
  );
}
/** A valid stored support licenses exactly one occurrence. Other claims and all non-rating checks remain intact. */
export function scanCopyWithClaimSupport(
  fields: Record<string, string>,
  claims: GroundedClaims,
  supports: readonly { field: string; text: string }[],
) {
  const remaining = { ...fields };
  for (const support of supports)
    if (typeof remaining[support.field] === "string")
      remaining[support.field] = remaining[support.field]!.replace(
        support.text,
        "",
      );
  return [
    ...scanCompliance(fields, claims).filter(
      (flag) => flag.rule !== "rating_without_evidence",
    ),
    ...scanCompliance(remaining, claims).filter(
      (flag) => flag.rule === "rating_without_evidence",
    ),
  ];
}
