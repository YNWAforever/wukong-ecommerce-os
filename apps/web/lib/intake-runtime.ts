import {
  readS3RuntimeConfig,
  S3AssetStore,
  type AssetStore,
} from "@wukong/assets";
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

/**
 * No `migrationUrl`, deliberately.
 *
 * It used to pass `process.env.DATABASE_MIGRATION_URL` through, and nothing
 * could ever use it: `migrationUrl` is read only by `Database.migrate()`, which
 * the web app never calls. What the option did provide was a named channel for
 * putting an admin database URL on Vercel -- which
 * `docs/runbooks/production-ai-runtime.md` forbids outright, under a name
 * (`DATABASE_ADMIN_URL`) that this spelling quietly sidestepped. Migrations run
 * from a controlled release environment, not from the app.
 */
export function getDatabase(): Database {
  database ??= createDatabase(requiredEnv("DATABASE_URL"));
  return database;
}
