import { z } from "zod";

import type { ToolId } from "./tool-definitions.js";

/**
 * Strict schemas for the versioned Studio skill registry (spec §3.6).
 *
 * Skill definitions are reviewed code, not user data: the deterministic turn
 * pipeline and the hosted MCP server read the same frozen registry, so every
 * shape accepted here is a reviewed capability contract. All objects are
 * strict so an unrecognised key fails loudly instead of being dropped.
 */

const SKILL_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SKILL_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
// Structural check only: the concrete `ToolId` union lives in
// tool-definitions.ts (one-way dependency, no import cycle). The registry
// tests assert that every allowlisted id resolves in TOOL_DEFINITIONS.
const TOOL_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const UPSTREAM_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/;
const PATH_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** Both languages are required; same shape the listing content uses. */
export const bilingualTextSchema = z.strictObject({
  "zh-Hant": z.string().trim().min(1).max(1000),
  en: z.string().trim().min(1).max(1000),
});
export type BilingualText = Readonly<{
  "zh-Hant": string;
  en: string;
}>;

/** Workspace roles, mirroring the membership check constraint. */
export const STUDIO_ROLES = [
  "viewer",
  "operator",
  "reviewer",
  "admin",
  "owner",
] as const;
export type StudioRole = (typeof STUDIO_ROLES)[number];
export const studioRoleSchema = z.enum(STUDIO_ROLES);

/**
 * Mirrors `roleOrder` in apps/web/lib/session-context.ts. The server resolves
 * the role from the membership record; this table only decides whether the
 * registry may execute a skill/tool for that role.
 */
export const STUDIO_ROLE_RANK: Readonly<Record<StudioRole, number>> =
  Object.freeze({
    viewer: 10,
    operator: 20,
    reviewer: 30,
    admin: 40,
    owner: 50,
  });

/** Evidence source kinds (spec §3.3). */
export const SOURCE_KINDS = [
  "listing",
  "catalog",
  "quality",
  "source_import",
  "export_attempt",
  "job",
  "audit",
  "website",
  "workbook",
  "shopline_projection",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const sourceKindSchema = z.enum(SOURCE_KINDS);

/**
 * `pilot` may execute; `planned` and `blocked` render honestly but never run
 * (spec §3.6, plan Task 4).
 */
export const SKILL_STATUSES = ["pilot", "planned", "blocked"] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];
export const skillStatusSchema = z.enum(SKILL_STATUSES);

/**
 * Artifact a skill's turn produces. `gap_report`, `copy_proposal`,
 * `merchant_audit` and `finding` match `studio_outputs.kind` (spec §3.9);
 * `answer` is a deterministic records answer with no artifact, `dispatch`
 * hands off to an existing screen/route, and `none` is used by blocked
 * skills that have no output at all.
 */
export const SKILL_OUTPUT_KINDS = [
  "answer",
  "gap_report",
  "copy_proposal",
  "merchant_audit",
  "finding",
  "dispatch",
  "none",
] as const;
export type SkillOutputKind = (typeof SKILL_OUTPUT_KINDS)[number];
export const skillOutputKindSchema = z.enum(SKILL_OUTPUT_KINDS);

/** Reviewed Studio budget classes (spec §3.11). */
export const SKILL_BUDGET_CLASSES = ["free", "model-turns-v1"] as const;
export type SkillBudgetClass = (typeof SKILL_BUDGET_CLASSES)[number];
export const skillBudgetClassSchema = z.enum(SKILL_BUDGET_CLASSES);

/**
 * Completion predicate a run must satisfy before the turn reports success:
 * validated output schema, evidence pack, then a persisted readback.
 */
export const SKILL_COMPLETIONS = [
  "schema",
  "schema+evidence",
  "schema+evidence+readback",
] as const;
export type SkillCompletion = (typeof SKILL_COMPLETIONS)[number];
export const skillCompletionSchema = z.enum(SKILL_COMPLETIONS);

/**
 * Input description stored as plain data: the model may select a skill or ask
 * for a missing input, but it never supplies the execution contract itself.
 */
export const skillInputDescriptionSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/),
  description: bilingualTextSchema,
});
export type SkillInputDescription = Readonly<{
  name: string;
  description: BilingualText;
}>;

/** Only for playbooks adapted from a reviewed external contract. */
export const skillUpstreamSchema = z.strictObject({
  source: z.string().trim().min(1).max(200),
  commit: z.string().regex(UPSTREAM_COMMIT_PATTERN),
  pathHash: z.string().regex(PATH_HASH_PATTERN),
  licence: z.string().trim().min(1).max(100),
});
export type SkillUpstream = Readonly<{
  source: string;
  commit: string;
  pathHash: string;
  licence: string;
}>;

/**
 * Evidence contract. A skill that cannot find a required source reports
 * `missing`/`null` with a reason; it never substitutes zero or a guess.
 */
export const skillEvidenceSchema = z.strictObject({
  requiredSources: z.array(sourceKindSchema).max(SOURCE_KINDS.length),
  unknownsPolicy: z.literal("null-with-reason"),
});
export type SkillEvidence = Readonly<{
  requiredSources: readonly SourceKind[];
  unknownsPolicy: "null-with-reason";
}>;

export const skillDefinitionSchema = z.strictObject({
  key: z.string().regex(SKILL_KEY_PATTERN),
  version: z.string().regex(SKILL_VERSION_PATTERN),
  status: skillStatusSchema,
  title: bilingualTextSchema,
  outcome: bilingualTextSchema,
  limitation: bilingualTextSchema,
  inputs: z.array(skillInputDescriptionSchema).max(16),
  optionalInputs: z.array(skillInputDescriptionSchema).max(16),
  allowedTools: z.array(z.string().regex(TOOL_ID_PATTERN)).max(10),
  outputKind: skillOutputKindSchema,
  evidence: skillEvidenceSchema,
  budgetClass: skillBudgetClassSchema,
  completion: skillCompletionSchema,
  upstream: skillUpstreamSchema.optional(),
});

/**
 * Readonly view of a validated definition. `allowedTools` is narrowed to the
 * reviewed `ToolId` union so a typo cannot compile; the schema parse at
 * registry construction proves the same values at runtime.
 */
export type SkillDefinition = Readonly<{
  key: string;
  version: string;
  status: SkillStatus;
  title: BilingualText;
  outcome: BilingualText;
  limitation: BilingualText;
  inputs: readonly SkillInputDescription[];
  optionalInputs: readonly SkillInputDescription[];
  allowedTools: readonly ToolId[];
  outputKind: SkillOutputKind;
  evidence: SkillEvidence;
  budgetClass: SkillBudgetClass;
  completion: SkillCompletion;
  upstream?: SkillUpstream;
}>;
