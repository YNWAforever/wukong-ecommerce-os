/**
 * The release gate, as far as a repository can check it.
 *
 * `docs/runbooks/production-readiness.md` is the entry condition for Opak UAT,
 * and it was twenty unchecked boxes with nothing verifying any of them. Several
 * were already true and merely unrecorded; the rest cannot be checked from here
 * at all, because they are about owners, custody, deployment identifiers and
 * merchant approval.
 *
 * Leaving those two kinds in one undifferentiated list is what made the gate
 * useless: a reader cannot tell an unchecked box nobody has looked at from one
 * that no amount of looking would settle. This splits them, proves the first
 * kind, and says plainly that the second kind needs a person.
 *
 * It deliberately proves nothing about a deployment. Every automated check
 * reads repository source. A green run means the repository is configured as
 * the runbook describes; it does not mean anything is deployed, and it is not
 * sign-off.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FORBIDDEN_ON_VERCEL,
  WEB_RUNTIME_ENV,
  WORKER_RUNTIME_ENV,
} from "./runtime-env-manifest.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function read(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

/** Every phrase must appear, and a failure names the ones that did not. */
function requireAll(source, phrases) {
  const missing = phrases.filter((phrase) => !source.includes(phrase));
  return missing.length === 0
    ? { ok: true }
    : { ok: false, detail: `missing: ${missing.join(", ")}` };
}

/**
 * Checks, keyed by the opening words of the runbook line each one settles.
 *
 * The key is a prefix of the real sentence rather than an invented identifier,
 * so a reader can match the two by eye, and rewording the runbook fails the
 * test rather than silently detaching a check from its box.
 */
export const RELEASE_GATE_CHECKS = [
  {
    key: "Neon runtime and admin roles are separate",
    kind: "automated",
    verify() {
      const askedForAnywhere = [
        ...WEB_RUNTIME_ENV.required,
        ...WEB_RUNTIME_ENV.optional,
        ...WORKER_RUNTIME_ENV.required,
        ...WORKER_RUNTIME_ENV.optional,
      ];
      if (!FORBIDDEN_ON_VERCEL.includes("DATABASE_ADMIN_URL")) {
        return { ok: false, detail: "DATABASE_ADMIN_URL is not forbidden" };
      }
      return askedForAnywhere.includes("DATABASE_ADMIN_URL")
        ? { ok: false, detail: "a runtime surface asks for DATABASE_ADMIN_URL" }
        : { ok: true };
    },
  },
  {
    key: "The exact preview and production Cloudflare Workers",
    kind: "human",
    because: "owners and provisioned resource identities live outside the repo",
  },
  {
    key: "Queue retention, DLQ replay, backlog alert",
    kind: "human",
    because: "alert ownership is a person, not a file",
  },
  {
    key: "R2 public access is disabled",
    kind: "human",
    because: "bucket policy and restore ownership are set on the provider",
  },
  {
    key: "`QUEUE_INGRESS_SECRET`, `AUTH_SECRET`",
    kind: "human",
    because: "secret custody and rotation cadence cannot be read from source",
  },
  {
    key: "Database backups, restore drill date",
    kind: "human",
    because: "a drill is an event, and approval is a decision",
  },
  {
    key: "CI pins Node 24 and pnpm 11.7",
    kind: "automated",
    verify() {
      return requireAll(read(".github/workflows/ci.yml"), [
        "node-version: 24",
        "version: 11.7.0",
        "--frozen-lockfile",
        "pnpm runtime:forbidden:check",
        "pnpm --filter @wukong/db... build",
        "pnpm --filter @wukong/db db:migrate",
        "pnpm lint",
        "pnpm typecheck",
        "pnpm test",
        "pnpm test:integration",
        "pnpm build",
        "playwright test",
      ]);
    },
  },
  {
    key: "Playwright uses production-built Next",
    kind: "automated",
    verify() {
      const config = read("playwright.config.ts");
      const builtNotDev =
        config.includes("pnpm build --filter=@wukong/web") &&
        config.includes("real-stack-server.mjs");
      if (!builtNotDev) {
        return { ok: false, detail: "the real-stack webServer is not a build" };
      }
      return requireAll(read(".github/workflows/ci.yml"), [
        "AI_PROVIDER: fake",
        "SHOPLINE_ADAPTER: mock",
      ]);
    },
  },
  {
    key: "The exact synthetic Opak draft passes",
    kind: "automated",
    verify() {
      return requireAll(read(".github/workflows/ci.yml"), [
        "audit:verify --workspace",
        "real-stack-draft-id.txt",
      ]);
    },
  },
  {
    key: "Preview and production resource IDs",
    kind: "human",
    because: "these exist only once something has been deployed",
  },
  {
    key: "Deployment-specific logs contain no credentials",
    kind: "human",
    because: "it is a claim about a running deployment, not about source",
  },
  {
    key: "No customer file, production credential",
    kind: "human",
    because:
      "an unreviewed AI claim is a judgement, and history needs a full scan",
  },
  {
    key: "Preview remains `SHOPLINE_ADAPTER=mock`",
    kind: "automated",
    verify() {
      return read("scripts/render-cloudflare-config.mjs").includes(
        'SHOPLINE_ADAPTER: environment === "preview" ? "mock" : "disabled"',
      )
        ? { ok: true }
        : { ok: false, detail: "the renderer no longer pins preview to mock" };
    },
  },
  {
    key: "Production acceptance remains",
    kind: "automated",
    verify() {
      return requireAll(read("scripts/render-cloudflare-config.mjs"), [
        '? "mock" : "disabled"',
        'SHOPLINE_PUBLISH_ENABLED: "false"',
      ]);
    },
  },
  {
    key: "The production SHOPLINE API version",
    kind: "human",
    because: "merchant approval and Developer Center ownership are external",
  },
  {
    key: "A separate final confirmation is obtained",
    kind: "human",
    because: "this is the confirmation itself, and must stay a human act",
  },
  {
    key: "The first real write is limited",
    kind: "human",
    because: "it describes an action taken against a live store",
  },
  {
    key: "Operators can disable SHOPLINE",
    kind: "human",
    because: "it is a rehearsal against real consoles",
  },
  {
    key: "Rollback retains primary Queues",
    kind: "human",
    because: "it is a property of the incident procedure people follow",
  },
  {
    key: "DLQ replay is one reviewed IDs-only message",
    kind: "human",
    because: "it constrains how an operator behaves during an incident",
  },
];

/** The runbook lines, so the two lists can be compared rather than trusted. */
export function readinessCheckboxes() {
  return read("docs/runbooks/production-readiness.md")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- [ ]"))
    .map((line) => line.slice("- [ ]".length).trim());
}

export function runAutomatedChecks() {
  return RELEASE_GATE_CHECKS.filter((check) => check.kind === "automated").map(
    (check) => ({ key: check.key, ...check.verify() }),
  );
}

function main() {
  const results = runAutomatedChecks();
  const human = RELEASE_GATE_CHECKS.filter((check) => check.kind === "human");
  const failed = results.filter((result) => !result.ok);

  console.log(
    `release gate: ${results.length} automated, ${human.length} human`,
  );
  for (const result of results) {
    console.log(`  ${result.ok ? "ok  " : "FAIL"} ${result.key}`);
    if (!result.ok) console.log(`       ${result.detail}`);
  }
  console.log("awaiting a person:");
  for (const check of human) {
    console.log(`  --  ${check.key} (${check.because})`);
  }

  // Never reported as the gate passing: the human half IS the gate.
  console.log(
    failed.length === 0
      ? "automated half: all checks pass. This is not sign-off."
      : `automated half: ${failed.length} failing`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
