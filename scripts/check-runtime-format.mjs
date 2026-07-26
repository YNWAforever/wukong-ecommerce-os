import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const protectedUnrelatedFiles = new Set([
  ".gitignore",
  "apps/web/.gitignore",
  "apps/web/auth.test.ts",
  "docs/superpowers/plans/2026-07-12-shopline-ai-listing-mvp.md",
]);
const knownFormatDebt = new Map([
  [
    "apps/web/app/api/assets/finalize/route.test.ts",
    "3abb816c52d65a7223313586b4ee6dd56da80abd43e5598a98ddda3b4d50845b",
  ],
  [
    "apps/web/app/api/assets/finalize/route.ts",
    "5aaa692c0b800758e6e63012d8aca47bc31b517b4924244763f3256fa1c097b2",
  ],
  [
    "apps/web/app/api/assets/presign/route.ts",
    "7adbcb02f097f202c849e229d9510f8c3a59059072aa81b55c0ad997c37388ea",
  ],
  [
    "apps/web/app/api/listings/route.create.test.ts",
    "175f467561747ea218d165278e1e57eb4023b50761f81898b3a0f4dc0461cbc0",
  ],
  [
    "apps/worker/src/listing-consumer.test.ts",
    "004dcee5a589f459004489c538632cf202a225066922996be1e35b9b00fea41f",
  ],
  [
    "apps/worker/src/pipeline-test-support.ts",
    "45d5ebc4ea37bf5ac927578e992974a8604068c147cf760d4d376cf6c080d7b1",
  ],
  [
    "packages/db/src/index.ts",
    "2307b20c6cdbccee39ac9e163da0c5357e4e8c459b3095ce575c141e98501651",
  ],
  [
    "packages/db/src/publish-jobs-schema.test.ts",
    "8c0609853aa150a6d7fd532e41f387fb152462758d35f4d860a80685f932c5d8",
  ],
  [
    "packages/db/src/repositories/publish-jobs.integration.test.ts",
    "60f109af4c944409f7cfe348c697299a3f34a83a008b1c3478581d43f6e36c7c",
  ],
  [
    "packages/db/src/schema.ts",
    "21c8b510142bf891215df98175e1a168df6016a6a325b7a3b7a45457599034ee",
  ],
  [
    "packages/jobs/src/cloudflare-queue.ts",
    "1f17ed387564268afbdf82c4354a04d7e27b0525d0d2a5dfc613c925796f1b43",
  ],
]);

export function knownFormatDebtEntries() {
  return [...knownFormatDebt.entries()];
}

export function matchesKnownFormatDebt(file, source) {
  const normalizedFile = file.replaceAll("\\", "/");
  const expected = knownFormatDebt.get(normalizedFile);
  if (!expected) return false;
  const canonicalSource = source.replaceAll("\r\n", "\n");
  const actual = createHash("sha256").update(canonicalSource).digest("hex");
  return actual === expected;
}
const forbiddenPackages = new Set([
  "@upstash/redis",
  "bullmq",
  "ioredis",
  "redis",
]);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function lines(value) {
  return value.split(/\r?\n/).filter(Boolean);
}

function checkForbiddenRuntime() {
  const failures = [];
  const packageFiles = lines(
    git([
      "ls-files",
      "package.json",
      "apps/*/package.json",
      "packages/*/package.json",
    ]),
  );

  for (const file of packageFiles) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        if (forbiddenPackages.has(dependency)) {
          failures.push(`${file}: ${section}.${dependency}`);
        }
      }
    }
  }

  const runtimeFiles = lines(git(["ls-files", "apps", "packages"])).filter(
    (file) =>
      /\.(?:[cm]?[jt]sx?)$/.test(file) &&
      !/\.test\.[cm]?[jt]sx?$/.test(file) &&
      !file.includes("/dist/"),
  );
  const forbiddenImport =
    /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:@upstash\/redis|bullmq|ioredis|redis)["']/i;
  for (const file of runtimeFiles) {
    if (forbiddenImport.test(readFileSync(file, "utf8"))) {
      failures.push(`${file}: forbidden runtime import`);
    }
  }

  for (const file of ["railway.json", "tests/railway-config.test.mjs"]) {
    if (existsSync(file)) failures.push(`${file}: forbidden runtime file`);
  }

  const compose = readFileSync("docker-compose.yml", "utf8");
  if (/^\s+redis:\s*$/im.test(compose) || /\bREDIS_URL\b/.test(compose)) {
    failures.push("docker-compose.yml: Redis service or variable");
  }

  console.log(`runtime package manifests checked: ${packageFiles.length}`);
  console.log(`runtime source files checked: ${runtimeFiles.length}`);
  if (failures.length) {
    console.error("Forbidden legacy runtime surface:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("forbidden runtime dependencies: 0");
    console.log("forbidden runtime imports: 0");
    console.log("forbidden runtime files/services: 0");
  }
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

async function checkRuntimeFormat() {
  const base = releaseBase();
  const changedFiles = lines(
    git(["diff", "--name-only", "--diff-filter=ACMR", `${base}..HEAD`]),
  ).map((file) => file.replaceAll("\\", "/"));

  const formatFiles = changedFiles.filter(
    (file) =>
      !generatedFiles.has(file) &&
      !semanticOnlyFiles.has(file) &&
      !protectedUnrelatedFiles.has(file) &&
      supportedExtensions.has(path.posix.extname(file)),
  );

  const failures = [];
  const waived = [];
  for (const file of formatFiles) {
    const source = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    if (await check(source, { filepath: file })) continue;
    if (matchesKnownFormatDebt(file, source)) waived.push(file);
    else failures.push(file);
  }

  console.log(`runtime format base: ${base}`);
  console.log(`runtime files checked: ${formatFiles.length}`);
  console.log(`hash-pinned format debt waived: ${waived.length}`);
  for (const file of waived) {
    console.log(`format debt waiver: ${file} ${knownFormatDebt.get(file)}`);
  }
  if (
    semanticOnlyFiles.has(".env.example") &&
    changedFiles.includes(".env.example")
  ) {
    console.log(
      ".env.example: semantic validation is owned by the Cloudflare configuration tests",
    );
  }

  if (failures.length) {
    console.error("Runtime files requiring Prettier:");
    for (const file of failures) console.error(`- ${file}`);
    process.exitCode = 1;
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  if (process.argv.includes("--forbidden-runtime")) {
    checkForbiddenRuntime();
  } else {
    await checkRuntimeFormat();
  }
}
