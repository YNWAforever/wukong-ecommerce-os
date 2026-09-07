import { ProductImageApprovalRequiredError } from "@wukong/assets";
import {
  assertShoplineEncryptionKey,
  decryptShoplineToken,
  ShoplineConnector,
  type CommerceConnector,
  type ShoplineProductPayload,
} from "@wukong/shopline";

import type { WorkerEnv } from "./worker-env.js";

export type EncryptedShoplineConnection = {
  encryptedAccessToken: string;
};

export type ShoplineConnectorFactory = (
  connection?: EncryptedShoplineConnection,
) => Promise<CommerceConnector | null>;

async function mockRemoteProductId(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(idempotencyKey),
  );
  return `mock_${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16)}`;
}

function createMockConnector(): CommerceConnector {
  return {
    async verifyConnection() {
      return { merchantId: "mock_shopline" };
    },
    async createProduct(
      _payload: ShoplineProductPayload,
      idempotencyKey: string,
    ) {
      return { remoteProductId: await mockRemoteProductId(idempotencyKey) };
    },
    async updateProduct() {},
    async getProductStatus(remoteProductId: string) {
      return {
        exists: /^mock_[a-f0-9]{16}$/.test(remoteProductId),
        status: false,
      };
    },
  };
}

export function createShoplineConnectorFactory(
  env: Pick<
    WorkerEnv,
    | "SHOPLINE_ADAPTER"
    | "SHOPLINE_PUBLISH_ENABLED"
    | "SHOPLINE_TOKEN_ENCRYPTION_KEY"
  >,
): ShoplineConnectorFactory {
  const mode = env.SHOPLINE_ADAPTER ?? "disabled";
  if (mode === "disabled") return async () => null;
  if (mode === "mock") return async () => createMockConnector();
  if (mode !== "real") throw new Error("unsupported SHOPLINE adapter mode");
  if (env.SHOPLINE_PUBLISH_ENABLED !== "true") {
    throw new Error("SHOPLINE real publishing is disabled");
  }
  const base64Key = env.SHOPLINE_TOKEN_ENCRYPTION_KEY ?? "";
  assertShoplineEncryptionKey(base64Key);

  return async (connection) => {
    const token = await decryptShoplineToken(
      connection?.encryptedAccessToken ?? "",
      base64Key,
    );
    return new ShoplineConnector(token);
  };
}

/** Current publication is re-evaluated by the scoped repository on every queue delivery. */
export async function productImagePublicationForDelivery(
  repositories: Pick<
    import("@wukong/db").WorkspaceRepositories,
    "productShots"
  >,
  input: { listingId: string; versionId?: string; provider?: string },
) {
  if (!(await repositories.productShots.requiresWorkflow(input)))
    return undefined;
  if (!input.versionId) throw new ProductImageApprovalRequiredError();
  return {
    versionId: input.versionId,
    resolveApprovedProductImage: (value: {
      workspaceId: string;
      listingId: string;
      versionId: string;
      assetId: string;
    }) => repositories.productShots.resolveApprovedProductImage(value),
  };
}
