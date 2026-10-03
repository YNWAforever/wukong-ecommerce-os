import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import test from "node:test";

import {
  spawnProcessGroup,
  terminateProcessTree,
} from "./e2e/real-stack-server.mjs";

async function waitForTestChild(child, timeoutMs = 5_000) {
  let deadlineExpired = false;
  let deadlineCleanup;
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    deadlineCleanup = terminateProcessTree(child, {
      graceMs: 1_000,
      forceMs: 3_000,
    });
    // Observe errors immediately, then propagate them after the process closes.
    deadlineCleanup.catch(() => {});
  }, timeoutMs);
  let exit;
  try {
    [exit] = await once(child, "close");
  } finally {
    clearTimeout(deadline);
    if (deadlineCleanup) await deadlineCleanup;
  }
  return { exit, deadlineExpired };
}

test(
  "rejects an occupied image port before launching web or worker services",
  { timeout: 20_000 },
  async () => {
    const held = net.createServer((socket) => socket.end("owned-port"));
    held.listen(49218, "127.0.0.1");
    await once(held, "listening");
    const directory = await mkdtemp(join(tmpdir(), "wukong-startup-"));
    let child;
    try {
      const certificates = join(
        directory,
        "node_modules/.photoroom-services/certs",
      );
      await mkdir(certificates, { recursive: true });
      const openssl =
        process.platform === "win32"
          ? "C:/Program Files/Git/usr/bin/openssl.exe"
          : "openssl";
      const generated = spawnSync(
        openssl,
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          "private.key",
          "-out",
          "public.crt",
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
        ],
        { cwd: certificates, stdio: "ignore", windowsHide: true },
      );
      assert.equal(
        generated.status,
        0,
        "generate only this test's ephemeral localhost certificate",
      );
      const ca = join(
        directory,
        ".wrangler/caddy-data/caddy/pki/authorities/local",
      );
      await mkdir(ca, { recursive: true });
      await writeFile(join(ca, "root.crt"), "unused local fixture CA\n");
      const fakeService = join(directory, "service.mjs");
      await writeFile(
        fakeService,
        `import http from 'node:http';
const args=process.argv.slice(2), port=args.includes('wrangler')?8787:49217;
console.error('TEST_CHILD_STARTED');
const server=http.createServer((_request,response)=>response.end('ready'));
server.listen(port,'127.0.0.1');
process.on('SIGTERM',()=>server.close());\n`,
      );
      if (process.platform === "win32") {
        await writeFile(
          join(directory, "pnpm.cmd"),
          `@"${process.execPath}" "%~dp0service.mjs" %*\r\n`,
        );
      } else {
        const executable = join(directory, "pnpm");
        await writeFile(
          executable,
          `#!/usr/bin/env node\nimport './service.mjs';\n`,
        );
        await chmod(executable, 0o755);
        await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
      }
      const safeEnv = {};
      for (const key of [
        "PATH",
        "Path",
        "SystemRoot",
        "ComSpec",
        "TEMP",
        "TMP",
        "PATHEXT",
      ]) {
        if (process.env[key] !== undefined) safeEnv[key] = process.env[key];
      }
      delete safeEnv.Path;
      safeEnv.PATH =
        directory + delimiter + (process.env.PATH ?? process.env.Path ?? "");
      Object.assign(safeEnv, {
        WUKONG_REAL_STACK_SERVER: "1",
        WUKONG_PRODUCT_SHOT_E2E: "1",
        E2E_WEBSITE_FETCH_BASE_URL: "http://127.0.0.1:49219",
        NODE_EXTRA_CA_CERTS: "",
      });
      let stderr = "";
      child = spawnProcessGroup(
        process.execPath,
        [
          fileURLToPath(
            new URL("./e2e/real-stack-server.mjs", import.meta.url),
          ),
        ],
        {
          cwd: directory,
          env: safeEnv,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.on("data", () => {});
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const { exit, deadlineExpired } = await waitForTestChild(child);
      assert.equal(
        deadlineExpired,
        false,
        "port rejection must not wait for another dependency",
      );
      assert.equal(exit, 1);
      assert.match(stderr, /EADDRINUSE.*127\.0\.0\.1:49218/);
      assert.doesNotMatch(
        stderr,
        /TEST_CHILD_STARTED/,
        "a conflicting image port must prevent service launch and false web readiness",
      );
      const client = net.connect({ port: 49218, host: "127.0.0.1" });
      const [bytes] = await once(client, "data");
      assert.equal(
        bytes.toString(),
        "owned-port",
        "startup failure must leave the conflicting owner untouched",
      );
      client.destroy();
    } finally {
      if (child)
        await terminateProcessTree(child, { graceMs: 1_000, forceMs: 3_000 });
      await new Promise((resolveClose) => held.close(resolveClose));
      assert.ok(
        resolve(directory).startsWith(resolve(tmpdir()) + "/") ||
          resolve(directory).startsWith(resolve(tmpdir()) + "\\"),
      );
      assert.ok(directory.split(/[\\/]/).at(-1).startsWith("wukong-startup-"));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Windows test deadline removes the owned service descendants",
  { skip: process.platform !== "win32", timeout: 15_000 },
  async () => {
    const leafCode = `const net=require('node:net');
const server=net.createServer(socket=>{socket.on('error',()=>{});socket.write('wukong-owned-deadline');});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,port:server.address().port})));`;
    const parentCode = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',${JSON.stringify(leafCode)}],{stdio:['ignore','pipe','ignore'],windowsHide:true,detached:true});
child.stdout.on('data',data=>process.stdout.write(data));`;
    const child = spawnProcessGroup(process.execPath, ["-e", parentCode], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", () => {});
    const lines = createInterface({ input: child.stdout });
    let leaf;
    let client;
    const alive = () => {
      try {
        process.kill(leaf.pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    };
    try {
      const [line] = await once(lines, "line");
      leaf = JSON.parse(line);
      assert.ok(Number.isInteger(leaf.pid) && Number.isInteger(leaf.port));
      client = net.connect({ host: "127.0.0.1", port: leaf.port });
      client.on("error", () => {});
      const [marker] = await once(client, "data");
      assert.equal(marker.toString(), "wukong-owned-deadline");
      const result = await waitForTestChild(child, 100);
      assert.equal(result.deadlineExpired, true);
      assert.equal(
        alive(),
        false,
        "the deadline must terminate the tree while its leader is alive",
      );
    } finally {
      lines.close();
      // The RED test may deliberately leak the leaf; kill only its confirmed own listener.
      if (leaf && client && !client.destroyed && alive())
        spawnSync("taskkill.exe", ["/PID", String(leaf.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      client?.destroy();
      await terminateProcessTree(child, { graceMs: 1_000, forceMs: 3_000 });
    }
  },
);
