import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const serverModuleUrl = pathToFileURL(
  resolve("tests/e2e/real-stack-server.mjs"),
).href;

async function runNativeProbe(source: string) {
  return execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      env: { ...process.env, WUKONG_REAL_STACK_SERVER: "0" },
      timeout: 10_000,
      windowsHide: true,
    },
  );
}

test("release harness crosses the Wrangler Worker and Queue boundary", async () => {
  const [
    fixtureSource,
    serverSource,
    workerSource,
    composeSource,
    playwrightSource,
  ] = await Promise.all([
    readFile("tests/e2e/real-stack-fixture.ts", "utf8"),
    readFile("tests/e2e/real-stack-server.mjs", "utf8"),
    readFile("apps/worker/src/cloudflare.ts", "utf8"),
    readFile("docker-compose.yml", "utf8"),
    readFile("playwright.config.ts", "utf8"),
  ]);

  expect(fixtureSource).not.toMatch(
    /publishApprovedProduct|completeMockShoplinePublish/,
  );
  expect(serverSource).toMatch(/wrangler.+dev/s);
  expect(serverSource).toMatch(/const SENSITIVE_BINDINGS = new Set/);
  expect(serverSource).toMatch(/ANSI_ESCAPE_PATTERN/);
  expect(serverSource).toMatch(/export function createSanitizedLineWriter/);
  expect(serverSource).toMatch(/export function spawnProcessGroup/);
  expect(serverSource).toMatch(/export async function terminateProcessTree/);
  expect(serverSource).toMatch(/import\.meta\.url/);
  expect(serverSource).toMatch(
    /process\.env\.WUKONG_REAL_STACK_SERVER === "1"/,
  );
  expect(playwrightSource).toMatch(/WUKONG_REAL_STACK_SERVER: "1"/);
  expect(
    serverSource.match(
      /CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE/g,
    ) ?? [],
  ).toHaveLength(1);
  expect(serverSource).toMatch(
    /delete runtimeEnv\[localHyperdriveEnvironmentVariable\][\s\S]*?const workerEnv = \{[\s\S]*?\.\.\.runtimeEnv,[\s\S]*?\[localHyperdriveEnvironmentVariable\]: runtimeUrl/,
  );
  expect(serverSource).toMatch(/start\(\s*"wrangler",[\s\S]*?workerEnv,\s*\);/);
  expect(serverSource).not.toMatch(
    /child\.once\("exit"[\s\S]+?children\.delete\(child\);\s*if \(!stopping\)/,
  );
  expect(serverSource).toMatch(/waitForTlsPort/);
  expect(serverSource).toMatch(/NODE_EXTRA_CA_CERTS/);
  expect(composeSource).toMatch(/minio-tls:/);
  expect(composeSource).toContain("./.wrangler/caddy-data:/data");
  expect(composeSource).toMatch(/method HEAD/);
  expect(composeSource).toMatch(/method GET/);
  expect(composeSource).not.toMatch(/^  redis:/m);
  expect(playwrightSource).toMatch(/ignoreHTTPSErrors: enabled/);
  expect(workerSource).toMatch(/fetch:/);
  expect(workerSource).toMatch(/queue:/);
});

test("sanitized writer never emits raw partial secrets across chunk boundaries", async () => {
  const probe = `
    import assert from "node:assert/strict";
    const { createSanitizedLineWriter } = await import(${JSON.stringify(serverModuleUrl)});
    const ingressSecret = "ingress.*(secret)[1]";
    const databaseUrl = "postgresql://operator:p%29ss@database.internal/wukong?mode=(strict)";
    const bindingValue = "credential)with.*regex[chars]";
    const writes = [];
    const writer = createSanitizedLineWriter({
      label: "wrangler",
      sink: { write: (value) => writes.push(String(value)) },
      sensitiveValues: [ingressSecret, bindingValue],
      sensitiveBindings: ["S3_SECRET_ACCESS_KEY"],
    });

    writer.write("prefix " + ingressSecret.slice(0, 9));
    assert.deepEqual(writes, []);
    writer.write(ingressSecret.slice(9) + " suffix\\nDB " + databaseUrl.slice(0, 28));
    assert(!writes.join("").includes(ingressSecret));
    assert(!writes.join("").includes(databaseUrl.slice(0, 28)));
    writer.write(databaseUrl.slice(28) + "\\n\\u001b[3");
    assert(!writes.join("").includes(databaseUrl));
    writer.write("7menv.S3_SECRET_ACCESS_KEY\\u001b[39m (\\u001b[2m\\\"" + bindingValue.slice(0, 12));
    assert(!writes.join("").includes(bindingValue.slice(0, 12)));
    writer.write(bindingValue.slice(12) + "\\\"\\u001b[22m) Environment Variable");
    assert(!writes.join("").includes(bindingValue));
    writer.flush();

    const output = writes.join("");
    assert(!output.includes(ingressSecret));
    assert(!output.includes(databaseUrl));
    assert(!output.includes(bindingValue));
    assert(!output.includes("\\u001b"));
    assert(output.includes("prefix [redacted] suffix"));
    assert(output.includes("DB [database-url]"));
    assert(output.includes("env.S3_SECRET_ACCESS_KEY ([redacted]) Environment Variable"));
    process.stdout.write("split-chunk redaction ok");
  `;

  const { stdout } = await runNativeProbe(probe);
  expect(stdout).toContain("split-chunk redaction ok");
});

test("POSIX process-group cleanup terminates normal and stubborn descendants", async () => {
  test.skip(process.platform === "win32", "POSIX process-group regression");
  const probe = `
    import assert from "node:assert/strict";
    const { spawnProcessGroup, terminateProcessTree } = await import(${JSON.stringify(serverModuleUrl)});

    async function waitForReady(child) {
      await new Promise((resolveReady, rejectReady) => {
        let output = "";
        const timer = setTimeout(() => rejectReady(new Error("child readiness timed out")), 2000);
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes("ready:")) {
            clearTimeout(timer);
            resolveReady();
          }
        });
        child.once("error", rejectReady);
      });
    }

    async function runCase(ignoreSigterm) {
      const descendantCode = ignoreSigterm
        ? 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'
        : 'setInterval(()=>{},1000)';
      const parentCode = [
        'const { spawn } = require("node:child_process");',
        ignoreSigterm
          ? 'process.on("SIGTERM",()=>{});'
          : 'process.on("SIGTERM",()=>process.exit(0));',
        'const child = spawn(process.execPath, ["-e", ' + JSON.stringify(descendantCode) + '], { stdio: "ignore" });',
        'process.stdout.write("ready:" + child.pid + "\\\\n");',
        'setInterval(()=>{},1000);',
      ].join("\\n");
      const child = spawnProcessGroup(process.execPath, ["-e", parentCode], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      try {
        await waitForReady(child);
        const result = await terminateProcessTree(child, {
          graceMs: 200,
          forceMs: 2000,
        });
        assert.equal(result.forced, ignoreSigterm);
        assert(child.exitCode !== null || child.signalCode !== null);
        let groupAlive = true;
        try {
          process.kill(-child.pid, 0);
        } catch {
          groupAlive = false;
        }
        assert.equal(groupAlive, false);
      } finally {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
      }
    }

    await runCase(false);
    await runCase(true);
    process.stdout.write("posix process cleanup ok");
  `;

  const { stdout } = await runNativeProbe(probe);
  expect(stdout).toContain("posix process cleanup ok");
});

test.describe("real-stack runtime", () => {
  test.beforeEach(() => {
    test.skip(
      process.env.PLAYWRIGHT_E2E !== "1",
      "Set PLAYWRIGHT_E2E=1 to run the real local-stack acceptance gate.",
    );
  });

  test("release E2E runs against the real application boundary", async ({
    page,
    request,
  }) => {
    const session = await request.get("/api/auth/get-session");
    expect(session.status()).toBe(200);
    expect(await session.json()).toBeNull();

    await page.goto("/signin");
    await expect(
      page.getByRole("heading", { name: "Welcome back" }),
    ).toBeVisible();
    await expect(page.locator("body")).toContainText("Password");
  });
});
