import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  fieldEvidence,
  listingDrafts,
  listingVersions,
  listingPipelineSteps,
  sourceAssets,
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
