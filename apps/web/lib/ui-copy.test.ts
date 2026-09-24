import { describe, it, expect } from "vitest";
import {
  formatHkDate,
  reasonLabel,
  readinessReasons,
  safeUiError,
  stateLabel,
} from "./ui-copy";
describe("Hong Kong UI contracts", () => {
  it.each(["zh-Hant", "en"] as const)(
    "uses Hong Kong midnight boundaries and a safe invalid-date fallback in %s",
    (locale) => {
      expect(formatHkDate("2026-09-04T16:30:00Z", locale)).toBe(
        new Intl.DateTimeFormat(locale === "en" ? "en-HK" : "zh-HK", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "Asia/Hong_Kong",
        }).format(new Date("2026-09-04T16:30:00Z")),
      );
      expect(formatHkDate("invalid", locale)).not.toContain("Invalid Date");
    },
  );
  it("gives every readiness reason a specific explanation in both locales", () => {
    for (const reason of Object.keys(readinessReasons)) {
      expect(reasonLabel(reason, "en")).not.toBe(reasonLabel("unknown", "en"));
      expect(reasonLabel(reason, "zh-Hant")).not.toBe(
        reasonLabel("unknown", "zh-Hant"),
      );
    }
    expect(reasonLabel("approval_required", "en")).toBe(
      "Approve the active version first",
    );
    expect(stateLabel("in_review", "zh-Hant")).toBe("待審核");
  });
  it("distinguishes permission, read and mutation failures without showing internals", () => {
    expect(safeUiError("403", "en", "action")).toBe(
      "You do not have permission to perform this action.",
    );
    expect(safeUiError("database password leaked", "zh-Hant", "action")).toBe(
      "操作未能完成，請重試。",
    );
    expect(safeUiError("network internals", "en")).toBe(
      "Unable to load data. Please retry.",
    );
  });
});
