import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  createBoundedDiagnosticLog,
  createSanitizedLineWriter,
} from "./e2e/real-stack-server.mjs";

function temporaryDirectory(t) {
  const parent = resolve(tmpdir());
  const directory = mkdtempSync(join(parent, "wukong-shot-logs-"));
  t.after(() => {
    const target = resolve(directory);
    assert.equal(dirname(target), parent);
    assert.ok(basename(target).startsWith("wukong-shot-logs-"));
    rmSync(target, { recursive: true, force: true });
  });
  return directory;
}

test("retained queue diagnostics redact secrets, headers and signed URLs across chunks", (t) => {
  const directory = temporaryDirectory(t);
  const retain = createBoundedDiagnosticLog(directory, "wrangler");
  const secret = "fixture-sensitive-binding-abcdefgh";
  const writer = createSanitizedLineWriter({
    label: "wrangler",
    sink: { write() {} },
    sensitiveValues: [secret],
    onSanitizedOutput: retain,
  });
  writer.write('env.QUEUE_INGRESS_SECRET ("fixture-sensitive-');
  writer.write('binding-abcdefgh")\n');
  writer.write("Cookie: session_token=ephemeral-session-value\n");
  writer.write(
    "download https://storage.example/object?X-Amz-Signature=private-signed-value\n",
  );
  writer.write(
    '{"event":"queue_ingress_failure","stage":"transport","code":"http_rejected","httpStatus":503,"category":"server_error"}\n',
  );
  writer.flush();
  const output = readFileSync(join(directory, "wrangler.log"), "utf8");
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes("ephemeral-session-value"));
  assert.ok(!output.includes("private-signed-value"));
  assert.ok(!output.includes("https://storage.example"));
  const diagnostic = JSON.parse(
    output.split("\n").find((line) => line.includes('"queue_ingress_failure"')),
  );
  assert.equal(diagnostic.httpStatus, 503);
  assert.equal(diagnostic.category, "server_error");
});

test("retained CI diagnostics have a hard byte cap and reject escaping labels", (t) => {
  const directory = temporaryDirectory(t);
  const retain = createBoundedDiagnosticLog(directory, "web", 128);
  retain("x".repeat(1024));
  retain("discarded after cap");
  const output = readFileSync(join(directory, "web.log"));
  assert.ok(output.length <= 128);
  assert.ok(output.toString("utf8").includes("[diagnostic log truncated]"));
  assert.ok(!output.toString("utf8").includes("discarded"));
  assert.throws(
    () => createBoundedDiagnosticLog(directory, "../escape"),
    /invalid_diagnostic_log_options/,
  );
});
