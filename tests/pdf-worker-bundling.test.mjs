import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
const root = fileURLToPath(new URL("../", import.meta.url));
const trace = path.join(
  root,
  "apps/web/.next/server/app/api/assets/finalize/route.js.nft.json",
);
test("compiled PDF inspection retains a real Node parser and never sends a numeric bundler ID to its worker", (t) => {
  if (!existsSync(trace)) {
    t.skip("Run the web production build first.");
    return;
  }
  const files = JSON.parse(readFileSync(trace, "utf8")).files;
  assert.ok(
    files.some((file) =>
      file.replaceAll("\\", "/").endsWith("/pdf-lib/cjs/index.js"),
    ),
    "The isolated worker needs the external pdf-lib parser in its deployment trace.",
  );
  const dir = path.join(root, "apps/web/.next/server/chunks");
  const chunks = readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(path.join(dir, file), "utf8"));
  const parserChunks = chunks.filter(
    (source) =>
      source.includes("workerData:{parserPath") ||
      source.includes("workerData: { parserPath"),
  );
  assert.ok(
    parserChunks.length > 0,
    "Expected the compiled isolated PDF worker.",
  );
  for (const source of parserChunks)
    assert.doesNotMatch(
      source,
      /workerData:\s*\{\s*parserPath:\s*\d+\b/,
      "Turbopack module IDs are not loadable paths in a separate Node worker.",
    );
});
