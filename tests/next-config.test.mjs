import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("Next pins Turbopack to the Wukong monorepo root", async () => {
  const configUrl = pathToFileURL(
    path.join(process.cwd(), "apps", "web", "next.config.mjs"),
  );
  const { default: config } = await import(configUrl.href);

  assert.equal(config.turbopack?.root, process.cwd());
  assert.equal(config.outputFileTracingRoot, process.cwd());
});
