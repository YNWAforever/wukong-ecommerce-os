import { describe, expect, it } from "vitest";

import { migrationTimeouts } from "./migration-timeouts.js";

describe("migrationTimeouts", () => {
  it("leaves both timeouts unset when the environment names neither", () => {
    expect(migrationTimeouts({})).toEqual({
      lockTimeoutMs: null,
      statementTimeoutMs: null,
    });
  });

  it("reads both bounds as milliseconds", () => {
    expect(
      migrationTimeouts({
        DATABASE_MIGRATION_LOCK_TIMEOUT_MS: "5000",
        DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS: "120000",
      }),
    ).toEqual({ lockTimeoutMs: 5000, statementTimeoutMs: 120000 });
  });

  it.each(["0", "-1", "1.5", "abc", "600001"])(
    "rejects %s before anything connects",
    (value) => {
      expect(() =>
        migrationTimeouts({ DATABASE_MIGRATION_LOCK_TIMEOUT_MS: value }),
      ).toThrow(/invalid migration timeout/);
      expect(() =>
        migrationTimeouts({ DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS: value }),
      ).toThrow(/invalid migration timeout/);
    },
  );
});
