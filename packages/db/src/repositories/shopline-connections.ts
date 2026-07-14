import { and, asc, eq } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { shoplineConnections } from "../schema.js";

export type ShoplineConnection = {
  id: string;
  shopDomain: string;
  encryptedAccessToken: string;
};

export type ShoplineConnectionRepository = {
  getDefault(): Promise<ShoplineConnection | null>;
  getById(id: string): Promise<ShoplineConnection | null>;
};

export function createShoplineConnectionRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ShoplineConnectionRepository {
  const select = async (id?: string): Promise<ShoplineConnection | null> => {
    scope.assertOpen();
    const [row] = await transaction.select({
      id: shoplineConnections.id,
      shopDomain: shoplineConnections.shopDomain,
      encryptedAccessToken: shoplineConnections.encryptedAccessToken,
    }).from(shoplineConnections).where(and(
      eq(shoplineConnections.workspaceId, workspaceId),
      ...(id ? [eq(shoplineConnections.id, id)] : []),
    )).orderBy(asc(shoplineConnections.createdAt)).limit(1);
    if (!row || !row.encryptedAccessToken.trim()) return null;
    return row;
  };
  return { getDefault: () => select(), getById: (id) => select(id) };
}

