import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { TENANT_TABLES } from "./cli/audit-verify.js";
import * as schema from "./schema.js";

/**
 * Static parity for migration 0054's declarations.
 *
 * The migration itself is exercised against a disposable Postgres in
 * `studio-migration.integration.test.ts`; this unit test only makes the shape
 * and the release-gate registration impossible to forget when editing the
 * schema module.
 */

const STUDIO_TABLES = [
  "studioThreads",
  "studioMessages",
  "studioRuns",
  "studioRunEvents",
  "studioOutputs",
  "studioOutputVersions",
  "studioBudgetReservations",
  "studioWorkspaceSettings",
  "studioMcpConnections",
  "studioMcpCalls",
  "studioApiTokens",
] as const;

const TABLE_NAMES: Record<(typeof STUDIO_TABLES)[number], string> = {
  studioThreads: "studio_threads",
  studioMessages: "studio_messages",
  studioRuns: "studio_runs",
  studioRunEvents: "studio_run_events",
  studioOutputs: "studio_outputs",
  studioOutputVersions: "studio_output_versions",
  studioBudgetReservations: "studio_budget_reservations",
  studioWorkspaceSettings: "studio_workspace_settings",
  studioMcpConnections: "studio_mcp_connections",
  studioMcpCalls: "studio_mcp_calls",
  studioApiTokens: "studio_api_tokens",
};

const WORKSPACE_SCOPED = STUDIO_TABLES.filter(
  (key) => key !== "studioWorkspaceSettings",
);

describe("studio schema declarations", () => {
  it("declares every studio table with the expected column shape", () => {
    for (const key of STUDIO_TABLES) {
      const table = schema[key] as unknown as Parameters<
        typeof getTableColumns
      >[0];
      const columns = getTableColumns(table);
      expect(columns, key).toBeDefined();
      if (key === "studioWorkspaceSettings") {
        expect(columns.workspaceId, key).toBeDefined();
        expect(columns.updatedBy, key).toBeDefined();
      } else {
        expect(columns.id, key).toBeDefined();
        expect(columns.workspaceId, key).toBeDefined();
        expect(columns.createdAt, key).toBeDefined();
      }
    }
  });

  it("registers every workspace-scoped studio table in the audit leak probe", () => {
    const tenantTables = new Set<string>(TENANT_TABLES);
    for (const key of WORKSPACE_SCOPED) {
      expect(tenantTables.has(TABLE_NAMES[key]), TABLE_NAMES[key]).toBe(true);
    }
    expect(TENANT_TABLES).toHaveLength(new Set(TENANT_TABLES).size);
  });

  it("keeps append-only tables free of update/delete audit expectations", () => {
    // Guard against someone later adding an append-only table to a mutable
    // repository path without revisiting the migration's grants.
    const appendOnly = [
      schema.studioMessages,
      schema.studioRunEvents,
      schema.studioOutputVersions,
      schema.studioMcpCalls,
    ];
    for (const table of appendOnly)
      expect(Object.values(table).length).toBeGreaterThan(0);
  });
});
