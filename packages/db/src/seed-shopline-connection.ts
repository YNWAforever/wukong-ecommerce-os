import { createInterface } from "node:readline";

import { encryptShoplineToken } from "@wukong/shopline";

import { createAuthDatabase, type AuthDatabase } from "./client.js";
import { shoplineConnections } from "./schema.js";
import { OPAK_WORKSPACE_ID } from "./seeds/opak-profile.js";

const OPAK_SHOP_DOMAIN = "opakcellar.com";
const STDIN_ONLY_ERROR =
  "SHOPLINE token must be provided exactly once on stdin";

export type ShoplineConnectionSeedStore = {
  upsert(input: {
    workspaceId: string;
    shopDomain: string;
    encryptedAccessToken: string;
  }): Promise<string>;
};

export type ShoplineConnectionSeedResult = {
  workspaceId: string;
  connectionId: string;
  shopDomain: string;
};

export type ShoplineConnectionSeedInput = {
  workspaceId: string;
  shopDomain: string;
  token: string;
  base64Key: string;
};

export async function seedShoplineConnection(
  store: ShoplineConnectionSeedStore,
  input: ShoplineConnectionSeedInput,
): Promise<ShoplineConnectionSeedResult> {
  const encryptedAccessToken = await encryptShoplineToken(
    input.token,
    input.base64Key,
  );
  const connectionId = await store.upsert({
    workspaceId: input.workspaceId,
    shopDomain: input.shopDomain,
    encryptedAccessToken,
  });
  return {
    workspaceId: input.workspaceId,
    connectionId,
    shopDomain: input.shopDomain,
  };
}

export function createShoplineConnectionSeedStore(
  db: AuthDatabase,
): ShoplineConnectionSeedStore {
  return {
    async upsert(input) {
      const [connection] = await db
        .insert(shoplineConnections)
        .values(input)
        .onConflictDoUpdate({
          target: [
            shoplineConnections.workspaceId,
            shoplineConnections.shopDomain,
          ],
          set: {
            encryptedAccessToken: input.encryptedAccessToken,
            updatedAt: new Date(),
          },
        })
        .returning({ id: shoplineConnections.id });
      if (!connection) throw new Error("SHOPLINE connection seed failed");
      return connection.id;
    },
  };
}

async function readTokenLine(input: NodeJS.ReadableStream): Promise<string> {
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
    terminal: false,
  });
  let token: string | undefined;
  let count = 0;
  try {
    for await (const line of lines) {
      count += 1;
      if (count > 1) throw new Error(STDIN_ONLY_ERROR);
      token = line;
    }
  } finally {
    lines.close();
  }
  if (count !== 1 || !token) throw new Error(STDIN_ONLY_ERROR);
  return token;
}

type SeedDatabase = AuthDatabase & { close(): Promise<void> };

export type ShoplineConnectionSeedRuntime = {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  stdin?: NodeJS.ReadableStream;
  stdout?: { write(value: string): unknown };
  databaseFactory?: (url: string) => SeedDatabase;
  storeFactory?: (db: AuthDatabase) => ShoplineConnectionSeedStore;
};

export async function runShoplineConnectionSeed(
  runtime: ShoplineConnectionSeedRuntime = {},
): Promise<ShoplineConnectionSeedResult> {
  const argv = runtime.argv ?? process.argv.slice(2);
  if (argv.length !== 0) throw new Error(STDIN_ONLY_ERROR);
  const token = await readTokenLine(runtime.stdin ?? process.stdin);
  const env = runtime.env ?? process.env;
  const base64Key = env.SHOPLINE_TOKEN_ENCRYPTION_KEY ?? "";
  const databaseUrl = env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  let database: SeedDatabase | undefined;
  let result: ShoplineConnectionSeedResult | undefined;
  let failure: Error | undefined;
  try {
    database = (runtime.databaseFactory ?? createAuthDatabase)(databaseUrl);
    result = await seedShoplineConnection(
      (runtime.storeFactory ?? createShoplineConnectionSeedStore)(database),
      {
        workspaceId: OPAK_WORKSPACE_ID,
        shopDomain: OPAK_SHOP_DOMAIN,
        token,
        base64Key,
      },
    );
  } catch (error) {
    failure =
      error instanceof Error &&
      error.message === "SHOPLINE credential is unavailable"
        ? new Error("SHOPLINE credential is unavailable")
        : new Error("SHOPLINE connection seed failed");
  } finally {
    try {
      if (database) await database.close();
    } catch {
      failure ??= new Error("SHOPLINE connection seed failed");
    }
  }
  if (failure) throw failure;
  if (!result) throw new Error("SHOPLINE connection seed failed");
  (runtime.stdout ?? process.stdout).write(JSON.stringify(result) + "\n");
  return result;
}

if (
  process.argv[1]
    ?.replaceAll("\\", "/")
    .endsWith("/seed-shopline-connection.ts")
) {
  await runShoplineConnectionSeed();
}
