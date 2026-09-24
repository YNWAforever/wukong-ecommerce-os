/** Local-only CA and leaf, trusted only by children of the wine harness. Never upload this directory. */
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { X509Certificate } from "node:crypto";
export function prepareWineTls(root) {
  const directory = resolve(root, ".wrangler/wine-sdd/certs");
  mkdirSync(directory, { recursive: true });
  const ca = resolve(directory, "ca.crt"),
    cert = resolve(directory, "localhost.crt"),
    key = resolve(directory, "localhost.key"),
    bundle = resolve(directory, "trust.pem");
  const openssl =
    process.platform === "win32"
      ? "C:/Program Files/Git/usr/bin/openssl.exe"
      : "openssl";
  if (
    !existsSync(cert) ||
    Date.parse(new X509Certificate(readFileSync(cert)).validTo) <
      Date.now() + 86400000
  ) {
    const run = (args) =>
      execFileSync(openssl, args, {
        cwd: directory,
        windowsHide: true,
        stdio: "pipe",
      });
    run([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.crt",
      "-days",
      "7",
      "-subj",
      "/CN=Wukong Synthetic Wine Local CA",
    ]);
    run([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "localhost.key",
      "-out",
      "localhost.csr",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]);
    run([
      "x509",
      "-req",
      "-in",
      "localhost.csr",
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-set_serial",
      "13",
      "-days",
      "7",
      "-copy_extensions",
      "copy",
      "-out",
      "localhost.crt",
    ]);
  }
  writeFileSync(
    bundle,
    Buffer.concat([
      readFileSync(
        resolve(
          root,
          ".wrangler/caddy-data/caddy/pki/authorities/local/root.crt",
        ),
      ),
      Buffer.from("\n"),
      readFileSync(ca),
    ]),
  );
  return { cert, key, bundle };
}
