import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * Server/client boundary guard (regression gate for the `/studio/outputs` 500).
 *
 * Next treats every export of a `"use client"` module as a client reference.
 * A server module may render such an export as JSX, but calling it on the server
 * throws at render time ("Attempted to call X() from the server"), which unit
 * tests that only exercise the component's own file will not catch — exactly how
 * `toOutputStatus` shipped in the client output card and crashed `/studio/outputs`
 * for any workspace with an artifact.
 *
 * This scan finds function-valued imports from client modules in server modules
 * that are used somewhere other than as a JSX element. Type-only imports are
 * ignored (erased at compile time), and client components rendered as JSX are
 * allowed.
 */

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "test-results",
]);
const SKIP_FILE = /\.test\.(?:ts|tsx|mjs)$/;
const SOURCE_FILE = /\.(?:ts|tsx)$/;
const CLIENT_DIRECTIVE = /^\s*["']use client["'];?/;

function walk(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_FILE.test(entry.name) && !SKIP_FILE.test(entry.name))
      out.push(full);
  }
  return out;
}

function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(
    /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)/g,
  ))
    names.add(match[1]);
  for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of match[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name && /^[A-Za-z0-9_]+$/.test(name)) names.add(name);
    }
  }
  return names;
}

function isClientModule(source) {
  return CLIENT_DIRECTIVE.test(source);
}

function resolveImport(fromFile, specifier, root) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  const resolved = candidates.find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  );
  if (!resolved) return null;
  return path.relative(root, resolved);
}

export function scanClientBoundary(root) {
  const files = walk(root);
  const sources = new Map(
    files.map((file) => [
      path.relative(root, file),
      fs.readFileSync(file, "utf8"),
    ]),
  );
  const clientExports = new Map();
  for (const [relative, source] of sources) {
    if (!isClientModule(source)) continue;
    clientExports.set(relative, exportedNames(source));
  }

  const findings = [];
  for (const [relative, source] of sources) {
    if (isClientModule(source)) continue;
    for (const match of source.matchAll(
      /import\s+(?:type\s+)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g,
    )) {
      const specifier = match[2];
      const target = resolveImport(path.join(root, relative), specifier, root);
      if (target === null || !clientExports.has(target)) continue;
      const clientSource = sources.get(target);
      for (const part of match[1].split(",")) {
        const clause = part.trim();
        if (!clause || /^type\s/.test(clause)) continue;
        const name = clause.split(/\s+as\s+/)[0];
        if (!name || !clientExports.get(target).has(name)) continue;
        if (
          !/export\s+(?:async\s+)?(?:function|const|class)\s+/.test(
            clientSource,
          )
        )
          continue;
        // Rendering the export as JSX is the supported server -> client boundary.
        if (new RegExp(`<${name}[\\s/>]`).test(source)) continue;
        findings.push({ serverFile: relative, clientModule: target, name });
      }
    }
  }
  return findings;
}

function writeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "client-boundary-"));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  return root;
}

test("no server module calls a function exported from a client module", () => {
  const findings = scanClientBoundary(path.resolve("apps", "web"));
  assert.deepEqual(
    findings,
    [],
    `Server code calls client-module functions (Next will throw at render):\n${JSON.stringify(findings, null, 2)}`,
  );
});

test("the scan detects a server call into a client module", () => {
  const root = writeFixture({
    "components/card.tsx": [
      '"use client";',
      "export function toStatus(value: unknown) { return value; }",
      "export function Card() { return null; }",
    ].join("\n"),
    "app/page.tsx": [
      'import { toStatus } from "../components/card";',
      "export function Page() { return String(toStatus(1)); }",
    ].join("\n"),
  });
  assert.deepEqual(scanClientBoundary(root), [
    {
      serverFile: path.join("app", "page.tsx"),
      clientModule: path.join("components", "card.tsx"),
      name: "toStatus",
    },
  ]);
});

test("the scan allows a server component to render a client component", () => {
  const root = writeFixture({
    "components/card.tsx": [
      '"use client";',
      "export function Card() { return null; }",
    ].join("\n"),
    "app/page.tsx": [
      'import { Card } from "../components/card";',
      "export function Page() { return <Card />; }",
    ].join("\n"),
  });
  assert.deepEqual(scanClientBoundary(root), []);
});
