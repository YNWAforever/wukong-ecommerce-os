import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
