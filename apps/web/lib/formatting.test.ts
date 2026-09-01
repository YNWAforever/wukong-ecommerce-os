import { describe, expect, it } from "vitest";

import { formatHkd, formatHkTimestamp } from "./formatting.js";

describe("formatHkd", () => {
  it("formats a whole-dollar amount with the HK$ symbol and no decimals when the amount is a whole number", () => {
    expect(formatHkd(288)).toBe("HK$288");
  });

  it("formats zero", () => {
    expect(formatHkd(0)).toBe("HK$0");
  });

  it("formats a large amount with thousands separators", () => {
    expect(formatHkd(1234567)).toBe("HK$1,234,567");
  });

  it("formats a fractional amount with exactly two decimal places", () => {
    expect(formatHkd(288.5)).toBe("HK$288.50");
  });
});

describe("formatHkTimestamp", () => {
  it("formats a known instant in the Asia/Hong_Kong timezone", () => {
    // 2026-01-15T04:30:00Z is 2026-01-15 12:30 in Asia/Hong_Kong (UTC+8, no DST).
    const result = formatHkTimestamp(new Date("2026-01-15T04:30:00Z"));
    // Node's ICU separates the date and time portions with a thin space
    // (U+2009), not a regular space -- visually identical but not the same
    // character, so the exact expected string needs the real codepoint.
    expect(result).toBe("15/01/2026 12:30");
  });
});
