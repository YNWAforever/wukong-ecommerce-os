import { describe, expect, it } from "vitest";
import { resolveFlag, scanCompliance } from "./compliance";

describe("scanCompliance", () => {
  it("returns deterministic blocking flags for guaranteed health benefits", () => {
    expect(scanCompliance({ description: "Guaranteed health benefits" })).toEqual([
      {
        id: "description:health_claim:0",
        field: "description",
        rule: "health_claim",
        severity: "blocking",
        status: "open",
        resolutionReason: null
      },
      {
        id: "description:guarantee:1",
        field: "description",
        rule: "guarantee",
        severity: "blocking",
        status: "open",
        resolutionReason: null
      }
    ]);
  });

  it("returns no flags when copy contains no blocking claims", () => {
    expect(scanCompliance({ title: "Estate-bottled red wine" })).toEqual([]);
  });
  it("blocks Chinese health claims and guarantees", () => {
    expect(scanCompliance({ description: "保證有保健功效" })).toEqual([
      expect.objectContaining({ rule: "health_claim", severity: "blocking" }),
      expect.objectContaining({ rule: "guarantee", severity: "blocking" })
    ]);
  });
});

describe("resolveFlag", () => {
  const flag = scanCompliance({ description: "Guaranteed quality" })[0]!;

  it("rejects a resolution reason shorter than ten meaningful characters", () => {
    expect(() => resolveFlag(flag, " too short ")).toThrow(
      "A meaningful resolution reason is required"
    );
  });

  it("resolves a flag with a trimmed meaningful reason without mutating the original", () => {
    const resolved = resolveFlag(flag, "  Claim removed from description.  ");

    expect(resolved).toEqual({
      ...flag,
      status: "resolved",
      resolutionReason: "Claim removed from description."
    });
    expect(flag).toMatchObject({ status: "open", resolutionReason: null });
  });
});
