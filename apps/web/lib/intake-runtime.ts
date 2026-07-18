import { readS3RuntimeConfig, S3AssetStore, type AssetStore } from "@wukong/assets";
import { createDatabase, type Database } from "@wukong/db";

let assetStore: AssetStore | undefined;
let database: Database | undefined;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function getAssetStore(): AssetStore {
  const config = readS3RuntimeConfig(process.env);
  assetStore ??= S3AssetStore.fromConfig(config.bucket, config.client);
  return assetStore;
}

export function getDatabase(): Database {
  database ??= createDatabase(requiredEnv("DATABASE_URL"), {
    migrationUrl: process.env.DATABASE_MIGRATION_URL,
  });
  return database;
}