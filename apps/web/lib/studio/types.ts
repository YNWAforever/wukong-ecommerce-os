import { z } from "zod";

import {
  SOURCE_KINDS,
  type SkillDefinition,
  type SourceKind,
} from "@wukong/core";

/**
 * Conversation-turn contracts for the deterministic Studio (plan Task 5).
 *
 * Sections, checks, limitations and follow-ups are stored as copy keys plus
 * values, never formatted prose: the same persisted turn renders in either
 * locale, and the copy parity tests can police the wording (spec §3.3).
 */

export const evidenceCoverageSchema = z.enum([
  "present",
  "missing",
  "unsupported",
]);
export type EvidenceCoverage = z.infer<typeof evidenceCoverageSchema>;

export const translatedValuesSchema = z.record(
  z.string(),
  z.union([z.string().max(1000), z.number(), z.boolean()]),
);
export type TranslatedValues = z.infer<typeof translatedValuesSchema>;

export const translatedLineSchema = z.strictObject({
  key: z
    .string()
    .regex(/^[a-zA-Z0-9_.]+$/)
    .max(120),
  values: translatedValuesSchema,
});
export type TranslatedLine = z.infer<typeof translatedLineSchema>;

export const evidenceSourceSchema = z.strictObject({
  /** Stable identity for citation anchors, e.g. `listing:<uuid>:v3`. */
  ref: z.string().min(1).max(200),
  kind: z.enum(SOURCE_KINDS),
  /** Data text (a listing title, a job kind), never product copy. */
  label: z.string().max(300),
  refId: z.string().min(1).max(200),
  version: z.string().max(200).nullable(),
  asOf: z.iso.datetime({ offset: true }),
  coverage: evidenceCoverageSchema,
  deepLink: z.string().max(500).nullable(),
  restricted: z.boolean(),
});
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const evidenceCheckSchema = z.strictObject({
  key: z
    .string()
    .regex(/^[a-zA-Z0-9_.]+$/)
    .max(120),
  values: translatedValuesSchema,
  state: z.enum(["ok", "gap", "missing", "unsupported"]),
});
export type EvidenceCheck = z.infer<typeof evidenceCheckSchema>;

export const turnReplySchema = z.strictObject({
  status: z.enum(["answered", "needs_input", "partial"]),
  skillKey: z.string().min(1).max(120),
  skillVersion: z.string().min(1).max(40),
  records: z.strictObject({
    sections: z.array(translatedLineSchema).max(12),
    checks: z.array(evidenceCheckSchema).max(50),
    coverage: z.record(z.string(), evidenceCoverageSchema),
  }),
  outputs: z
    .array(
      z.strictObject({
        outputId: z.string().min(1).max(200),
        revision: z.number().int().min(1),
      }),
    )
    .max(10),
  traceSummary: z.strictObject({
    stepCount: z.number().int().min(0).max(64),
  }),
  limitations: z.array(translatedLineSchema).max(10),
  followUps: z.array(translatedLineSchema).max(6),
});
export type StudioTurnReply = z.infer<typeof turnReplySchema>;

/** One persisted execution-trace entry; `key`+`values` render to copy later. */
export type StudioTraceStep = {
  kind: "tool" | "evidence";
  toolId: string | null;
  state: "started" | "done" | "failed" | "unavailable" | "blocked" | "info";
  durationMs: number | null;
  detail: TranslatedLine;
};

export type EvidencePack = {
  sources: EvidenceSource[];
  checks: EvidenceCheck[];
  coverage: Map<SourceKind, EvidenceCoverage>;
  sections: TranslatedLine[];
  limitations: TranslatedLine[];
  followUps: TranslatedLine[];
  trace: StudioTraceStep[];
};

/** What a skill turn needs, shaped for deterministic composition. */
export type StudioTurnInput = {
  skill: SkillDefinition;
  query: string | null;
  listingIds: readonly string[];
  limit: number;
  locale: "zh-Hant" | "en";
  now: Date;
};

export type NeedsInput = {
  status: "needs_input";
  skill: SkillDefinition;
  question: TranslatedLine;
};

export function translatedLine(
  key: string,
  values: TranslatedValues = {},
): TranslatedLine {
  return { key, values };
}

export function coverageMap(
  required: readonly SourceKind[],
): Map<SourceKind, EvidenceCoverage> {
  const coverage = new Map<SourceKind, EvidenceCoverage>();
  for (const kind of SOURCE_KINDS) coverage.set(kind, "unsupported");
  for (const kind of required) coverage.set(kind, "missing");
  return coverage;
}

export function coverageRecord(
  coverage: Map<SourceKind, EvidenceCoverage>,
): Record<string, EvidenceCoverage> {
  const record: Record<string, EvidenceCoverage> = {};
  for (const [kind, value] of coverage) {
    if (value !== "unsupported") record[kind] = value;
  }
  return record;
}
