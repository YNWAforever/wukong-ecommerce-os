import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { check } from "prettier";

const supportedExtensions = new Set([
  ".css",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const generatedFiles = new Set(["pnpm-lock.yaml"]);
const semanticOnlyFiles = new Set([".env.example"]);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function commitExists(value) {
  if (!value || /^0+$/.test(value)) return false;
  try {
    git(["cat-file", "-e", `${value}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function releaseBase() {
  const requested = process.env.RELEASE_BASE_SHA?.trim();
  if (commitExists(requested)) return git(["merge-base", requested, "HEAD"]);

  try {
    return git(["merge-base", "origin/main", "HEAD"]);
  } catch {
    return git(["rev-parse", "HEAD^"]);
  }
}

const base = releaseBase();
const changedFiles = git([
  "diff",
  "--name-only",
  "--diff-filter=ACMR",
  `${base}..HEAD`,
])
  .split(/\r?\n/)
  .filter(Boolean)
  .map((file) => file.replaceAll("\\", "/"));

const formatFiles = changedFiles.filter(
  (file) =>
    !generatedFiles.has(file) &&
    !semanticOnlyFiles.has(file) &&
    supportedExtensions.has(path.posix.extname(file)),
);

const failures = [];
for (const file of formatFiles) {
  const source = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  if (!(await check(source, { filepath: file }))) failures.push(file);
}

console.log(`runtime format base: ${base}`);
console.log(`runtime files checked: ${formatFiles.length}`);
if (
  semanticOnlyFiles.has(".env.example") &&
  changedFiles.includes(".env.example")
) {
  console.log(
    ".env.example: semantic validation is owned by tests/railway-config.test.mjs",
  );
}

if (failures.length) {
  console.error("Runtime files requiring Prettier:");
  for (const file of failures) console.error(`- ${file}`);
  process.exitCode = 1;
}
