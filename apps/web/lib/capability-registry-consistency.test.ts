import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Reads the raw source of both files rather than importing/rendering them,
// so this test's guarantee doesn't depend on any bundler/JSX-transform
// detail: if either surface is ever changed to use a different or forked
// component, the shared import line disappears and this test fails.
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("capability registry consistency", () => {
  it("admin-tabs.tsx and /system-map's page both import CapabilityRegistryPanel", () => {
    const adminTabsSource = readSource("../components/admin-tabs.tsx");
    const systemMapSource = readSource("../app/(app)/system-map/page.tsx");
    expect(adminTabsSource).toMatch(/CapabilityRegistryPanel/);
    expect(systemMapSource).toMatch(/CapabilityRegistryPanel/);
  });
});
