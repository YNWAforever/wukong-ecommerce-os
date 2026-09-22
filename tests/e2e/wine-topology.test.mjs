import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("wine local acceptance uses isolated opt-in topology and keeps production transports intact", async () => {
  const server = await readFile(
    new URL("./real-stack-server.mjs", import.meta.url),
    "utf8",
  );
  assert.match(server, /WUKONG_WINE_E2E/);
  assert.match(server, /wine-runtime-worker\.ts/);
  assert.match(server, /wine-provider-runner\.mjs/);
  const worker = await readFile(
    new URL("./wine-runtime-worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(worker, /x-wine-synthetic-original-url/);
  const callback = await readFile(
    new URL("./website-callback-server.ts", import.meta.url),
    "utf8",
  );
  assert.match(callback, /createWineEvidenceDocumentPost/);
});

test("wine CI runs actual acceptance and retains safe artifacts on success or failure", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /playwright test tests\/e2e\/wine-enrichment\.spec\.ts/,
  );
  assert.match(workflow, /Upload wine acceptance evidence\s+if: always\(\)/);
  assert.match(workflow, /task13b-artifacts/);
  assert.ok(
    workflow.indexOf("Prepare isolated wine acceptance database") <
      workflow.indexOf("- name: Integration tests"),
  );
  assert.match(
    workflow,
    /Integration tests[\s\S]*TEST_DATABASE_URL: postgres:\/\/wukong_app:[^\n]+\/wukong_wine_sdd/,
  );
  assert.match(
    workflow,
    /DATABASE_ADMIN_URL="\$TEST_DATABASE_ADMIN_URL" DATABASE_URL="\$TEST_DATABASE_URL" pnpm --filter @wukong\/db db:migrate/,
  );
  assert.doesNotMatch(workflow, /path: [\s\S]*wine-sdd\/certs/);
});
