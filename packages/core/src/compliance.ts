import type { AuditContext, AuditWriter } from "./audit.js";

type ComplianceFlagFields = {
  id: string;
  field: string;
  rule:
    "health_claim" | "guarantee" | "rating_without_evidence" | "superlative";
  severity: "blocking" | "warning";
};

export type ComplianceFlag = ComplianceFlagFields &
  (
    | { status: "open"; resolutionReason: null }
    | { status: "resolved"; resolutionReason: string }
  );

const blockingPatterns = [
  { rule: "health_claim" as const, pattern: /health benefit|治療|保健功效/i },
  { rule: "guarantee" as const, pattern: /guaranteed|保證/i },
];

/**
 * Wording that asserts a rank rather than a property.
 *
 * A warning, not a blocker. "Finest" is a claim someone has to stand behind,
 * but stopping every listing that uses one would stop the pilot, and the flag
 * already forces a human to look. Kept narrow on purpose: "perfect with grilled
 * lamb" is a pairing suggestion, not a superlative, so `perfect` is not here.
 */
const SUPERLATIVE =
  // No `\b` before `#`: it is not a word character, so the boundary can never
  // match at the start of "#1 in its appellation".
  /\b(?:the\s+)?(?:best|finest|greatest|unrivall?ed|unmatched|unsurpassed|number\s+one)\b|\bworld'?s\s+(?:best|finest)\b|#\s?1\b|最佳|最好|最頂級|世界第一|無與倫比/i;

/**
 * Wording that asserts a score or an award.
 *
 * Deliberately matches the CLAIM, not the value: `95 points`, `RP 95`, `gold
 * medal`, a named critic. Whether the claim is allowed is decided by whether
 * the listing carries a grounded `criticScores` or `awards` fact -- and a fact
 * exists only if extraction tied it to an evidence excerpt.
 */
const RATING_CLAIM =
  /\b\d{2,3}\s*(?:points|pts)\b|\b(?:RP|WS|JS|WA|AG)\s?\d{2,3}\b|\b(?:robert\s+parker|wine\s+spectator|james\s+suckling|decanter|jancis\s+robinson|wine\s+advocate)\b|\b(?:gold|silver|bronze)\s+medal\b|\b\d{2,3}\s*分\b|金獎|銀獎|銅獎|帕克/i;

/**
 * What the listing can actually support, as extracted and grounded.
 *
 * Only the counts matter: a fact exists at all only if extraction tied it to an
 * evidence excerpt, so "this listing has a critic score" already means
 * "something in the source said so".
 */
export type GroundedClaims = {
  criticScores: readonly unknown[];
  awards: readonly unknown[];
};

/**
 * Flags in generated or edited copy.
 *
 * `rating_without_evidence` and `superlative` were declared in the flag type and
 * given bilingual labels on the review screen, but no pattern produced either,
 * so both sets of UI strings were unreachable -- and a description could assert
 * "Awarded 100 points by Robert Parker" with `criticScores: []` and pass every
 * check between the model and a merchant's storefront.
 *
 * `claims` is optional so the rating rule fires only when the caller genuinely
 * knows what the listing supports. Guessing either way is worse: without the
 * facts, an unsupported score and a perfectly grounded one are the same
 * sentence.
 */
export function scanCompliance(
  fields: Record<string, string>,
  claims?: GroundedClaims,
): ComplianceFlag[] {
  const canSupportARating =
    claims === undefined ||
    claims.criticScores.length > 0 ||
    claims.awards.length > 0;
  return Object.entries(fields).flatMap(([field, value]) => {
    const flags: ComplianceFlag[] = blockingPatterns
      .filter(({ pattern }) => pattern.test(value))
      .map(({ rule }, index) => ({
        id: `${field}:${rule}:${index}`,
        field,
        rule,
        severity: "blocking" as const,
        status: "open" as const,
        resolutionReason: null,
      }));
    if (!canSupportARating && RATING_CLAIM.test(value)) {
      flags.push({
        id: `${field}:rating_without_evidence:0`,
        field,
        rule: "rating_without_evidence",
        severity: "blocking",
        status: "open",
        resolutionReason: null,
      });
    }
    if (SUPERLATIVE.test(value)) {
      flags.push({
        id: `${field}:superlative:0`,
        field,
        rule: "superlative",
        // See SUPERLATIVE: a rank claim needs a person to look, not a full stop.
        severity: "warning",
        status: "open",
        resolutionReason: null,
      });
    }
    return flags;
  });
}

/**
 * The copy a compliance scan reads, as one flat map.
 *
 * Shared so the pipeline and the operator's save look at the SAME eight fields.
 * Two private copies of this list is how a rule ends up enforced on generated
 * copy and not on edited copy, which is the gap that let an operator type a
 * claim in after generation and have nothing notice.
 */
export function localizedCopyFields(listing: {
  title: { en: string; "zh-Hant": string };
  description: { en: string; "zh-Hant": string };
  seo: {
    title: { en: string; "zh-Hant": string };
    description: { en: string; "zh-Hant": string };
  };
}): Record<string, string> {
  return {
    titleEn: listing.title.en,
    titleZhHant: listing.title["zh-Hant"],
    descriptionEn: listing.description.en,
    descriptionZhHant: listing.description["zh-Hant"],
    seoTitleEn: listing.seo.title.en,
    seoTitleZhHant: listing.seo.title["zh-Hant"],
    seoDescriptionEn: listing.seo.description.en,
    seoDescriptionZhHant: listing.seo.description["zh-Hant"],
  };
}

/**
 * Re-scan results, with answers the operator already gave kept.
 *
 * A re-scan alone would undo every resolution on every save, so a flag someone
 * had answered would come back open and block approval again. Carrying every
 * resolution instead would be worse: the operator could resolve a flag, rewrite
 * the flagged sentence into something else objectionable, and keep the old
 * answer attached to text it was never about.
 *
 * So a resolution survives only while the field it was raised on is untouched.
 * Edit that field and the flag comes back open, with the change in front of the
 * person who has to justify it.
 */
export function carryResolutions(
  scanned: readonly ComplianceFlag[],
  previous: readonly ComplianceFlag[],
  unchangedFields: ReadonlySet<string>,
): ComplianceFlag[] {
  return scanned.map((flag) => {
    if (!unchangedFields.has(flag.field)) return flag;
    const answered = previous.find(
      (candidate) =>
        candidate.id === flag.id && candidate.status === "resolved",
    );
    return answered ?? flag;
  });
}

export async function resolveFlag(
  flag: ComplianceFlag,
  reason: string,
  auditContext: AuditContext,
  auditWriter: AuditWriter,
): Promise<ComplianceFlag> {
  const resolutionReason = reason.trim();
  if (resolutionReason.length < 10) {
    throw new Error("A meaningful resolution reason is required");
  }
  const resolved: ComplianceFlag = {
    ...flag,
    status: "resolved",
    resolutionReason,
  };
  await auditWriter.write({
    ...auditContext,
    action: "compliance.flag_resolved",
    metadata: {
      flagId: flag.id,
      field: flag.field,
      rule: flag.rule,
      resolutionReason,
    },
  });
  return resolved;
}
