/** Reproducible LOCAL fixture only. Start copy first (no Tavily/storage vars), then full. */
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const mode = process.argv[2];
if (!["copy", "full"].includes(mode))
  throw Error("usage: node tests/e2e/wine-runtime-harness.mjs copy|full");
const root = process.cwd(),
  path = resolve(root, ".wrangler/wine-sdd/runtime-8c.json");
const config = {
  name: "wine-runtime-local-8c",
  main: resolve(root, "tests/e2e/wine-runtime-worker.ts"),
  compatibility_date: "2026-07-19",
  compatibility_flags: ["nodejs_compat"],
  hyperdrive: [
    {
      binding: "HYPERDRIVE",
      id: "00000000000000000000000000000001",
      localConnectionString:
        "postgres://wukong_app:wukong-app-local@127.0.0.1:54329/wukong_wine_sdd",
    },
  ],
  vars: {
    OPENCODE_GO_API_KEY: "synthetic-local-only",
    QUEUE_INGRESS_SECRET: "wine-runtime-local-synthetic-ingress",
    BUILD_SHA: "abc1234",
    LISTING_PAID_OPERATIONS_ENABLED: "false",
    SHOPLINE_PUBLISH_ENABLED: "false",
    AI_PROVIDER: "fake",
    ...(mode === "full"
      ? {
          TAVILY_API_KEY: "synthetic-local-only",
          WEBSITE_FETCH_BASE_URL: "https://callback.test",
          S3_BUCKET: "wukong-local",
          S3_ENDPOINT: "https://localhost:9012",
          S3_REGION: "us-east-1",
          S3_FORCE_PATH_STYLE: "true",
          S3_ACCESS_KEY_ID: "wukong",
          S3_SECRET_ACCESS_KEY: "wukong-secret",
        }
      : {}),
  },
  queues: {
    producers: [
      { binding: "LISTING_QUEUE", queue: "wukong-listing-preview" },
      { binding: "SHOPLINE_QUEUE", queue: "wukong-shopline-preview" },
    ],
    consumers: [
      {
        queue: "wukong-listing-preview",
        max_batch_size: 1,
        max_batch_timeout: 1,
        max_retries: 3,
        retry_delay: 1,
        max_concurrency: 1,
      },
    ],
  },
};
await mkdir(resolve(root, ".wrangler/wine-sdd"), { recursive: true });
await writeFile(path, JSON.stringify(config, null, 2));
const child = spawn(
  process.execPath,
  [
    resolve(root, "apps/worker/node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--config",
    path,
    "--ip",
    "127.0.0.1",
    "--port",
    "8789",
    "--local",
    "--persist-to",
    resolve(root, ".wrangler/state/wine-runtime-8c"),
    "--log-level",
    "info",
  ],
  {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      NODE_EXTRA_CA_CERTS: resolve(
        root,
        ".wrangler/caddy-data/caddy/pki/authorities/local/root.crt",
      ),
    },
  },
);
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
