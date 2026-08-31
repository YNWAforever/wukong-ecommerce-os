import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import { CapabilityRegistryPanel } from "./capability-registry-panel";

describe("CapabilityRegistryPanel", () => {
  it("renders one row per CAPABILITY_REGISTRY entry with label, description, and a state indicator", () => {
    const markup = renderToStaticMarkup(<CapabilityRegistryPanel />);

    // One row per registry entry -- scoped to the row wrapper class so a
    // future addition elsewhere on a page reusing this component (e.g. a
    // second flag-item list on /system-map) can't inflate the count.
    const rowPattern = /<li class="[^"]*capability-registry-item[^"]*"/g;
    const rows = markup.match(rowPattern) ?? [];
    expect(rows).toHaveLength(CAPABILITY_REGISTRY.length);

    // Every entry's label and description text is present in the markup.
    for (const entry of CAPABILITY_REGISTRY) {
      expect(markup).toContain(entry.label);
      expect(markup).toContain(entry.description);
    }

    // A known entry is findable by its label.
    expect(markup).toContain("SHOPLINE 正式發佈");

    // Every row carries a visible state indicator (one pill per row).
    const indicatorPattern = /class="connection-status status-\w+"/g;
    const indicators = markup.match(indicatorPattern) ?? [];
    expect(indicators).toHaveLength(CAPABILITY_REGISTRY.length);

    // The registry's current mix of states is reflected in the labels shown
    // (blocked and live both appear at least once in the fixture data).
    expect(markup).toContain("已封鎖");
    expect(markup).toContain("已上線");
  });
});
