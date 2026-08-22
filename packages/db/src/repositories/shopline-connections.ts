import { and, asc, eq } from "drizzle-orm";
import { encryptShoplineToken } from "@wukong/shopline";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { shoplineConnections } from "../schema.js";

export type ShoplineConnection = {
  id: string;
  shopDomain: string;
  encryptedAccessToken: string;
};

export type ShoplineConnectionSummary = {
  id: string;
  shopDomain: string;
  createdAt: Date;
};

export type ShoplineConnectionRepository = {
  getDefault(): Promise<ShoplineConnection | null>;
  getById(id: string): Promise<ShoplineConnection | null>;
  create(input: {
    shopDomain: string;
    accessToken: string;
    base64Key: string;
  }): Promise<ShoplineConnectionSummary>;
  update(
    id: string,
    input: { accessToken: string; base64Key: string },
  ): Promise<void>;
};

export function createShoplineConnectionRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ShoplineConnectionRepository {
  const select = async (id?: string): Promise<ShoplineConnection | null> => {
    scope.assertOpen();
    const [row] = await transaction
      .select({
        id: shoplineConnections.id,
        shopDomain: shoplineConnections.shopDomain,
        encryptedAccessToken: shoplineConnections.encryptedAccessToken,
      })
      .from(shoplineConnections)
      .where(
        and(
          eq(shoplineConnections.workspaceId, workspaceId),
          ...(id ? [eq(shoplineConnections.id, id)] : []),
        ),
      )
      .orderBy(asc(shoplineConnections.createdAt))
      .limit(1);
    if (!row || !row.encryptedAccessToken.trim()) return null;
    return row;
  };

  return {
    getDefault: () => select(),
    getById: (id) => select(id),

    async create({ shopDomain, accessToken, base64Key }) {
      scope.assertOpen();
      const existing = await select();
      if (existing) {
        throw new Error(
          "a SHOPLINE connection already exists for this workspace",
        );
      }
      const encryptedAccessToken = await encryptShoplineToken(
        accessToken,
        base64Key,
      );
      const [row] = await transaction
        .insert(shoplineConnections)
        .values({ workspaceId, shopDomain, encryptedAccessToken })
        .returning({
          id: shoplineConnections.id,
          shopDomain: shoplineConnections.shopDomain,
          createdAt: shoplineConnections.createdAt,
        });
      if (!row) throw new Error("failed to create SHOPLINE connection");
      return row;
    },

    async update(id, { accessToken, base64Key }) {
      scope.assertOpen();
      const encryptedAccessToken = await encryptShoplineToken(
        accessToken,
        base64Key,
      );
      const updated = await transaction
        .update(shoplineConnections)
        .set({ encryptedAccessToken, updatedAt: new Date() })
        .where(
          and(
            eq(shoplineConnections.workspaceId, workspaceId),
            eq(shoplineConnections.id, id),
          ),
        )
        .returning({ id: shoplineConnections.id });
      if (updated.length !== 1) {
        throw new Error("SHOPLINE connection not found");
      }
    },
  };
}
