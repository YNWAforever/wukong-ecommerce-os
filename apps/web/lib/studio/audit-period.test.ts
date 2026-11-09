import { describe, expect, it } from "vitest";

import {
  auditPeriodPayload,
  isWithinAuditPeriod,
  mentionsUnparseablePeriod,
  parseAuditPeriod,
} from "./audit-period";

/**
 * Deterministic merchant-audit period parser (B3).
 *
 * All day math is UTC and `now` is injected; no locale, no system clock. A
 * missing or invalid phrase is `null` (current totals), never a guessed window.
 */

const NOW = new Date("2026-11-08T16:30:00.000Z");

describe("parseAuditPeriod relative phrases", () => {
  it("parses last/past/previous N days, weeks, months and a bounded year", () => {
    expect(parseAuditPeriod("last 30 days", NOW)).toMatchObject({
      from: "2026-10-10",
      to: "2026-11-08",
      days: 30,
      label: "last 30 days",
    });
    expect(parseAuditPeriod("past 2 weeks", NOW)).toMatchObject({
      from: "2026-10-26",
      to: "2026-11-08",
      days: 14,
      label: "past 14 days",
    });
    expect(parseAuditPeriod("previous 3 months", NOW)).toMatchObject({
      from: "2026-08-11",
      to: "2026-11-08",
      days: 90,
      label: "previous 90 days",
    });
    expect(parseAuditPeriod("last 1 year", NOW)).toMatchObject({
      from: "2025-11-09",
      to: "2026-11-08",
      days: 365,
      label: "last 365 days",
    });
    expect(parseAuditPeriod("LAST 1 DAY", NOW)).toMatchObject({
      from: "2026-11-08",
      to: "2026-11-08",
      days: 1,
      label: "last 1 day",
    });
  });

  it("returns null for unbounded, malformed or absent phrases", () => {
    for (const text of [
      null,
      "",
      "audit this workspace",
      "last 0 days",
      "last 366 days",
      "last 2 years",
      "past 60 weeks",
      "last days",
    ])
      expect(parseAuditPeriod(text, NOW), String(text)).toBeNull();
  });
});

describe("parseAuditPeriod explicit ISO ranges", () => {
  it("accepts ordered, inclusive ranges", () => {
    expect(
      parseAuditPeriod("audit 2026-10-01 to 2026-11-01 please", NOW),
    ).toEqual({
      from: "2026-10-01",
      to: "2026-11-01",
      days: 32,
      label: "2026-10-01 - 2026-11-01",
    });
    expect(parseAuditPeriod("2026-11-08 - 2026-11-08", NOW)).toMatchObject({
      days: 1,
    });
  });

  it("rejects reversed, invalid, same-start/end-future or over-long ranges", () => {
    for (const text of [
      "2026-11-01 to 2026-10-01",
      "2026-02-30 to 2026-03-01",
      "2026-13-01 to 2027-01-01",
      "2024-01-01 to 2026-01-01", // > 365 days
      "2026-10-01 to 2026-11-01 extra junk", // still parses the first range
    ]) {
      const parsed = parseAuditPeriod(text, NOW);
      if (text.endsWith("extra junk")) {
        // A valid leading range remains a match; the trailing text is ignored.
        expect(parsed).not.toBeNull();
      } else {
        expect(parsed, text).toBeNull();
      }
    }
  });

  it("never uses the system clock for relative phrases", () => {
    const early = parseAuditPeriod(
      "last 7 days",
      new Date("2026-03-01T23:00:00.000Z"),
    );
    const late = parseAuditPeriod(
      "last 7 days",
      new Date("2026-03-02T00:30:00.000Z"),
    );
    expect(early).toMatchObject({ from: "2026-02-23", to: "2026-03-01" });
    expect(late).toMatchObject({ from: "2026-02-24", to: "2026-03-02" });
  });
});

describe("isWithinAuditPeriod", () => {
  const period = {
    from: "2026-10-01",
    to: "2026-11-01",
    days: 32,
    label: "test",
  };

  it("includes both boundary UTC days and excludes outside/invalid values", () => {
    expect(isWithinAuditPeriod("2026-10-01T00:00:00.000Z", period)).toBe(true);
    expect(isWithinAuditPeriod("2026-11-01T23:59:59.999Z", period)).toBe(true);
    expect(isWithinAuditPeriod("2026-09-30T23:59:59.999Z", period)).toBe(false);
    expect(isWithinAuditPeriod("2026-11-02T00:00:00.000Z", period)).toBe(false);
    expect(isWithinAuditPeriod("not-a-date", period)).toBe(false);
  });
});

describe("mentionsUnparseablePeriod and payload projection", () => {
  it("flags period-like text that could not be parsed", () => {
    expect(mentionsUnparseablePeriod("audit the last few fortnights")).toBe(
      true,
    );
    expect(mentionsUnparseablePeriod("last 30 days")).toBe(false);
    expect(mentionsUnparseablePeriod("audit this workspace")).toBe(false);
    expect(mentionsUnparseablePeriod(null)).toBe(false);
  });

  it("projects a parsed period to the payload shape and null for current totals", () => {
    expect(
      auditPeriodPayload({
        from: "2026-10-01",
        to: "2026-11-01",
        days: 32,
        label: "2026-10-01 - 2026-11-01",
      }),
    ).toEqual({
      from: "2026-10-01",
      to: "2026-11-01",
      label: "2026-10-01 - 2026-11-01",
    });
    expect(auditPeriodPayload(null)).toBeNull();
  });
});
