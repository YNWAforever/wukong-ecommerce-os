import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const workflow = readFileSync(
  new URL(".github/workflows/ci.yml", new URL("../", import.meta.url)),
  "utf8",
);

test("installs pnpm before setup-node enables the pnpm cache", () => {
  const pnpmSetup = workflow.indexOf("uses: pnpm/action-setup@v6");
  const nodeSetup = workflow.indexOf("uses: actions/setup-node@v6");

  assert.notEqual(pnpmSetup, -1, "the workflow must install pnpm explicitly");
  assert.notEqual(nodeSetup, -1, "the workflow must use the Node 24 setup action");
  assert.ok(
    pnpmSetup < nodeSetup,
    `pnpm setup must run before setup-node caching in ${repositoryRoot}`,
  );
});
