/**
 * Studio skill and tool manifest (roadmap C4, skill-authoring harness).
 *
 * The registries in `skill-definitions.ts` / `tool-definitions.ts` are the
 * source of truth; this module projects them into a serialisable, stable
 * manifest for authors, docs and change detection. It adds no runtime
 * behaviour and never executes a skill.
 *
 * Rules:
 *  - every skill and tool appears exactly once;
 *  - prompt bindings only reference prompt versions that exist;
 *  - the fingerprint is a pure function of the manifest (no node:crypto, so
 *    this module stays safe for any client that imports core), and changes when
 *    any version, status, source, tool, budget/completion class or prompt
 *    version changes.
 */

import type { StudioPromptKey } from "./studio-prompt-versions.js";
import { STUDIO_PROMPT_VERSIONS } from "./studio-prompt-versions.js";
import type {
  BilingualText,
  SkillBudgetClass,
  SkillCompletion,
  SkillOutputKind,
  SkillStatus,
  SourceKind,
  StudioRole,
} from "./skill-schemas.js";
import { SKILL_DEFINITIONS } from "./skill-definitions.js";
import {
  TOOL_DEFINITIONS,
  type ToolCostClass,
  type ToolKind,
} from "./tool-definitions.js";

export type StudioSkillManifestEntry = Readonly<{
  key: string;
  version: string;
  status: SkillStatus;
  title: BilingualText;
  allowedTools: readonly string[];
  requiredSources: readonly SourceKind[];
  outputKind: SkillOutputKind;
  budgetClass: SkillBudgetClass;
  completion: SkillCompletion;
  inputs: readonly string[];
  optionalInputs: readonly string[];
  promptKeys: readonly StudioPromptKey[];
  upstream: Readonly<{
    source: string;
    commit: string;
    pathHash: string;
    licence: string;
  }> | null;
}>;

export type StudioToolManifestEntry = Readonly<{
  id: string;
  kind: ToolKind;
  minRole: StudioRole;
  costClass: ToolCostClass;
  capabilityId: string;
  maxResultBytes: number;
}>;

export type StudioSkillManifest = Readonly<{
  promptVersions: Readonly<typeof STUDIO_PROMPT_VERSIONS>;
  skills: readonly StudioSkillManifestEntry[];
  tools: readonly StudioToolManifestEntry[];
}>;

/**
 * Which prompt versions a skill may pin. Deterministic skills bind no prompt;
 * model-capable skills bind exactly the prompts their operation uses. A new
 * model path must add its binding here in the same change that adds the prompt
 * version.
 */
export const STUDIO_SKILL_PROMPT_BINDINGS: Readonly<
  Record<string, readonly StudioPromptKey[]>
> = Object.freeze({
  "catalog.find": ["planner", "composer"],
  "catalog.gap_review": ["planner", "composer"],
  "listing.copy_proposal": ["proposer"],
  "listing.draft_from_sources": [],
  "merchant.audit": [],
  "category.map_proposal": ["categoryProposer"],
  "product_shot.prepare": [],
  "supplier.intel_proposal": [],
  "customer.reply_draft": [],
  "logistics.followup": [],
});

export function studioSkillManifest(): StudioSkillManifest {
  const skills = SKILL_DEFINITIONS.map((skill): StudioSkillManifestEntry => ({
    key: skill.key,
    version: skill.version,
    status: skill.status,
    title: { ...skill.title },
    allowedTools: [...skill.allowedTools],
    requiredSources: [...skill.evidence.requiredSources],
    outputKind: skill.outputKind,
    budgetClass: skill.budgetClass,
    completion: skill.completion,
    inputs: skill.inputs.map((input) => input.name),
    optionalInputs: skill.optionalInputs.map((input) => input.name),
    promptKeys: [...(STUDIO_SKILL_PROMPT_BINDINGS[skill.key] ?? [])],
    upstream: skill.upstream ? { ...skill.upstream } : null,
  })).sort((left, right) => left.key.localeCompare(right.key));
  const tools = TOOL_DEFINITIONS.map((tool): StudioToolManifestEntry => ({
    id: tool.id,
    kind: tool.kind,
    minRole: tool.minRole,
    costClass: tool.costClass,
    capabilityId: tool.capabilityId,
    maxResultBytes: tool.maxResultBytes,
  })).sort((left, right) => left.id.localeCompare(right.id));
  return {
    promptVersions: { ...STUDIO_PROMPT_VERSIONS },
    skills,
    tools,
  };
}

/**
 * Stable canonical JSON: object keys are written in insertion order here (the
 * manifest projection already emits deterministic, sorted arrays), which is
 * enough for a change-detection fingerprint because every consumer compares
 * fingerprints produced by this same function.
 */
function canonicalManifest(manifest: StudioSkillManifest): string {
  const promptKeys = Object.keys(manifest.promptVersions).sort();
  return JSON.stringify({
    promptVersions: promptKeys.map((key) => [
      key,
      manifest.promptVersions[key as StudioPromptKey],
    ]),
    skills: manifest.skills.map((skill) => [
      skill.key,
      skill.version,
      skill.status,
      skill.outputKind,
      skill.budgetClass,
      skill.completion,
      skill.allowedTools,
      skill.requiredSources,
      skill.inputs,
      skill.optionalInputs,
      skill.promptKeys,
      skill.upstream,
    ]),
    tools: manifest.tools.map((tool) => [
      tool.id,
      tool.kind,
      tool.minRole,
      tool.costClass,
      tool.capabilityId,
      tool.maxResultBytes,
    ]),
  });
}

/** FNV-1a 64-bit hex fingerprint; pure and stable across runtimes. */
export function studioSkillManifestFingerprint(): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(
    canonicalManifest(studioSkillManifest()),
  );
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
