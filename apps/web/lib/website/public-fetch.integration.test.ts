import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:https";
import { connect } from "node:tls";
import { createPublicFetch, type PublicFetchDeps } from "./public-fetch";

// Synthetic self-signed certificate; no merchant requests or production bypass.
let directory: string;
let cert: Buffer;
let server: Server;
let port: number;
let seen: { host: string | undefined; sni: string | false | null }[] = [];
const requestEvents = new Map<
  string,
  { received: () => void; closed: (destroyed: boolean) => void }
>();
function observeRequest(path: string) {
  const received = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<boolean>();
  requestEvents.set(path, {
    received: received.resolve,
    closed: closed.resolve,
  });
  return { received: received.promise, closed: closed.promise };
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "website-public-fetch-"));
  const openssl = existsSync("C:/Program Files/Git/usr/bin/openssl.exe")
    ? "C:/Program Files/Git/usr/bin/openssl.exe"
    : "openssl";
  execFileSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=store.example",
      "-addext",
      "subjectAltName=DNS:store.example",
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(join(directory, "cert.pem"));
  server = createServer(
    { key: readFileSync(join(directory, "key.pem")), cert },
    (req, res) => {
      seen.push({
        host: req.headers.host,
        sni: (req.socket as import("node:tls").TLSSocket).servername,
      });
      const events = requestEvents.get(req.url ?? "");
      if (events) {
        requestEvents.delete(req.url!);
        req.socket.once("close", () => events.closed(req.socket.destroyed));
        events.received();
      }
      res.setHeader("content-type", "text/html");
      if (req.url?.startsWith("/slow")) {
        res.write("start");
        return;
      }
      if (req.url?.startsWith("/large")) {
        res.write(Buffer.alloc(2 * 1024 * 1024 + 1));
        return;
      }
      res.end("<p>synthetic</p>");
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as import("node:net").AddressInfo).port;
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) rmSync(directory, { recursive: true, force: true });
});
const input = (
  path = "/",
  hostname = "store.example",
  signal = new AbortController().signal,
) => ({
  url: `https://${hostname}${path}`,
  kind: "product" as const,
  lockedOrigin: `https://${hostname}`,
  signal,
});
function transport() {
  const dialed: string[] = [];
  let resolutions = 0;
  const dial: NonNullable<PublicFetchDeps["dial"]> = (options) => {
    dialed.push(String(options.host));
    // Only this injected test dialer maps a validated public address to our local TLS fixture.
    return connect({ ...options, host: "127.0.0.1", port, ca: cert });
  };
  return {
    dialed,
    count: () => resolutions,
    fetch: createPublicFetch({
      dial,
      resolve: async () => [
        {
          address: ++resolutions === 1 ? "93.184.216.34" : "127.0.0.1",
          family: 4,
        },
      ],
    }),
  };
}
describe("Node pinned TLS adapter", () => {
  it("preserves SNI and Host and never asks DNS again on connection", async () => {
    const t = transport();
    const doc = await t.fetch(input());
    expect(doc.text).toBe("<p>synthetic</p>");
    expect(t.dialed).toEqual(["93.184.216.34"]);
    expect(t.count()).toBe(1);
    expect(seen.at(-1)).toEqual({
      host: "store.example",
      sni: "store.example",
    });
  });
  it("rejects a trusted certificate for the wrong hostname", async () => {
    await expect(
      transport().fetch(input("/", "wrong.example")),
    ).rejects.toHaveProperty("code", "transport_failed");
  });
  it("ignores ambient proxies", async () => {
    const keys = [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
      "https_proxy",
      "http_proxy",
      "all_proxy",
      "NODE_USE_ENV_PROXY",
    ];
    const previous = keys.map((key) => process.env[key]);
    try {
      for (const key of keys)
        process.env[key] =
          key === "NODE_USE_ENV_PROXY" ? "1" : "http://127.0.0.1:1";
      expect((await transport().fetch(input())).status).toBe(200);
    } finally {
      keys.forEach((key, i) => {
        const value = previous[i];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });
  it("destroys oversized response sockets", async () => {
    const events = observeRequest("/large-overflow");
    await expect(
      transport().fetch(input("/large-overflow")),
    ).rejects.toHaveProperty("code", "body_too_large");
    await expect(events.closed).resolves.toBe(true);
  });
  it("cancels body and socket at the total deadline", async () => {
    const events = observeRequest("/slow-deadline");
    await expect(
      transport().fetch(input("/slow-deadline")),
    ).rejects.toHaveProperty("code", "deadline_exceeded");
    await expect(events.closed).resolves.toBe(true);
  }, 15_000);
  it("cancels body and socket on caller abort", async () => {
    const events = observeRequest("/slow-abort");
    const c = new AbortController();
    const rejection = expect(
      transport().fetch(input("/slow-abort", "store.example", c.signal)),
    ).rejects.toHaveProperty("code", "aborted");
    await events.received;
    c.abort();
    await rejection;
    await expect(events.closed).resolves.toBe(true);
  });
});
