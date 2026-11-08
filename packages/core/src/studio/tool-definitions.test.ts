import { describe, expect, it } from "vitest";

import { STUDIO_ROLES } from "./skill-schemas.js";
import {
  MAX_TOOL_RESULT_BYTES,
  STUDIO_TOOL_CAPABILITY_IDS,
  TOOL_COST_CLASSES,
  TOOL_DEFINITIONS,
  TOOL_IDS,
  TOOL_KINDS,
  getTool,
  toolDefinitionSchema,
} from "./tool-definitions.js";

const EXPECTED_TOOL_IDS = [
  "catalog.search",
  "catalog.get",
  "quality.get_gaps",
  "imports.list",
  "exports.get",
  "jobs.list",
  "assets.list",
  "listing.get_run_status",
  "listing.create_draft",
  "listing.propose_copy",
];

const EXPECTED_CAPABILITY_IDS = [
  "conversation-studio",
  "conversation-studio-ai",
  "studio-output-signoff",
  "wukong-mcp-server",
  "external-mcp-connections",
  "ai-listing-generation",
];

function parseDefinition(value: unknown): boolean {
  return toolDefinitionSchema.safeParse(value).success;
}

describe("TOOL_DEFINITIONS", () => {
  it("publishes exactly the ten v1 tools with unique ids", () => {
    expect(TOOL_IDS).toHaveLength(10);
    expect(new Set(TOOL_IDS).size).toBe(10);
    expect([...TOOL_IDS].sort()).toEqual([...EXPECTED_TOOL_IDS].sort());
    expect(TOOL_DEFINITIONS.map((tool) => tool.id)).toEqual([...TOOL_IDS]);
    expect(new Set(TOOL_DEFINITIONS.map((tool) => tool.id)).size).toBe(10);
  });

  it("is frozen, including ids, capability allowlist and labels", () => {
    expect(Object.isFrozen(TOOL_IDS)).toBe(true);
    expect(Object.isFrozen(STUDIO_TOOL_CAPABILITY_IDS)).toBe(true);
    expect(Object.isFrozen(TOOL_DEFINITIONS)).toBe(true);
    for (const tool of TOOL_DEFINITIONS) {
      expect(Object.isFrozen(tool)).toBe(true);
      expect(Object.isFrozen(tool.label)).toBe(true);
    }
  });

  it("validates every definition against the strict tool schema", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(parseDefinition(tool)).toBe(true);
    }
  });

  it("keeps valid kinds, roles, cost classes and bounded result sizes", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(TOOL_KINDS).toContain(tool.kind);
      expect(STUDIO_ROLES).toContain(tool.minRole);
      expect(TOOL_COST_CLASSES).toContain(tool.costClass);
      expect(STUDIO_TOOL_CAPABILITY_IDS).toContain(tool.capabilityId);
      expect(Number.isInteger(tool.maxResultBytes)).toBe(true);
      expect(tool.maxResultBytes).toBeGreaterThan(0);
      expect(tool.maxResultBytes).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    }
  });

  it("matches the spec §3.5 dispatch/propose split and free reads", () => {
    expect(
      TOOL_DEFINITIONS.filter((tool) => tool.kind === "dispatch").map(
        (tool) => tool.id,
      ),
    ).toEqual(["listing.create_draft"]);
    expect(
      TOOL_DEFINITIONS.filter((tool) => tool.kind === "propose").map(
        (tool) => tool.id,
      ),
    ).toEqual(["listing.propose_copy"]);
    for (const tool of TOOL_DEFINITIONS) {
      if (tool.kind === "read") expect(tool.costClass).toBe("free");
    }
  });

  it("pins the capability-registry ids the web consistency test cross-checks", () => {
    expect([...STUDIO_TOOL_CAPABILITY_IDS].sort()).toEqual(
      [...EXPECTED_CAPABILITY_IDS].sort(),
    );
  });

  it("requires non-empty bilingual labels", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.label["zh-Hant"].trim().length).toBeGreaterThan(0);
      expect(tool.label.en.trim().length).toBeGreaterThan(0);
    }
  });

  it("declares zod input and output schemas that reject tenant fields", () => {
    const tenantFields = {
      workspaceId: "ws_foreign",
      workspace_id: "ws_foreign",
      actorId: "user_foreign",
      role: "owner",
    };
    for (const tool of TOOL_DEFINITIONS) {
      expect(typeof tool.input.safeParse).toBe("function");
      expect(typeof tool.output.safeParse).toBe("function");
      expect(tool.input.safeParse(tenantFields).success).toBe(false);
    }
  });

  it("returns asset ids, never signed URLs", () => {
    const assets = getTool("assets.list");
    if (!assets) throw new Error("assets.list must exist");
    const item = {
      assetId: "asset_1",
      role: "source",
      contentType: "image/jpeg",
    };
    expect(assets.output.safeParse({ items: [item] }).success).toBe(true);
    expect(
      assets.output.safeParse({
        items: [{ ...item, signedUrl: "https://example.invalid/secret" }],
      }).success,
    ).toBe(false);
  });

  it("dispatches a listing draft only after explicit confirmation", () => {
    const createDraft = getTool("listing.create_draft");
    if (!createDraft) throw new Error("listing.create_draft must exist");
    expect(createDraft.costClass).toBe("paid");
    expect(
      createDraft.input.safeParse({ assetIds: ["asset_1"], confirmed: false })
        .success,
    ).toBe(false);
    expect(
      createDraft.input.safeParse({ assetIds: ["asset_1"], confirmed: true })
        .success,
    ).toBe(true);
  });

  it("resolves tools by id and returns undefined for unknown ids", () => {
    expect(getTool("catalog.search")?.kind).toBe("read");
    expect(getTool("listing.propose_copy")?.kind).toBe("propose");
    expect(getTool("catalog.delete")).toBeUndefined();
    expect(getTool("")).toBeUndefined();
  });
});

describe("toolDefinitionSchema", () => {
  const base = getTool("catalog.search");
  if (!base) throw new Error("catalog.search must exist");

  it("accepts a valid definition", () => {
    expect(parseDefinition(base)).toBe(true);
  });

  it("rejects unknown keys and unregistered ids or capabilities", () => {
    expect(parseDefinition({ ...base, extra: true })).toBe(false);
    expect(parseDefinition({ ...base, id: "catalog.delete" })).toBe(false);
    expect(parseDefinition({ ...base, kind: "write" })).toBe(false);
    expect(parseDefinition({ ...base, minRole: "guest" })).toBe(false);
    expect(parseDefinition({ ...base, costClass: "cheap" })).toBe(false);
    expect(
      parseDefinition({ ...base, capabilityId: "free-text-capability" }),
    ).toBe(false);
    expect(
      parseDefinition({ ...base, maxResultBytes: MAX_TOOL_RESULT_BYTES + 1 }),
    ).toBe(false);
    expect(parseDefinition({ ...base, maxResultBytes: 0 })).toBe(false);
  });

  it("requires both input and output zod schemas", () => {
    expect(parseDefinition({ ...base, input: {} })).toBe(false);
    expect(parseDefinition({ ...base, output: "not-a-schema" })).toBe(false);
    expect(parseDefinition({ ...base, output: undefined })).toBe(false);
  });
});
