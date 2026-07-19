import { spawn } from "node:child_process";

const root = process.cwd();
const port = process.env.PORT ?? "49217";
const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const runtimeEnv = {
  ...process.env,
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    "postgres://wukong_app:wukong-app-local@127.0.0.1:54329/wukong",
  REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6389",
  S3_BUCKET: process.env.S3_BUCKET ?? "wukong-local",
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9010",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "wukong",
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "wukong-secret",
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE ?? "true",
  AI_PROVIDER: "fake",
  SHOPLINE_ADAPTER: "mock",
  AUTH_SECRET:
    process.env.AUTH_SECRET ??
    "local-real-stack-auth-secret-at-least-thirty-two-characters",
  AUTH_SMTP_URL: process.env.AUTH_SMTP_URL ?? "smtp://127.0.0.1:1026",
  AUTH_EMAIL_FROM:
    process.env.AUTH_EMAIL_FROM ?? "Wukong Auth <auth@local.invalid>",
  BETTER_AUTH_URL: baseUrl,
};

const children = new Set();
let stopping = false;

function start(label, args) {
  const command =
    process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
  const commandArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", ["pnpm.cmd", ...args].join(" ")]
      : args;
  const child = spawn(command, commandArgs, {
    cwd: root,
    env: runtimeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout.on("data", (chunk) =>
    process.stdout.write(`[${label}] ${chunk}`),
  );
  child.stderr.on("data", (chunk) =>
    process.stderr.write(`[${label}] ${chunk}`),
  );
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(
        `${label} exited before the acceptance server stopped (${code ?? signal})`,
      );
      void stop(1);
    }
  });
  return child;
}

async function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
    return;
  }
  child.kill("SIGTERM");
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all([...children].map(terminateTree));
  process.exitCode = code;
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

start("worker", ["--filter", "@wukong/worker", "start"]);
start("web", [
  "--filter",
  "@wukong/web",
  "start",
  "--hostname",
  "127.0.0.1",
  "--port",
  port,
]);

await new Promise(() => {});
