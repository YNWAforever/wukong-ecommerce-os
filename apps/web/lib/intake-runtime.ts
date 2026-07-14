import { S3AssetStore, type AssetStore } from "@wukong/assets";
import { createDatabase, type Database } from "@wukong/db";

let assetStore: AssetStore | undefined;
let database: Database | undefined;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function getAssetStore(): AssetStore {
  assetStore ??= S3AssetStore.fromConfig(requiredEnv("S3_BUCKET"), {
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    region: process.env.S3_REGION ?? "auto",
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
  return assetStore;
}

export function getDatabase(): Database {
  database ??= createDatabase(requiredEnv("DATABASE_URL"), {
    migrationUrl: process.env.DATABASE_MIGRATION_URL,
  });
  return database;
}
