import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CAPABILITY_REGISTRY,
  type CapabilityState,
} from "./capability-registry.js";

// Reads the raw source of both files rather than importing/rendering them,
// so this test's guarantee doesn't depend on any bundler/JSX-transform
// detail: if either surface is ever changed to use a different or forked
// component, the shared import line disappears and this test fails.
function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

// Requires both an import statement AND a JSX usage -- a bare identifier
// match (e.g. just checking the string "CapabilityRegistryPanel" appears
// anywhere) would still pass on a dead, unused import left behind after a
// surface quietly forks to a local/different render, which is exactly the
// drift this test exists to catch.
const IMPORTS_PANEL = /import\s*\{[^}]*\bCapabilityRegistryPanel\b[^}]*\}/;
const RENDERS_PANEL = /<CapabilityRegistryPanel\b/;

describe("capability registry consistency", () => {
  it("admin-tabs.tsx and /system-map's page both import and render CapabilityRegistryPanel", () => {
    const adminTabsSource = readSource("../components/admin-tabs.tsx");
    const systemMapSource = readSource("../app/(app)/system-map/page.tsx");

    expect(adminTabsSource).toMatch(IMPORTS_PANEL);
    expect(adminTabsSource).toMatch(RENDERS_PANEL);
    expect(systemMapSource).toMatch(IMPORTS_PANEL);
    expect(systemMapSource).toMatch(RENDERS_PANEL);
  });
});

/**
 * The five Conversation Studio entries, with the state the shipped tree
 * actually earns. `conversation-studio` is pilot after the P1-P4 local
 * implementation and verification; `conversation-studio-ai` stays planned
 * because no live provider run has been recorded; the hosted MCP server moved
 * to pilot after its local protocol/token/migration verification; external MCP
 * stays blocked (no allowlist/credential decision); report sign-off is pilot
 * after its local versioning/signing/export verification.
 */
const STUDIO_CAPABILITIES = [
  ["conversation-studio", "pilot"],
  ["conversation-studio-ai", "planned"],
  ["wukong-mcp-server", "pilot"],
  ["external-mcp-connections", "blocked"],
  ["studio-output-signoff", "pilot"],
] as const satisfies ReadonlyArray<readonly [string, CapabilityState]>;

describe("conversation studio capability entries", () => {
  it("registers every studio capability with its approved honest state", () => {
    for (const [id, state] of STUDIO_CAPABILITIES) {
      const entry = CAPABILITY_REGISTRY.find(
        (candidate) => candidate.id === id,
      );
      expect(entry, `missing capability entry: ${id}`).toBeDefined();
      expect(entry?.state, id).toBe(state);
    }
  });

  it("gives every studio capability a bilingual label and description", () => {
    for (const [id] of STUDIO_CAPABILITIES) {
      const entry = CAPABILITY_REGISTRY.find(
        (candidate) => candidate.id === id,
      );
      expect(entry?.label.trim().length, `${id} label`).toBeGreaterThan(0);
      expect(entry?.labelZh.trim().length, `${id} labelZh`).toBeGreaterThan(0);
      expect(
        entry?.description.trim().length,
        `${id} description`,
      ).toBeGreaterThan(0);
      expect(
        entry?.descriptionZh.trim().length,
        `${id} descriptionZh`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps the appended studio entries frozen like the rest of the registry", () => {
    for (const [id] of STUDIO_CAPABILITIES) {
      const entry = CAPABILITY_REGISTRY.find(
        (candidate) => candidate.id === id,
      );
      expect(Object.isFrozen(entry), id).toBe(true);
    }
  });

  it("does not claim any studio capability is implemented yet", () => {
    for (const [id] of STUDIO_CAPABILITIES) {
      const entry = CAPABILITY_REGISTRY.find(
        (candidate) => candidate.id === id,
      );
      expect(entry?.state).not.toBe("implemented");
    }
  });
});
