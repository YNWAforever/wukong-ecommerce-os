import { describe, expect, it } from "vitest";

import {
  CAPABILITY_REGISTRY,
  type CapabilityState,
} from "./capability-registry.js";

const VALID_STATES: readonly CapabilityState[] = [
  "live",
  "pilot",
  "planned",
  "blocked",
];

describe("CAPABILITY_REGISTRY", () => {
  it("has at least the 6 grounded entries from the design spec", () => {
    const ids = CAPABILITY_REGISTRY.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "shopline-real-publish",
        "ai-listing-generation",
        "bulk-form-import-freshness-gate",
        "attended-enrichment-batches",
        "multi-product-export",
        "jobs-ledger",
      ]),
    );
  });

  it("has no duplicate ids", () => {
    const ids = CAPABILITY_REGISTRY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry has a non-empty label, description, and a valid state", () => {
    for (const entry of CAPABILITY_REGISTRY) {
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(VALID_STATES).toContain(entry.state);
    }
  });

  it("marks real SHOPLINE publishing as blocked", () => {
    const entry = CAPABILITY_REGISTRY.find(
      (candidate) => candidate.id === "shopline-real-publish",
    );
    expect(entry?.state).toBe("blocked");
  });
});
