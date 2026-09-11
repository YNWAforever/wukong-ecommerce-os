/**
 * Keeping the env manifest honest about the code it describes.
 *
 * A hand-written list of required variables rots the moment someone adds a
 * `process.env.X` and forgets it -- and a rotted list is worse than none,
 * because the operator reads it as complete. So these cases derive the truth
 * from the source rather than restating the list, and fail when the two
 * disagree.
 *
 * This is the check that would have caught `DATABASE_MIGRATION_URL`: a name
 * read in one file, spelled differently from the `DATABASE_ADMIN_URL` used
 * everywhere else, documented nowhere, and handed to a `migrate()` the web app
 * never calls.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  documentedEnvNames,
  FORBIDDEN_ON_VERCEL,
  knownNames,
  PLATFORM_PROVIDED,
  undocumentedNames,
  WEB_RUNTIME_ENV,
  WORKER_RUNTIME_ENV,
} from "../scripts/runtime-env-manifest.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const envExample = readFileSync(path.join(repoRoot, ".env.example"), "utf8");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs"]);

/** Every source file under `dir`, skipping tests, builds and dependencies. */
function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", "dist", ".wrangler"].includes(entry))
      continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry))) continue;
    // Tests stub whatever they like; only shipped code constrains the manifest.
    if (/\.(test|spec)\.[^.]+$/.test(entry)) continue;
    found.push(full);
  }
  return found;
}

/**
 * Source with its comments removed.
 *
 * A scanner that cannot tell code from prose reports every doc comment that
 * mentions a variable as a read, and the first thing anyone does about a
 * confusing failure is delete the test. The `(?<!:)` guard keeps `https://`
 * from being mistaken for a line comment; the residual risk is a missed read on
 * a line where a URL precedes one, which is a false negative -- the safe
 * direction for a list whose job is to fail closed.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

/** Names read through `process.env.X` in the actual code of one tree. */
function namesReadUnder(relativeDir) {
  const names = new Set();
  for (const file of sourceFiles(path.join(repoRoot, relativeDir))) {
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

test("every variable apps/web reads at runtime is in the manifest", () => {
  const known = knownNames(WEB_RUNTIME_ENV);
  const unlisted = [...namesReadUnder("apps/web")].filter(
    (name) => !known.has(name),
  );

  assert.deepEqual(
    unlisted,
    [],
    `apps/web reads these without declaring them: ${unlisted.join(", ")}`,
  );
});

test("apps/web reads nothing the runbook forbids on Vercel", () => {
  // The rule is stated in production-ai-runtime.md. Stating it is not enforcing
  // it: DATABASE_MIGRATION_URL was read under a name the prose did not mention.
  const read = namesReadUnder("apps/web");
  const violations = FORBIDDEN_ON_VERCEL.filter((name) => read.has(name));

  assert.deepEqual(
    violations,
    [],
    `apps/web must not read: ${violations.join(", ")}`,
  );
});

test("every variable apps/worker reads at runtime is accounted for", () => {
  // The Worker takes most configuration through its `env` binding rather than
  // `process.env`, so this covers the build-time and script-side reads -- which
  // is exactly where the renderer's hard requirements live.
  const known = knownNames(WORKER_RUNTIME_ENV);
  const unlisted = [...namesReadUnder("apps/worker")].filter(
    (name) => !known.has(name),
  );

  assert.deepEqual(
    unlisted,
    [],
    `apps/worker reads these without declaring them: ${unlisted.join(", ")}`,
  );
});

test(".env.example documents every name an operator has to set", () => {
  assert.deepEqual(undocumentedNames(WEB_RUNTIME_ENV, envExample), []);
  assert.deepEqual(undocumentedNames(WORKER_RUNTIME_ENV, envExample), []);
});

test("a denied name in .env.example is there for the Worker, not for Vercel", () => {
  // The provider keys and DATABASE_ADMIN_URL are legitimately in the file: the
  // Worker needs the keys as secrets, and migrations need the admin URL from a
  // controlled release environment. What must stay true is that every denied
  // name present is one of those, so the list cannot grow silently.
  const documented = new Set(documentedEnvNames(envExample));

  assert.deepEqual(
    FORBIDDEN_ON_VERCEL.filter((name) => documented.has(name)),
    [
      "DATABASE_ADMIN_URL",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "PHOTOROOM_API_KEY",
    ],
  );
});

test("platform-provided names are never presented as something to set", () => {
  const documented = new Set(documentedEnvNames(envExample));
  const offered = PLATFORM_PROVIDED.filter((name) => documented.has(name));

  assert.deepEqual(offered, []);
});

test("no name is both required and optional", () => {
  for (const manifest of [WEB_RUNTIME_ENV, WORKER_RUNTIME_ENV]) {
    const required = new Set(manifest.required);
    const both = manifest.optional.filter((name) => required.has(name));
    assert.deepEqual(both, []);
  }
});

test("the manifest is sorted, so a diff shows what actually changed", () => {
  for (const manifest of [WEB_RUNTIME_ENV, WORKER_RUNTIME_ENV]) {
    for (const list of [manifest.required, manifest.optional]) {
      assert.deepEqual(list, [...list].sort());
    }
  }
});
