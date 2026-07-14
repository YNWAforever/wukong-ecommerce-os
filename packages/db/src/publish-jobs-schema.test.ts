import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { listingVersions, publishJobs } from "./schema.js";

describe("publish job schema", () => {
  it("stores the approved version and canonical payload digest", () => {
    const columns = getTableColumns(publishJobs);
    expect(columns.versionId.notNull).toBe(false);
    expect(columns.payloadDigest.notNull).toBe(false);
  });

  it("keeps publish version references tenant scoped and restricted on delete", () => {
    const foreignKeys = getTableConfig(publishJobs).foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        columns: reference.columns.map((column) => column.name),
        foreignColumns: reference.foreignColumns.map((column) => column.name),
        foreignTable: reference.foreignTable,
        onDelete: foreignKey.onDelete,
      };
    });
    expect(foreignKeys).toContainEqual({
      columns: ["workspace_id", "version_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: listingVersions,
      onDelete: "restrict",
    });
  });
});
