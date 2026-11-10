import { describe, expect, it } from "vitest";

import { toOutputStatus } from "./output-status";

/**
 * Server-safe status normalizer. `/studio/outputs` renders chips on the server
 * and must not import this helper from the client `StudioOutputCard` module:
 * doing so produced a client-reference crash at render time
 * ("Attempted to call toOutputStatus() from the server").
 */
describe("toOutputStatus", () => {
  it("accepts the four reviewed statuses", () => {
    expect(toOutputStatus("draft")).toBe("draft");
    expect(toOutputStatus("saved")).toBe("saved");
    expect(toOutputStatus("signed_off")).toBe("signed_off");
    expect(toOutputStatus("discarded")).toBe("discarded");
  });

  it("returns null for unknown or malformed values instead of a status chip", () => {
    for (const value of [undefined, null, "", "approved", 1, {}]) {
      expect(toOutputStatus(value)).toBeNull();
    }
  });
});
