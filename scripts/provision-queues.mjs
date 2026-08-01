import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { expectedQueueNames } from "./runtime-doctor.mjs";

/** Creates only what the config declares, and never deletes. */
export function planQueueCreation(expected, listJson) {
  let present = [];
  try {
    const parsed = JSON.parse(listJson);
    present = Array.isArray(parsed)
      ? parsed.map((entry) => entry?.queue_name).filter(Boolean)
      : [];
  } catch {
    present = [];
  }
  return {
    create: expected.filter((name) => !present.includes(name)),
    existing: expected.filter((name) => present.includes(name)),
  };
}

function wrangler(args) {
  return spawnSync("wrangler", args, { encoding: "utf8" });
}

function main() {
  const environment = process.argv[2]?.trim();
  if (!environment) throw new Error("usage: runtime:provision <environment>");
  const config = JSON.parse(
    readFileSync(
      new URL("../cloudflare-runtime.config.json", import.meta.url),
      "utf8",
    ),
  );
  const expected = expectedQueueNames(config, environment);
  const listed = wrangler(["queues", "list", "--json"]);
  const plan = planQueueCreation(expected, listed.stdout ?? "");

  for (const name of plan.existing) console.log(`exists  ${name}`);
  for (const name of plan.create) {
    const created = wrangler(["queues", "create", name]);
    if (created.status !== 0 && !/already exists/i.test(created.stderr ?? "")) {
      console.error(`failed  ${name}: ${(created.stderr ?? "").trim()}`);
      process.exitCode = 1;
      return;
    }
    console.log(`created ${name}`);
  }
}

if (process.argv[1]?.endsWith("provision-queues.mjs")) main();
