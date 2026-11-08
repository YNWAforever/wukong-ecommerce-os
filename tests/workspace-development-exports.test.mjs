import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));

// Resolve from the real consumer with Node's runtime conditions. This does not
// require dist to exist yet: the root test gate runs before Turbo builds it.
function resolveEntries(specifiers, conditions) {
  const result = spawnSync(
    process.execPath,
    [
      ...conditions,
      "--input-type=module",
      "--eval",
      `console.log(JSON.stringify(${JSON.stringify(specifiers)}.map(s => import.meta.resolve(s))))`,
    ],
    { cwd: webRoot, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}

for (const name of ["jobs", "assets", "shopline"]) {
  const manifest = JSON.parse(
    readFileSync(
      new URL(`../packages/${name}/package.json`, import.meta.url),
      "utf8",
    ),
  );
  const specifiers = Object.keys(manifest.exports).map((entry) =>
    entry === "." ? manifest.name : manifest.name + entry.slice(1),
  );

  test(`${manifest.name} resolves every development entry to the production JavaScript entry`, () => {
    const production = resolveEntries(specifiers, []);
    const development = resolveEntries(specifiers, [
      "--conditions=development",
    ]);

    for (const [index, specifier] of specifiers.entries()) {
      assert.match(production[index], /\/dist\/.*\.js$/, specifier);
      assert.equal(development[index], production[index], specifier);
    }
  });
}
