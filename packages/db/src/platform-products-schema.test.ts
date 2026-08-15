import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { listingDrafts, platformProducts, shoplineConnections } from "./schema.js";

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

describe("platform product schema", () => {
  it("stores the remote identity, the row snapshot, and the facts prefill", () => {
    const columns = getTableColumns(platformProducts);

    expect(columns.remoteProductId.notNull).toBe(true);
    expect(columns.sku.notNull).toBe(true);
    expect(columns.specVersion.notNull).toBe(true);
    expect(columns.rawRow.notNull).toBe(true);
    expect(columns.factsPrefill.notNull).toBe(true);
    expect(columns.contentDigest.notNull).toBe(true);
  });

  it("allows a link row that has no draft yet", () => {
    expect(getTableColumns(platformProducts).listingId.notNull).toBe(false);
  });

  it("keeps the connection and draft references tenant scoped", () => {
    const foreignKeys = foreignKeysOf(platformProducts);

    expect(foreignKeys).toContainEqual({
      columns: ["workspace_id", "connection_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: shoplineConnections,
      onDelete: "cascade",
    });
    // Restrict, not cascade: deleting a draft must not destroy the catalog
    // mirror row, whose digest is what detects a real catalog change.
    expect(foreignKeys).toContainEqual({
      columns: ["workspace_id", "listing_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: listingDrafts,
      onDelete: "restrict",
    });
  });

  it("anchors the tenancy boundary the RLS policy is keyed to", () => {
    const columns = getTableColumns(platformProducts);

    expect(columns.workspaceId.notNull).toBe(true);
    expect(getTableConfig(platformProducts).name).toBe("platform_products");
  });

  it("admits one row per remote product per connection", () => {
    const uniqueIndexes = getTableConfig(platformProducts)
      .indexes.filter((index) => index.config.unique)
      .map((index) => index.config.columns.map((column) => (column as { name: string }).name));

    expect(uniqueIndexes).toContainEqual(["workspace_id", "id"]);
    expect(uniqueIndexes).toContainEqual(["workspace_id", "connection_id", "remote_product_id"]);
  });
});
