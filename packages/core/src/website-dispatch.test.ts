import { describe, expect, it } from "vitest";
import { websiteDispatchRecoveryState } from "./website-dispatch.js";
const instant = (seconds: number) => new Date(seconds * 1000);
const snapshot = () => ({
  state: "queued",
  dispatchStatus: "failed",
  deadlineAt: instant(900),
  nextEligibleAt: instant(0),
  leaseExpiresAt: null as Date | null,
  dispatchAt: instant(0) as Date | null,
});
describe("website dispatch recovery eligibility", () => {
  it("allows failed or never-dispatched work without changing its deadline", () => {
    const scan = snapshot();
    expect(websiteDispatchRecoveryState(scan, instant(1))).toBe("retryable");
    expect(
      websiteDispatchRecoveryState(
        { ...scan, dispatchStatus: "pending", dispatchAt: null },
        instant(1),
      ),
    ).toBe("retryable");
    expect(scan.deadlineAt).toEqual(instant(900));
  });
  it.each(["pending", "sent"])(
    "waits for recent %s delivery and recovers a stale one",
    (dispatchStatus) => {
      const scan = { ...snapshot(), dispatchStatus };
      expect(websiteDispatchRecoveryState(scan, instant(59))).toBe("waiting");
      expect(websiteDispatchRecoveryState(scan, instant(60))).toBe("retryable");
    },
  );
  it("waits for an active document lease and the next eligible fetch time", () => {
    expect(
      websiteDispatchRecoveryState(
        { ...snapshot(), state: "running", leaseExpiresAt: instant(20) },
        instant(1),
      ),
    ).toBe("waiting");
    expect(
      websiteDispatchRecoveryState(
        { ...snapshot(), nextEligibleAt: instant(20) },
        instant(1),
      ),
    ).toBe("waiting");
    expect(
      websiteDispatchRecoveryState(
        { ...snapshot(), leaseExpiresAt: instant(1) },
        instant(1),
      ),
    ).toBe("retryable");
  });
  it("never resumes an expired or terminal scan", () => {
    expect(websiteDispatchRecoveryState(snapshot(), instant(900))).toBe(
      "expired",
    );
    for (const state of ["ready", "partial", "failed", "unknown"])
      expect(
        websiteDispatchRecoveryState({ ...snapshot(), state }, instant(1)),
      ).toBe("unavailable");
  });
  it("fails closed for invalid dates and unknown dispatch state", () => {
    expect(
      websiteDispatchRecoveryState(
        { ...snapshot(), dispatchAt: new Date("invalid") },
        instant(1),
      ),
    ).toBe("unavailable");
    expect(
      websiteDispatchRecoveryState(
        { ...snapshot(), dispatchStatus: "unknown" },
        instant(1),
      ),
    ).toBe("unavailable");
    expect(websiteDispatchRecoveryState(snapshot(), new Date("invalid"))).toBe(
      "unavailable",
    );
  });
});
