import type { SkillDefinition } from "@wukong/core";

import {
  coverageRecord,
  translatedLine,
  turnReplySchema,
  draftDispatchSchema,
  type EvidencePack,
  type NeedsInput,
  type StudioTurnReply,
  type TranslatedValues,
} from "./types";

/**
 * Deterministic composer for the two pilot skills (plan Task 5).
 *
 * It returns copy keys plus values, never sentences: the persisted turn is
 * locale-independent and Task 7 renders it through `STUDIO_COPY`. Counted
 * values come from the evidence pack only.
 */

function checkValues(pack: EvidencePack, key: string): TranslatedValues | null {
  const check = pack.checks.find((entry) => entry.key === key);
  return check?.values ?? null;
}

function numberValue(values: TranslatedValues | null, name: string): number {
  const value = values?.[name];
  return typeof value === "number" ? value : 0;
}

function presentCount(pack: EvidencePack): number {
  let count = 0;
  for (const coverage of pack.coverage.values())
    if (coverage === "present") count += 1;
  return count;
}

function missingKinds(pack: EvidencePack): string[] {
  return [...pack.coverage.entries()]
    .filter(([, coverage]) => coverage === "missing")
    .map(([kind]) => kind);
}

export function composeDeterministicReply(input: {
  skill: SkillDefinition;
  pack: EvidencePack;
}): StudioTurnReply {
  const { skill, pack } = input;
  const missing = missingKinds(pack);
  const status = missing.length === 0 ? "answered" : "partial";
  const sections = [
    translatedLine("studio.answer.heading", {
      skill: skill.key,
      skillVersion: skill.version,
    }),
    translatedLine("studio.answer.coverage", {
      present: presentCount(pack),
      missing: missing.length,
      missingKinds: missing.join(","),
    }),
  ];

  if (skill.key === "catalog.find") {
    const matches = checkValues(pack, "studio.check.catalog_matches");
    const quality = checkValues(pack, "studio.check.quality_summary");
    const jobs = checkValues(pack, "studio.check.recent_jobs");
    sections.push(
      translatedLine("studio.answer.catalog_found", {
        count: numberValue(matches, "count"),
        truncated: Boolean(matches?.truncated),
      }),
    );
    if (quality)
      sections.push(
        translatedLine("studio.answer.quality_summary", {
          totalListings: numberValue(quality, "totalListings"),
          totalAssessed: numberValue(quality, "totalAssessed"),
          cleanCount: numberValue(quality, "cleanCount"),
          hasGapsCount: numberValue(quality, "hasGapsCount"),
          projectionState: String(quality.projectionState ?? "unknown"),
        }),
      );
    if (jobs)
      sections.push(
        translatedLine("studio.answer.recent_jobs", {
          count: numberValue(jobs, "count"),
        }),
      );
  } else if (skill.key === "catalog.gap_review") {
    const gapChecks = pack.checks.filter(
      (check) => check.key === "studio.check.content_gap",
    );
    const blocked = gapChecks.filter(
      (check) => check.values.blocking === true,
    ).length;
    const quality = checkValues(pack, "studio.check.quality_summary");
    sections.push(
      translatedLine("studio.answer.gap_review", {
        contentGaps: gapChecks.length,
        blockingGaps: blocked,
      }),
    );
    if (quality)
      sections.push(
        translatedLine("studio.answer.workspace_quality", {
          totalListings: numberValue(quality, "totalListings"),
          cleanCount: numberValue(quality, "cleanCount"),
          hasGapsCount: numberValue(quality, "hasGapsCount"),
          noActiveVersion: numberValue(quality, "noActiveVersion"),
        }),
      );
  } else if (skill.key === "listing.copy_proposal") {
    const copyChecks = pack.checks.filter(
      (check) => check.key === "studio.check.copy_current",
    );
    const present = copyChecks.filter(
      (check) => check.values.present === true,
    ).length;
    const copyGaps = pack.checks.filter(
      (check) => check.key === "studio.check.copy_gap",
    ).length;
    sections.push(
      translatedLine("studio.answer.copy_current", {
        fields: copyChecks.length,
        present,
        gaps: copyGaps,
        proposal: "pending",
      }),
    );
  } else if (skill.key === "listing.draft_from_sources") {
    const assetCheck = pack.checks.find(
      (check) => check.key === "studio.check.draft_assets",
    );
    sections.push(
      translatedLine("studio.answer.draft_ready", {
        assets: numberValue(assetCheck?.values ?? null, "count"),
        missing: numberValue(assetCheck?.values ?? null, "missing"),
      }),
    );
  } else if (skill.key === "merchant.audit") {
    const listingCounts = checkValues(
      pack,
      "studio.check.audit_listing_counts",
    );
    const quality = checkValues(pack, "studio.check.audit_quality");
    const exports = checkValues(pack, "studio.check.audit_exports");
    sections.push(
      translatedLine("studio.answer.audit_report", {
        listings: numberValue(listingCounts, "total"),
        clean: numberValue(quality, "cleanCount"),
        gaps: numberValue(quality, "hasGapsCount"),
        exports: numberValue(exports, "count"),
      }),
    );
  } else if (skill.key === "category.map_proposal") {
    const candidates = checkValues(
      pack,
      "studio.check.category_catalog_candidates",
    );
    const current = checkValues(pack, "studio.check.category_current");
    sections.push(
      translatedLine("studio.answer.category_map", {
        candidates: numberValue(candidates, "candidates"),
        current: String(current?.current ?? "unknown"),
      }),
    );
  }

  const dispatch = draftDispatchSchema.safeParse(pack.context.draftDispatch);
  const parsedDispatch = dispatch.success ? dispatch.data : null;
  // A draft turn is only "answered" when the prepared dispatch is actually
  // ready. A partial asset resolution stays visibly partial.
  const replyStatus =
    skill.key === "listing.draft_from_sources"
      ? parsedDispatch?.ready === true && pack.limitations.length === 0
        ? "answered"
        : "partial"
      : status;

  return turnReplySchema.parse({
    status: replyStatus,
    skillKey: skill.key,
    skillVersion: skill.version,
    records: {
      sections,
      checks: pack.checks,
      coverage: coverageRecord(pack.coverage),
    },
    outputs: [],
    dispatch: parsedDispatch,
    analysis: null,
    traceSummary: { stepCount: pack.trace.length },
    limitations: pack.limitations,
    followUps: pack.followUps,
  });
}

export function composeNeedsInputReply(needs: NeedsInput): StudioTurnReply {
  return turnReplySchema.parse({
    status: "needs_input",
    skillKey: needs.skill.key,
    skillVersion: needs.skill.version,
    records: { sections: [], checks: [], coverage: {} },
    outputs: [],
    dispatch: null,
    analysis: null,
    traceSummary: { stepCount: 0 },
    limitations: [],
    followUps: [needs.question],
  });
}
