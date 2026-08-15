import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  enrichmentBatchItems,
  enrichmentBatches,
  listingDrafts,
} from "./schema.js";

const foreignKeysOf = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      columns: reference.columns.map((column) => column.name),
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      foreignTable: reference.foreignTable,
      onDelete: foreignKey.onDelete,
    };
  });

describe("enrichment batch schema", () => {
  it("records the approved budget and the wave size", () => {
    const columns = getTableColumns(enrichmentBatches);

    expect(columns.budgetUsd.notNull).toBe(true);
    expect(columns.waveSize.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
    expect(columns.workspaceId.notNull).toBe(true);
  });

  it("keeps the item's batch and draft references tenant scoped", () => {
    const foreignKeys = foreignKeysOf(enrichmentBatchItems);

    expect(foreignKeys).toContainEqual({
      columns: ["workspace_id", "batch_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: enrichmentBatches,
      onDelete: "cascade",
    });
    // Restrict, not cascade: an item is a spending record, and deleting a draft
    // must not erase evidence of what was spent on it.
    expect(foreignKeys).toContainEqual({
      columns: ["workspace_id", "listing_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: listingDrafts,
      onDelete: "restrict",
    });
  });

  it("admits one item per draft per batch", () => {
    const uniqueIndexes = getTableConfig(enrichmentBatchItems)
      .indexes.filter((index) => index.config.unique)
      .map((index) =>
        index.config.columns.map((column) => (column as { name: string }).name),
      );

    expect(uniqueIndexes).toContainEqual([
      "workspace_id",
      "batch_id",
      "listing_id",
    ]);
  });
});
