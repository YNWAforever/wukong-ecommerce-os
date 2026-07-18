import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const workflow = readFileSync(
  new URL(".github/workflows/ci.yml", new URL("../", import.meta.url)),
  "utf8",
);
const turbo = JSON.parse(
  readFileSync(new URL("turbo.json", new URL("../", import.meta.url)), "utf8"),
);
const workerPackage = JSON.parse(
  readFileSync(
    new URL("apps/worker/package.json", new URL("../", import.meta.url)),
    "utf8",
  ),
);
const databasePackage = JSON.parse(
  readFileSync(
    new URL("packages/db/package.json", new URL("../", import.meta.url)),
    "utf8",
  ),
);

test("installs pnpm before setup-node enables the pnpm cache", () => {
  const pnpmSetup = workflow.indexOf("uses: pnpm/action-setup@v6");
  const nodeSetup = workflow.indexOf("uses: actions/setup-node@v6");

  assert.notEqual(pnpmSetup, -1, "the workflow must install pnpm explicitly");
  assert.notEqual(
    nodeSetup,
    -1,
    "the workflow must use the Node 24 setup action",
  );
  assert.ok(
    pnpmSetup < nodeSetup,
    `pnpm setup must run before setup-node caching in ${repositoryRoot}`,
  );
});

test("builds workspace packages before running migrations", () => {
  const build = workflow.indexOf("- name: Build");
  const migrate = workflow.indexOf("- name: Apply migrations");

  assert.notEqual(build, -1, "the workflow must build workspace packages");
  assert.notEqual(migrate, -1, "the workflow must apply database migrations");
  assert.ok(
    build < migrate,
    "workspace packages must exist before migration imports run",
  );
});

test("builds dependency packages before workspace verification tasks", () => {
  for (const task of ["lint", "typecheck", "test"]) {
    assert.deepEqual(
      turbo.tasks[task].dependsOn,
      ["^build"],
      `${task} must build dependency packages before resolving dist exports`,
    );
  }
});

test("keeps service-backed suites in the integration gate", () => {
  assert.match(workerPackage.scripts.test, /--exclude .*integration\.test\.ts/);
  assert.match(
    databasePackage.scripts.test,
    /--exclude .*integration\.test\.ts/,
  );
});
