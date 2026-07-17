import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  authAccounts,
  authRateLimits,
  authSessions,
  authVerifications,
  fieldEvidence,
  listingDrafts,
  listingVersions,
  listingPipelineSteps,
  passwordLoginGuards,
  sourceAssets,
  users,
} from "./schema.js";

function foreignKeyMetadata(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      columns: reference.columns.map((column) => column.name),
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      foreignTable: reference.foreignTable,
      onDelete: foreignKey.onDelete,
    };
  });
}

describe("nullable tenant relationships", () => {
  it("persists a non-null lease token for every pipeline step", () => {
    expect(getTableColumns(listingPipelineSteps).leaseToken.notNull).toBe(true);
  });

  it("allows a finalized source asset to exist before listing creation", () => {
    expect(getTableColumns(sourceAssets).listingId.notNull).toBe(false);
  });

  it("models the active listing version as a restricted workspace composite FK", () => {
    expect(foreignKeyMetadata(listingDrafts)).toContainEqual({
      columns: ["workspace_id", "active_version_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: listingVersions,
      onDelete: "restrict",
    });
  });

  it("models source evidence as a restricted workspace composite FK", () => {
    expect(foreignKeyMetadata(fieldEvidence)).toContainEqual({
      columns: ["workspace_id", "source_asset_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: sourceAssets,
      onDelete: "restrict",
    });
  });
});

describe("Better Auth schema", () => {
  it("preserves the legacy verification timestamp and adds the boolean verification flag", () => {
    const columns = getTableColumns(users);

    expect(columns.legacyEmailVerified.name).toBe("email_verified");
    expect(columns.emailVerified.name).toBe("auth_email_verified");
    expect(columns.emailVerified.dataType).toBe("boolean");
  });

  it("defines the required account fields", () => {
    expect(Object.keys(getTableColumns(authAccounts))).toEqual([
      "id", "userId", "accountId", "providerId", "accessToken", "refreshToken",
      "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "idToken",
      "password", "createdAt", "updatedAt",
    ]);
  });

  it("defines the required session fields", () => {
    expect(Object.keys(getTableColumns(authSessions))).toEqual([
      "id", "userId", "token", "expiresAt", "ipAddress", "userAgent",
      "createdAt", "updatedAt",
    ]);
  });

  it("defines the required verification fields", () => {
    expect(Object.keys(getTableColumns(authVerifications))).toEqual([
      "id", "identifier", "value", "expiresAt", "createdAt", "updatedAt",
    ]);
  });

  it("defines the required database rate-limit fields", () => {
    expect(Object.keys(getTableColumns(authRateLimits))).toEqual([
      "id", "key", "count", "lastRequest",
    ]);
  });

  it("defines the application-owned password lockout fields", () => {
    expect(Object.keys(getTableColumns(passwordLoginGuards))).toEqual([
      "email", "failedAttempts", "lockedUntil", "updatedAt",
    ]);
  });
});
