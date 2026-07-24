import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connect as connectTls } from "node:tls";

const root = process.cwd();
const port = process.env.PORT ?? "49217";
const workerPort = "8787";
const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const workerUrl = `http://127.0.0.1:${workerPort}`;
const runtimeUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@127.0.0.1:54329/wukong";
const ingressSecret = "local-e2e-ingress-secret-only-not-for-production-2026";
const wranglerConfig = ".wrangler/wrangler.e2e.generated.jsonc";
const wranglerConfigFromWorker = "../../.wrangler/wrangler.e2e.generated.jsonc";
const localCaPath = resolve(
  root,
  ".wrangler/caddy-data/caddy/pki/authorities/local/root.crt",
);
const localHyperdriveEnvironmentVariable =
  "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE";
const runtimeEnv = {
  ...process.env,
  DATABASE_URL: runtimeUrl,
  NODE_EXTRA_CA_CERTS: localCaPath,
  S3_BUCKET: process.env.S3_BUCKET ?? "wukong-local",
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "https://localhost:9012",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "wukong",
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "wukong-secret",
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE ?? "true",
  AI_PROVIDER: "fake",
  SHOPLINE_ADAPTER: "mock",
  QUEUE_INGRESS_URL: workerUrl,
  QUEUE_INGRESS_SECRET: ingressSecret,

  AUTH_SECRET:
    process.env.AUTH_SECRET ??
    "local-real-stack-auth-secret-at-least-thirty-two-characters",
  AUTH_SMTP_URL: process.env.AUTH_SMTP_URL ?? "smtp://127.0.0.1:1026",
  AUTH_EMAIL_FROM:
    process.env.AUTH_EMAIL_FROM ?? "Wukong Auth <auth@local.invalid>",
  BETTER_AUTH_URL: baseUrl,
};

delete runtimeEnv[localHyperdriveEnvironmentVariable];
const workerEnv = {
  ...runtimeEnv,
  [localHyperdriveEnvironmentVariable]: runtimeUrl,
};

const localWrangler = {
  name: "wukong-runtime-e2e",
  main: resolve(root, "apps/worker/src/cloudflare.ts"),
  compatibility_date: "2026-07-19",
  compatibility_flags: ["nodejs_compat"],
  hyperdrive: [
    {
      binding: "HYPERDRIVE",
      id: "00000000000000000000000000000001",
      localConnectionString: runtimeUrl,
    },
  ],
  vars: {
    QUEUE_INGRESS_SECRET: ingressSecret,
    BUILD_SHA: "local-e2e",
    SHOPLINE_ADAPTER: "mock",
    SHOPLINE_PUBLISH_ENABLED: "false",
    AI_PROVIDER: "fake",
    S3_BUCKET: runtimeEnv.S3_BUCKET,
    S3_ENDPOINT: runtimeEnv.S3_ENDPOINT,
    S3_REGION: runtimeEnv.S3_REGION,
    S3_ACCESS_KEY_ID: runtimeEnv.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: runtimeEnv.S3_SECRET_ACCESS_KEY,
    S3_FORCE_PATH_STYLE: runtimeEnv.S3_FORCE_PATH_STYLE,
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
        dead_letter_queue: "wukong-listing-dlq-preview",
      },
      {
        queue: "wukong-shopline-preview",
        max_batch_size: 1,
        max_batch_timeout: 1,
        max_retries: 3,
        retry_delay: 1,
        max_concurrency: 1,
        dead_letter_queue: "wukong-shopline-dlq-preview",
      },
    ],
  },
};

const children = new Set();
const logs = new Map();
let stopping = false;
let stopPromise;
const SENSITIVE_BINDINGS = new Set([
  "QUEUE_INGRESS_SECRET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "SHOPLINE_TOKEN_ENCRYPTION_KEY",
]);
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const DEFAULT_SENSITIVE_VALUES = [
  ingressSecret,
  runtimeUrl,
  runtimeEnv.S3_ACCESS_KEY_ID,
  runtimeEnv.S3_SECRET_ACCESS_KEY,
  runtimeEnv.AUTH_SECRET,
  process.env.SHOPLINE_TOKEN_ENCRYPTION_KEY,
].filter((value) => typeof value === "string" && value.length > 0);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createSensitiveValuePattern(values) {
  const alternatives = [...new Set(values)]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegex);
  return alternatives.length > 0
    ? new RegExp(alternatives.join("|"), "g")
    : null;
}

const DEFAULT_SENSITIVE_VALUE_PATTERN = createSensitiveValuePattern(
  DEFAULT_SENSITIVE_VALUES,
);

function sanitizeRuntime(value) {
  return sanitize(value, DEFAULT_SENSITIVE_VALUE_PATTERN, SENSITIVE_BINDINGS);
}

function sanitize(value, sensitiveValuePattern, sensitiveBindings) {
  let safe = value.replace(ANSI_ESCAPE_PATTERN, "");
  for (const binding of sensitiveBindings) {
    const bindingPattern = new RegExp(
      `(env\\.${escapeRegex(binding)}\\s+\\()(?:"(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*'|.*)(\\)(?:\\s|$))`,
      "g",
    );
    safe = safe.replace(bindingPattern, "$1[redacted]$2");
  }
  if (sensitiveValuePattern) {
    safe = safe.replace(sensitiveValuePattern, "[redacted]");
  }
  return safe
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[database-url]")
    .replace(
      /(secret|token|password|api[_-]?key)\s*=\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+)/gi,
      "$1=[redacted]",
    );
}

export function createSanitizedLineWriter({
  label,
  sink,
  onSanitizedOutput = () => {},
  sensitiveValues = [],
  sensitiveBindings = [...SENSITIVE_BINDINGS],
}) {
  const sensitiveValuePattern = createSensitiveValuePattern([
    ...DEFAULT_SENSITIVE_VALUES,
    ...sensitiveValues,
  ]);
  let rawPartial = "";

  function emit(rawLine) {
    const safe = sanitize(
      rawLine,
      sensitiveValuePattern,
      new Set(sensitiveBindings),
    );
    onSanitizedOutput(safe);
    sink.write(`[${label}] ${safe}`);
  }

  return {
    write(chunk) {
      rawPartial += String(chunk);
      let newlineIndex = rawPartial.indexOf("\n");
      while (newlineIndex >= 0) {
        const completeLine = rawPartial.slice(0, newlineIndex + 1);
        rawPartial = rawPartial.slice(newlineIndex + 1);
        emit(completeLine);
        newlineIndex = rawPartial.indexOf("\n");
      }
    },
    flush() {
      if (rawPartial.length === 0) return;
      const finalPartial = rawPartial;
      rawPartial = "";
      emit(finalPartial);
    },
  };
}
export function spawnProcessGroup(command, args, options = {}) {
  return spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
  });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !isProcessGroupAlive(pid);
}

export async function terminateProcessTree(
  child,
  { graceMs = 5_000, forceMs = 5_000 } = {},
) {
  if (!child.pid) return { forced: false };
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { forced: false };
    }
    await new Promise((resolveKill) => {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("exit", resolveKill);
      killer.once("error", resolveKill);
    });
    if (!(await waitForChildExit(child, forceMs))) {
      throw new Error(`Windows process tree ${child.pid} did not exit`);
    }
    return { forced: true };
  }

  let forced = false;
  if (isProcessGroupAlive(child.pid)) {
    signalProcessGroup(child.pid, "SIGTERM");
    if (!(await waitForProcessGroupExit(child.pid, graceMs))) {
      forced = true;
      signalProcessGroup(child.pid, "SIGKILL");
      if (!(await waitForProcessGroupExit(child.pid, forceMs))) {
        throw new Error(`POSIX process group ${child.pid} did not exit`);
      }
    }
  }
  if (!(await waitForChildExit(child, forceMs))) {
    throw new Error(`POSIX process leader ${child.pid} did not exit`);
  }
  return { forced };
}
function recordLogs(label, safe) {
  const lines = `${logs.get(label) ?? ""}${safe}`.split(/\r?\n/).slice(-20);
  logs.set(label, lines.join("\n"));
}

function start(label, args, environment = runtimeEnv) {
  const command =
    process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
  const commandArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", ["pnpm.cmd", ...args].join(" ")]
      : args;
  const child = spawnProcessGroup(command, commandArgs, {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = createSanitizedLineWriter({
    label,
    sink: process.stdout,
    onSanitizedOutput: (safe) => recordLogs(label, safe),
  });
  const stderr = createSanitizedLineWriter({
    label,
    sink: process.stderr,
    onSanitizedOutput: (safe) => recordLogs(label, safe),
  });
  children.add(child);
  child.stdout.on("data", (chunk) => stdout.write(chunk));
  child.stderr.on("data", (chunk) => stderr.write(chunk));
  child.stdout.once("end", () => stdout.flush());
  child.stderr.once("end", () => stderr.flush());
  child.once("exit", (code, signal) => {
    if (!stopping) {
      const detail = logs.get(label) ?? "(no output)";
      console.error(
        `${label} exited before readiness (${code ?? signal})\n${detail}`,
      );
      void stop(1);
    } else {
      children.delete(child);
    }
  });
  child.once("error", (error) => {
    if (!stopping) {
      console.error(
        `${label} failed to start: ${sanitizeRuntime(error.message)}`,
      );
      void stop(1);
    }
  });
  return child;
}

async function waitFor(url, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The process may still be starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`${label} readiness timed out`);
}

async function waitForTlsPort(host, tlsPort, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    const ready = await new Promise((resolveReady) => {
      const socket = connectTls(
        { host, port: tlsPort, servername: host, rejectUnauthorized: false },
        () => {
          socket.end();
          resolveReady(true);
        },
      );
      socket.setTimeout(1_000, () => socket.destroy());
      socket.once("error", () => resolveReady(false));
      socket.once("close", () => resolveReady(false));
    });
    if (ready) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Local MinIO TLS proxy readiness timed out");
}

function stop(code = 0) {
  if (code !== 0) process.exitCode = code;
  if (stopPromise) return stopPromise;
  stopping = true;
  process.exitCode ??= code;
  stopPromise = (async () => {
    const results = await Promise.allSettled(
      [...children].map((child) => terminateProcessTree(child)),
    );
    children.clear();
    for (const result of results) {
      if (result.status === "rejected") {
        process.exitCode = 1;
        console.error(
          sanitizeRuntime(
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
          ),
        );
      }
    }
  })();
  return stopPromise;
}

async function runServer() {
  stopping = false;
  await mkdir(".wrangler", { recursive: true });
  await writeFile(
    wranglerConfig,
    `${JSON.stringify(localWrangler, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.once("uncaughtException", (error) => {
    console.error(
      sanitizeRuntime(error instanceof Error ? error.message : String(error)),
    );
    void stop(1);
  });
  process.once("unhandledRejection", (error) => {
    console.error(
      sanitizeRuntime(error instanceof Error ? error.message : String(error)),
    );
    void stop(1);
  });

  try {
    await waitForTlsPort("localhost", 9012);
    await access(localCaPath);

    start(
      "wrangler",
      [
        "--filter",
        "@wukong/worker",
        "exec",
        "wrangler",
        "dev",
        "--config",
        wranglerConfigFromWorker,
        "--ip",
        "127.0.0.1",
        "--port",
        workerPort,
        "--local",
        "--persist-to",
        "../../.wrangler/state/e2e",
      ],
      workerEnv,
    );
    await waitFor(`${workerUrl}/health`, "Wrangler");

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
  } catch (error) {
    console.error(
      sanitizeRuntime(error instanceof Error ? error.message : String(error)),
    );
    await stop(1);
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (
  process.env.WUKONG_REAL_STACK_SERVER === "1" &&
  import.meta.url === entryPoint
) {
  void runServer();
}
