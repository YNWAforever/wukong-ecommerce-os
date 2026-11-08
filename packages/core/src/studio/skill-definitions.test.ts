import { describe, expect, it } from "vitest";

import {
  SKILL_DEFINITIONS,
  assertToolAllowed,
  getSkill,
  skillsForRole,
} from "./skill-definitions.js";
import { skillDefinitionSchema } from "./skill-schemas.js";
import { TOOL_DEFINITIONS, TOOL_IDS } from "./tool-definitions.js";

const EXPECTED_STATUS = {
  "catalog.find": "pilot",
  "catalog.gap_review": "pilot",
  "listing.copy_proposal": "planned",
  "listing.draft_from_sources": "planned",
  "merchant.audit": "planned",
  "product_shot.prepare": "planned",
  "category.map_proposal": "planned",
  "supplier.intel_proposal": "planned",
  "customer.reply_draft": "blocked",
  "logistics.followup": "blocked",
} as const;

const EXECUTABLE_KEYS = ["catalog.find", "catalog.gap_review"];

function parseDefinition(value: unknown): boolean {
  return skillDefinitionSchema.safeParse(value).success;
}

describe("SKILL_DEFINITIONS", () => {
  it("publishes exactly the ten v1 skills with unique keys", () => {
    expect(SKILL_DEFINITIONS).toHaveLength(10);
    const keys = SKILL_DEFINITIONS.map((skill) => skill.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.keys(EXPECTED_STATUS).sort());
    for (const skill of SKILL_DEFINITIONS) {
      expect(skill.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("keeps pilot, planned and blocked states honest", () => {
    for (const skill of SKILL_DEFINITIONS) {
      expect(skill.status).toBe(
        EXPECTED_STATUS[skill.key as keyof typeof EXPECTED_STATUS],
      );
    }
  });

  it("is frozen, including its nested bilingual and evidence data", () => {
    expect(Object.isFrozen(SKILL_DEFINITIONS)).toBe(true);
    for (const skill of SKILL_DEFINITIONS) {
      expect(Object.isFrozen(skill)).toBe(true);
      expect(Object.isFrozen(skill.title)).toBe(true);
      expect(Object.isFrozen(skill.outcome)).toBe(true);
      expect(Object.isFrozen(skill.limitation)).toBe(true);
      expect(Object.isFrozen(skill.inputs)).toBe(true);
      expect(Object.isFrozen(skill.optionalInputs)).toBe(true);
      expect(Object.isFrozen(skill.allowedTools)).toBe(true);
      expect(Object.isFrozen(skill.evidence)).toBe(true);
      expect(Object.isFrozen(skill.evidence.requiredSources)).toBe(true);
    }
  });

  it("validates every definition against the strict skill schema", () => {
    for (const skill of SKILL_DEFINITIONS) {
      expect(skillDefinitionSchema.safeParse(skill).success).toBe(true);
    }
  });

  it("only allowlists ids that exist in the reviewed tool registry", () => {
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(0);
    for (const skill of SKILL_DEFINITIONS) {
      expect(new Set(skill.allowedTools).size).toBe(skill.allowedTools.length);
      for (const toolId of skill.allowedTools) {
        expect(TOOL_IDS).toContain(toolId);
        expect(TOOL_DEFINITIONS.some((tool) => tool.id === toolId)).toBe(true);
      }
    }
  });

  it("gives blocked skills no executable tools and no expected sources", () => {
    const blocked = SKILL_DEFINITIONS.filter(
      (skill) => skill.status === "blocked",
    );
    expect(blocked.map((skill) => skill.key).sort()).toEqual([
      "customer.reply_draft",
      "logistics.followup",
    ]);
    for (const skill of blocked) {
      expect(skill.allowedTools).toEqual([]);
      expect(skill.evidence.requiredSources).toEqual([]);
    }
  });

  it("requires non-empty bilingual title, outcome, limitation and inputs", () => {
    for (const skill of SKILL_DEFINITIONS) {
      for (const text of [skill.title, skill.outcome, skill.limitation]) {
        expect(text["zh-Hant"].trim().length).toBeGreaterThan(0);
        expect(text.en.trim().length).toBeGreaterThan(0);
      }
      const inputNames = [...skill.inputs, ...skill.optionalInputs].map(
        (input) => input.name,
      );
      expect(new Set(inputNames).size).toBe(inputNames.length);
      for (const input of [...skill.inputs, ...skill.optionalInputs]) {
        expect(input.description["zh-Hant"].trim().length).toBeGreaterThan(0);
        expect(input.description.en.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("only exposes pilot skills as executable for operator and above", () => {
    for (const role of ["operator", "reviewer", "admin", "owner"] as const) {
      const executable = skillsForRole(role);
      expect(Object.isFrozen(executable)).toBe(true);
      expect(executable.map((skill) => skill.key).sort()).toEqual(
        EXECUTABLE_KEYS,
      );
      for (const skill of executable) expect(skill.status).toBe("pilot");
    }
  });

  it("never executes planned or blocked skills even when named", () => {
    const executableKeys = new Set(
      skillsForRole("owner").map((skill) => skill.key),
    );
    for (const skill of SKILL_DEFINITIONS) {
      if (skill.status === "pilot") continue;
      expect(executableKeys.has(skill.key)).toBe(false);
      expect(getSkill(skill.key)?.status).not.toBe("pilot");
    }
  });

  it("returns no executable skill for a viewer", () => {
    expect(skillsForRole("viewer")).toEqual([]);
  });

  it("resolves skills by key and returns undefined for unknown keys", () => {
    expect(getSkill("catalog.find")?.version).toBe("1.0.0");
    expect(getSkill("listing.draft_from_sources")?.version).toBe("1.0.0");
    expect(getSkill("catalog.missing")).toBeUndefined();
    expect(getSkill("")).toBeUndefined();
  });

  it("enforces the reviewed tool allowlist", () => {
    const skill = getSkill("catalog.find");
    if (!skill) throw new Error("catalog.find must exist");
    expect(assertToolAllowed(skill, "catalog.search").id).toBe(
      "catalog.search",
    );
    expect(() => assertToolAllowed(skill, "listing.create_draft")).toThrow(
      /not allowed/,
    );
    expect(() => assertToolAllowed(skill, "catalog.delete")).toThrow(/unknown/);
  });
});

describe("skillDefinitionSchema", () => {
  const base = getSkill("catalog.find");
  if (!base) throw new Error("catalog.find must exist");

  it("accepts a valid definition", () => {
    expect(parseDefinition(base)).toBe(true);
  });

  it("rejects unknown keys and wrong enum values", () => {
    expect(parseDefinition({ ...base, unexpected: true })).toBe(false);
    expect(parseDefinition({ ...base, version: "1.0" })).toBe(false);
    expect(parseDefinition({ ...base, version: "v1.0.0" })).toBe(false);
    expect(parseDefinition({ ...base, status: "ready" })).toBe(false);
    expect(parseDefinition({ ...base, outputKind: "report" })).toBe(false);
    expect(parseDefinition({ ...base, budgetClass: "cheap" })).toBe(false);
    expect(parseDefinition({ ...base, completion: "done" })).toBe(false);
    expect(parseDefinition({ ...base, allowedTools: ["Catalog Search"] })).toBe(
      false,
    );
    expect(parseDefinition({ ...base, inputs: "query" })).toBe(false);
  });

  it("rejects incomplete or empty bilingual strings", () => {
    expect(
      parseDefinition({ ...base, title: { ...base.title, en: " " } }),
    ).toBe(false);
    expect(parseDefinition({ ...base, title: { "zh-Hant": "標題" } })).toBe(
      false,
    );
    expect(
      parseDefinition({ ...base, title: { ...base.title, fr: "Titre" } }),
    ).toBe(false);
    expect(
      parseDefinition({
        ...base,
        evidence: { ...base.evidence, unknownsPolicy: "zero" },
      }),
    ).toBe(false);
  });

  it("accepts an adapted-playbook upstream reference and rejects malformed ones", () => {
    const upstream = {
      source: "buyeros-contract",
      commit: "0123abc",
      pathHash: "a".repeat(64),
      licence: "MIT",
    };
    expect(parseDefinition({ ...base, upstream })).toBe(true);
    expect(
      parseDefinition({
        ...base,
        upstream: { ...upstream, pathHash: "short" },
      }),
    ).toBe(false);
    expect(
      parseDefinition({ ...base, upstream: { ...upstream, extra: true } }),
    ).toBe(false);
  });
});
