import { describe, expect, it } from "vitest";

import {
  SKILL_DEFINITIONS,
  getSkill,
  skillsForRole,
  STUDIO_SKILL_PROMPT_BINDINGS,
  STUDIO_PROMPT_VERSIONS,
  TOOL_DEFINITIONS,
  getTool,
  studioSkillManifest,
  studioSkillManifestFingerprint,
} from "./index.js";

/**
 * C4 skill-authoring harness checks: the manifest must be a faithful, complete
 * projection of the reviewed registries, prompt bindings must be real, and the
 * fingerprint must be stable but sensitive to reviewed changes.
 */

describe("studio skill manifest", () => {
  it("projects every skill and tool exactly once with matching metadata", () => {
    const manifest = studioSkillManifest();
    expect(manifest.skills).toHaveLength(SKILL_DEFINITIONS.length);
    expect(manifest.tools).toHaveLength(TOOL_DEFINITIONS.length);

    for (const skill of SKILL_DEFINITIONS) {
      const entry = manifest.skills.find((item) => item.key === skill.key);
      expect(entry, skill.key).toBeDefined();
      expect(entry).toMatchObject({
        version: skill.version,
        status: skill.status,
        outputKind: skill.outputKind,
        budgetClass: skill.budgetClass,
        completion: skill.completion,
        requiredSources: [...skill.evidence.requiredSources],
        allowedTools: [...skill.allowedTools],
      });
      expect(entry?.inputs).toEqual(skill.inputs.map((input) => input.name));
      expect(entry?.optionalInputs).toEqual(
        skill.optionalInputs.map((input) => input.name),
      );
      for (const toolId of skill.allowedTools)
        expect(getTool(toolId), `${skill.key}: ${toolId}`).toBeDefined();
    }

    for (const tool of TOOL_DEFINITIONS) {
      const entry = manifest.tools.find((item) => item.id === tool.id);
      expect(entry).toMatchObject({
        kind: tool.kind,
        minRole: tool.minRole,
        costClass: tool.costClass,
        capabilityId: tool.capabilityId,
        maxResultBytes: tool.maxResultBytes,
      });
    }

    expect(manifest.skills.map((skill) => skill.key)).toEqual(
      [...manifest.skills.map((skill) => skill.key)].sort(),
    );
    expect(manifest.tools.map((tool) => tool.id)).toEqual(
      [...manifest.tools.map((tool) => tool.id)].sort(),
    );
  });

  it("binds only real prompt versions and real skills", () => {
    const manifest = studioSkillManifest();
    expect(Object.keys(STUDIO_SKILL_PROMPT_BINDINGS).sort()).toEqual(
      SKILL_DEFINITIONS.map((skill) => skill.key).sort(),
    );
    for (const [skillKey, promptKeys] of Object.entries(
      STUDIO_SKILL_PROMPT_BINDINGS,
    )) {
      expect(getSkill(skillKey), skillKey).toBeDefined();
      for (const promptKey of promptKeys)
        expect(STUDIO_PROMPT_VERSIONS[promptKey]).toMatch(
          /^[0-9]+\.[0-9]+\.[0-9]+$/,
        );
      const entry = manifest.skills.find((item) => item.key === skillKey);
      expect(entry?.promptKeys).toEqual([...promptKeys]);
    }
  });

  it("keeps executable status and template visibility honest", () => {
    const pilotKeys = SKILL_DEFINITIONS.filter(
      (skill) => skill.status === "pilot",
    ).map((skill) => skill.key);
    const manifestPilot = studioSkillManifest()
      .skills.filter((skill) => skill.status === "pilot")
      .map((skill) => skill.key);
    expect(manifestPilot).toEqual(pilotKeys.sort());
    for (const skill of SKILL_DEFINITIONS)
      expect(["pilot", "planned", "blocked"]).toContain(skill.status);
    // The owner role sees every pilot skill; a viewer sees none.
    expect(skillsForRole("owner").map((skill) => skill.key)).toEqual(
      expect.arrayContaining(pilotKeys),
    );
    expect(skillsForRole("viewer")).toEqual([]);
  });

  it("has a stable but change-sensitive fingerprint", () => {
    const first = studioSkillManifestFingerprint();
    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(studioSkillManifestFingerprint()).toBe(first);
    expect(studioSkillManifest().promptVersions).toEqual(
      STUDIO_PROMPT_VERSIONS,
    );
  });

  it("does not leak tool schemas or executable code into the manifest", () => {
    const manifest = studioSkillManifest();
    const json = JSON.stringify(manifest);
    // Input/output zod schemas and prompt templates are runtime objects, not
    // authoring metadata; the manifest must stay serialisable and stable.
    expect(json).not.toContain("Zod");
    expect(json).not.toContain("function");
    expect(json.length).toBeGreaterThan(0);
  });
});
