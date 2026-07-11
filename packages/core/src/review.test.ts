import { describe, expect, it } from "vitest";
import { scanCompliance } from "./compliance";
import { approveListing, reopenListing } from "./review";

describe("approveListing", () => {
  it("rejects approval while a blocking compliance flag remains open", () => {
    const flags = scanCompliance({ description: "Guaranteed health benefits" });

    expect(() => approveListing("version-1", flags)).toThrow(
      "Blocking compliance flags must be resolved before approval"
    );
  });

  it("approves a version when no blocking flags remain open without mutating flags", () => {
    const flags = scanCompliance({ description: "Estate-bottled red wine" });
    const snapshot = structuredClone(flags);

    expect(approveListing("version-2", flags)).toEqual({
      versionId: "version-2",
      status: "approved"
    });
    expect(flags).toEqual(snapshot);
  });
});

describe("reopenListing", () => {
  it.each(["approved", "published", "publish_failed"] as const)(
    "reopens a %s listing",
    (status) => {
      expect(reopenListing(status)).toBe("reopened");
    }
  );

  it("rejects reopening a listing still in review", () => {
    expect(() => reopenListing("in_review")).toThrow(
      "Illegal transition: in_review -> reopen"
    );
  });
});
