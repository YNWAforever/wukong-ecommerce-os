import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import { CapabilityRegistryPanel } from "./capability-registry-panel";

const ALL_STATUS_CLASSES = [
  "status-succeeded",
  "status-running",
  "status-pending",
  "status-failed",
];

// Isolates the markup for the single row whose text contains `label`, so an
// assertion can be pinned to that entry's own state class without being
// satisfied by a different row that happens to carry the right class.
function extractRow(markup: string, label: string): string {
  const rowPattern =
    /<li class="[^"]*capability-registry-item[^"]*">[\s\S]*?<\/li>/g;
  const rows = markup.match(rowPattern) ?? [];
  const row = rows.find((candidate) => candidate.includes(label));
  if (!row) {
    throw new Error(`No rendered row contains the label: ${label}`);
  }
  return row;
}

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

  it("ties each entry's row to its own state-specific CSS class, never a different one", () => {
    // Regression coverage for a real failure mode: an earlier version of
    // this test only checked that *some* status-* class existed per row,
    // and that the state LABEL text appeared *somewhere* in the markup --
    // two checks that stay green even if every row is hard-coded to the
    // same (wrong) class, because the label text is looked up independently
    // of which class actually decorates that row. Patching every entry
    // (including the blocked shopline-real-publish one) to render
    // "status-succeeded" passed the old assertions. These checks isolate
    // each row and pin it to its one correct class, and assert none of the
    // other three tone classes leak into that same row.
    const markup = renderToStaticMarkup(<CapabilityRegistryPanel />);

    // shopline-real-publish is the registry's one "blocked" entry -- the
    // safety-critical case: mislabeling it green/succeeded would ship a
    // real production gate as falsely healthy.
    const blockedRow = extractRow(markup, "SHOPLINE 正式發佈");
    expect(blockedRow).toContain("status-failed");
    for (const otherClass of ALL_STATUS_CLASSES) {
      if (otherClass === "status-failed") continue;
      expect(blockedRow).not.toContain(otherClass);
    }

    // ai-listing-generation is a "live" entry -- confirm it lands on a
    // genuinely different class than the blocked row above.
    const liveRow = extractRow(markup, "AI 商品資訊生成");
    expect(liveRow).toContain("status-succeeded");
    for (const otherClass of ALL_STATUS_CLASSES) {
      if (otherClass === "status-succeeded") continue;
      expect(liveRow).not.toContain(otherClass);
    }

    // jobs-ledger is a "pilot" entry -- the third distinct tone actually
    // present in the current registry data.
    const pilotRow = extractRow(markup, "作業總覽");
    expect(pilotRow).toContain("status-running");
    for (const otherClass of ALL_STATUS_CLASSES) {
      if (otherClass === "status-running") continue;
      expect(pilotRow).not.toContain(otherClass);
    }
  });
});
