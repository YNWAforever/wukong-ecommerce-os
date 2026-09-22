import { readS3RuntimeConfig } from "@wukong/assets";
import { createWineDocumentClient } from "./wine-document-client.js";
import type { WorkerEnv } from "./worker-env.js";
/** Pure configuration inspection. No provider HTTP, storage I/O or secret material in output. */
export function wineRuntimeConfiguration(env: WorkerEnv) {
  let storageConfigured = false,
    documentConfigured = false;
  try {
    const storage = readS3RuntimeConfig({
      S3_BUCKET: env.S3_BUCKET,
      S3_ENDPOINT: env.S3_ENDPOINT,
      S3_REGION: env.S3_REGION,
      S3_FORCE_PATH_STYLE: env.S3_FORCE_PATH_STYLE,
      S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
    });
    const endpoint = new URL(String(storage.client.endpoint));
    storageConfigured =
      endpoint.protocol === "https:" &&
      !endpoint.username &&
      !endpoint.password;
  } catch {}
  try {
    createWineDocumentClient({
      baseUrl: env.WEBSITE_FETCH_BASE_URL ?? "",
      secret: env.QUEUE_INGRESS_SECRET ?? "",
    });
    documentConfigured = true;
  } catch {}
  return {
    storageConfigured,
    documentConfigured,
    fullResearchConfigured:
      storageConfigured &&
      documentConfigured &&
      Boolean(env.TAVILY_API_KEY?.trim()),
  };
}
