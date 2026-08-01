# Runtime Doctor Cloudflare Read Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm runtime:doctor production` reports the true state of the four queues and the Hyperdrive config instead of `unknown — could not read`, and a first-ever `deploy:production` is no longer blocked by its own secret preflight.

**Architecture:** One new pure function, `parseWranglerTable`, reads wrangler's box-drawing table by keying off its header row. `checkQueues` and `checkHyperdrive` consume raw stdout instead of JSON. `secretsCheck` gains the `--name` argument it was missing and a branch for a Worker that does not exist. `verify-cloudflare-secrets.mjs` distinguishes "no Worker yet" from "Worker exists, secrets missing".

**Tech Stack:** Node 24 ESM (`.mjs`), `node --test`, Wrangler CLI 4.112.0.

**Spec:** `docs/superpowers/specs/2026-08-01-doctor-cloudflare-read-path-design.md`

---

## File structure

| File                                    | Responsibility               | Change                                     |
| --------------------------------------- | ---------------------------- | ------------------------------------------ |
| `scripts/runtime-doctor.mjs`            | Checks, parsing, report      | Add `parseWranglerTable`; rewrite 3 checks |
| `tests/runtime-doctor.test.mjs`         | Pure-function tests          | Add table fixtures and cases               |
| `scripts/verify-cloudflare-secrets.mjs` | Deploy-time secret preflight | Allow a first deploy                       |
| `tests/cloudflare-config.test.mjs`      | Config/preflight assertions  | Add preflight decision tests               |

## The fixtures

Both fixtures below are the **real** shape emitted by wrangler 4.112.0 on
2026-08-01, captured from this project's Cloudflare account. The box-drawing
characters, column order and spacing are exactly as observed.

The resource ids have been replaced with same-length placeholders. The structure
is what the parser must handle; the account's real resource identifiers do not
belong in a committed fixture, per the repository's rule that values are never
committed.

Use these verbatim in Task 1. Do not reformat them — the whitespace is the input.

---

### Task 1: `parseWranglerTable`

**Files:**

- Modify: `scripts/runtime-doctor.mjs`
- Test: `tests/runtime-doctor.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add `parseWranglerTable` to the existing import from `../scripts/runtime-doctor.mjs`, then append:

```js
// Captured from `wrangler queues list` (wrangler 4.112.0) on 2026-08-01, not
// written from documentation. The previous fixtures were inferred, and agreed
// with equally inferred code, which is how two broken checks passed their tests.
// Resource ids are placeholders; the structure is what matters here.
const QUEUES_TABLE = [
  " ⛅️ wrangler 4.112.0 (update available 4.118.0)",
  "───────────────────────────────────────────────",
  "┌──────────────────────────────────┬────────────────────────────────┬───────────┐",
  "│ id                               │ name                           │ producers │",
  "├──────────────────────────────────┼────────────────────────────────┼───────────┤",
  "│ 00000000000000000000000000000001 │ wukong-listing-production      │ 0         │",
  "├──────────────────────────────────┼────────────────────────────────┼───────────┤",
  "│ 00000000000000000000000000000002 │ wukong-listing-dlq-production  │ 0         │",
  "└──────────────────────────────────┴────────────────────────────────┴───────────┘",
].join("\n");

const EMPTY_TABLE = [
  "┌──────────────────────────────────┬────────────────────────────────┐",
  "│ id                               │ name                           │",
  "└──────────────────────────────────┴────────────────────────────────┘",
].join("\n");

test("parseWranglerTable reads rows keyed by the header row", () => {
  const table = parseWranglerTable(QUEUES_TABLE);

  assert.deepEqual(table.columns, ["id", "name", "producers"]);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].name, "wukong-listing-production");
  assert.equal(table.rows[1].name, "wukong-listing-dlq-production");
  assert.equal(table.rows[0].id, "00000000000000000000000000000001");
});

test("parseWranglerTable returns an empty row list for a header-only table", () => {
  const table = parseWranglerTable(EMPTY_TABLE);

  assert.deepEqual(table.columns, ["id", "name"]);
  assert.deepEqual(table.rows, []);
});

test("parseWranglerTable strips ANSI escapes", () => {
  const coloured = QUEUES_TABLE.replace(
    "wukong-listing-production",
    "[32mwukong-listing-production[0m",
  );

  assert.equal(
    parseWranglerTable(coloured).rows[0].name,
    "wukong-listing-production",
  );
});

test("parseWranglerTable returns null when there is no table", () => {
  assert.equal(parseWranglerTable("✘ [ERROR] Unknown argument: json"), null);
  assert.equal(parseWranglerTable(""), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: FAIL — `parseWranglerTable` is not exported.

- [ ] **Step 3: Implement it**

Add to `scripts/runtime-doctor.mjs`, near the other pure helpers:

```js
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

/**
 * wrangler renders `queues list` and `hyperdrive list` as a box-drawing table
 * and offers no machine-readable output — the only flag either accepts is
 * --page. Rows are keyed by the header row rather than by column position, so
 * an added or reordered column does not change the result, and a header without
 * the column a caller needs is detectable instead of silently empty.
 *
 * Returns null when the input contains no table at all.
 */
export function parseWranglerTable(text) {
  const cells = (line) =>
    line
      .split("│")
      .slice(1, -1)
      .map((cell) => cell.trim());

  const lines = String(text ?? "")
    .replace(ANSI, "")
    .split(/\r?\n/)
    .filter((line) => line.includes("│"));
  if (lines.length === 0) return null;

  const [header, ...rest] = lines;
  const columns = cells(header);
  if (columns.length === 0) return null;

  const rows = rest
    .map(cells)
    .filter((row) => row.length === columns.length)
    .map((row) =>
      Object.fromEntries(columns.map((column, index) => [column, row[index]])),
    );
  return { columns, rows };
}
```

Note the filter on `│`: it discards the border and separator lines, which use `┌ ├ └ ─ ┬ ┼ ┴` and contain no `│`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/runtime-doctor.mjs tests/runtime-doctor.test.mjs
git commit -m "feat: read wrangler's table output by its header row"
```

---

### Task 2: `checkQueues` on real output

**Files:**

- Modify: `scripts/runtime-doctor.mjs`
- Test: `tests/runtime-doctor.test.mjs`

- [ ] **Step 1: Replace the existing checkQueues tests**

Delete the three existing tests named `checkQueues names every missing queue`,
`checkQueues passes when every expected queue exists`, and
`checkQueues reports unparsable output as unknown, not failed` — they assert the
JSON contract that never existed. Replace them with:

```js
test("checkQueues passes when every expected queue is in the table", () => {
  const check = checkQueues(
    ["wukong-listing-production", "wukong-listing-dlq-production"],
    QUEUES_TABLE,
    "production",
  );

  assert.equal(check.status, "ok");
});

test("checkQueues names a queue that is genuinely absent", () => {
  const check = checkQueues(
    ["wukong-listing-production", "wukong-shopline-production"],
    QUEUES_TABLE,
    "production",
  );

  assert.equal(check.status, "failed");
  assert.match(check.detail, /wukong-shopline-production/);
  assert.match(check.fix, /runtime:provision production/);
});

// An empty but well-formed table means the queues really are missing. Reporting
// that as `unknown` would make the check useless in the one case it exists for.
test("checkQueues treats a header-only table as genuinely missing", () => {
  const check = checkQueues(
    ["wukong-listing-production"],
    EMPTY_TABLE,
    "production",
  );

  assert.equal(check.status, "failed");
});

test("checkQueues reports unreadable output as unknown, not failed", () => {
  const check = checkQueues(["a"], "✘ [ERROR] Unknown argument", "production");

  assert.equal(check.status, "unknown");
  assert.match(check.detail, /could not read/i);
});

test("checkQueues reports a table without a name column as a format change", () => {
  const noName = [
    "┌──────────────────────────────────┐",
    "│ id                               │",
    "│ 00000000000000000000000000000001 │",
    "└──────────────────────────────────┘",
  ].join("\n");

  const check = checkQueues(["a"], noName, "production");

  assert.equal(check.status, "unknown");
  assert.match(check.detail, /format/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: FAIL — the current implementation calls `JSON.parse` and returns `unknown` for table input.

- [ ] **Step 3: Rewrite the check**

Replace `checkQueues` in `scripts/runtime-doctor.mjs` with:

```js
export function checkQueues(expected, listOutput, environment) {
  const table = parseWranglerTable(listOutput);
  if (!table) {
    return {
      id: "queues",
      status: "unknown",
      detail: "could not read `wrangler queues list`",
      fix: "pnpm --filter @wukong/worker exec wrangler queues list",
    };
  }
  if (!table.columns.includes("name")) {
    return {
      id: "queues",
      status: "unknown",
      detail: "wrangler queues list output format changed: no `name` column",
      fix: "pnpm --filter @wukong/worker exec wrangler queues list",
    };
  }

  const present = table.rows.map((row) => row.name);
  const missing = expected.filter((name) => !present.includes(name));
  if (missing.length === 0) {
    return {
      id: "queues",
      status: "ok",
      detail: `${expected.length} queues present`,
    };
  }
  return {
    id: "queues",
    status: "failed",
    detail: `missing ${missing.join(", ")}`,
    fix: `pnpm runtime:provision ${environment}`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/runtime-doctor.mjs tests/runtime-doctor.test.mjs
git commit -m "fix: check queues against wrangler's real output"
```

---

### Task 3: `checkHyperdrive` on real output

**Files:**

- Modify: `scripts/runtime-doctor.mjs`
- Test: `tests/runtime-doctor.test.mjs`

- [ ] **Step 1: Replace the existing checkHyperdrive test**

Delete the test named `checkHyperdrive matches the configured id` and replace it with:

```js
const HYPERDRIVE_TABLE = [
  "📋 Listing Hyperdrive configs",
  "┌──────────────────────────────────┬────────────────────────┬──────┐",
  "│ id                               │ name                   │ port │",
  "├──────────────────────────────────┼────────────────────────┼──────┤",
  "│ 000000000000000000000000000000aa │ wukong-neon-production │ 5432 │",
  "└──────────────────────────────────┴────────────────────────┴──────┘",
].join("\n");

test("checkHyperdrive passes when the configured id is listed", () => {
  const check = checkHyperdrive(
    HYPERDRIVE_TABLE,
    "000000000000000000000000000000aa",
  );

  assert.equal(check.status, "ok");
});

test("checkHyperdrive fails when the configured id is not listed", () => {
  const check = checkHyperdrive(HYPERDRIVE_TABLE, "definitely-not-there");

  assert.equal(check.status, "failed");
  assert.match(check.detail, /no Hyperdrive config/i);
});

test("checkHyperdrive fails when no id is configured at all", () => {
  const check = checkHyperdrive(HYPERDRIVE_TABLE, "");

  assert.equal(check.status, "failed");
  assert.match(check.detail, /CLOUDFLARE_HYPERDRIVE_ID/);
});

test("checkHyperdrive reports unreadable output as unknown", () => {
  assert.equal(
    checkHyperdrive("✘ [ERROR] Unknown argument", "abc").status,
    "unknown",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: FAIL — the current implementation JSON-parses its input.

- [ ] **Step 3: Rewrite the check**

Replace `checkHyperdrive` with:

```js
export function checkHyperdrive(listOutput, configuredId) {
  const table = parseWranglerTable(listOutput);
  if (!table || !table.columns.includes("id")) {
    return {
      id: "hyperdrive",
      status: "unknown",
      detail: "could not read `wrangler hyperdrive list`",
      fix: "pnpm --filter @wukong/worker exec wrangler hyperdrive list",
    };
  }
  if (!configuredId) {
    return {
      id: "hyperdrive",
      status: "failed",
      detail: "CLOUDFLARE_HYPERDRIVE_ID is unset",
      fix: "pnpm --filter @wukong/worker exec wrangler hyperdrive list",
    };
  }
  if (!table.rows.some((row) => row.id === configuredId)) {
    return {
      id: "hyperdrive",
      status: "failed",
      detail: "no Hyperdrive config matches CLOUDFLARE_HYPERDRIVE_ID",
      fix: "pnpm --filter @wukong/worker exec wrangler hyperdrive list",
    };
  }
  return { id: "hyperdrive", status: "ok", detail: "configured id exists" };
}
```

Order matters: the parse check comes first, so unreadable output is `unknown` even
when `configuredId` is also empty.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/runtime-doctor.mjs tests/runtime-doctor.test.mjs
git commit -m "fix: check hyperdrive against wrangler's real output"
```

---

### Task 4: Name the missing Worker

`secretsCheck` currently runs `wrangler secret list` with **no `--name`**, so it
targets whatever the generated config names rather than the environment's Worker.
That is why it reports `unknown` even when wrangler is working. Fix both that and
the missing-Worker message.

**Files:**

- Modify: `scripts/runtime-doctor.mjs`
- Test: `tests/runtime-doctor.test.mjs`

- [ ] **Step 1: Write the failing test**

Add `classifySecretList` to the import, then append:

```js
test("classifySecretList names a Worker that does not exist", () => {
  const check = classifySecretList(
    {
      status: 1,
      stdout: "",
      stderr: 'Worker "wukong-runtime-production" not found.',
    },
    ["QUEUE_INGRESS_SECRET"],
    "wukong-runtime-production",
  );

  assert.equal(check.status, "failed");
  assert.match(check.detail, /wukong-runtime-production/);
  assert.match(check.detail, /does not exist/i);
  assert.match(check.fix, /deploy/i);
});

test("classifySecretList reports missing secret names", () => {
  const check = classifySecretList(
    {
      status: 0,
      stdout: JSON.stringify([{ name: "OPENAI_API_KEY" }]),
      stderr: "",
    },
    ["OPENAI_API_KEY", "QUEUE_INGRESS_SECRET"],
    "wukong-runtime-production",
  );

  assert.equal(check.status, "failed");
  assert.match(check.detail, /QUEUE_INGRESS_SECRET/);
});

test("classifySecretList passes when every required name is set", () => {
  const check = classifySecretList(
    {
      status: 0,
      stdout: JSON.stringify([
        { name: "OPENAI_API_KEY" },
        { name: "QUEUE_INGRESS_SECRET" },
      ]),
      stderr: "",
    },
    ["OPENAI_API_KEY", "QUEUE_INGRESS_SECRET"],
    "wukong-runtime-production",
  );

  assert.equal(check.status, "ok");
});

test("classifySecretList reports an unreadable list as unknown", () => {
  const check = classifySecretList(
    { status: 1, stdout: "", stderr: "network unreachable" },
    ["OPENAI_API_KEY"],
    "wukong-runtime-production",
  );

  assert.equal(check.status, "unknown");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: FAIL — `classifySecretList` is not exported.

- [ ] **Step 3: Implement it**

Add to `scripts/runtime-doctor.mjs`:

```js
/** A Worker that does not exist is a different, more fundamental problem than
 *  unset secrets, and needs a different fix. */
export function classifySecretList(result, required, worker) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (/Worker .*not found/i.test(output)) {
    return {
      id: "worker-secrets",
      status: "failed",
      detail: `Worker ${worker} does not exist yet`,
      fix: "pnpm --filter @wukong/worker deploy:production  # creates the Worker, then set secrets",
      dependsOn: "wrangler-auth",
    };
  }

  let configured;
  try {
    configured = JSON.parse(result.stdout).map((entry) => entry.name);
  } catch {
    return {
      id: "worker-secrets",
      status: "unknown",
      detail: "could not list worker secrets",
      fix: `pnpm --filter @wukong/worker exec wrangler secret list --name ${worker}`,
      dependsOn: "wrangler-auth",
    };
  }

  const missing = required.filter((name) => !configured.includes(name));
  return missing.length
    ? {
        id: "worker-secrets",
        status: "failed",
        detail: `missing ${missing.join(", ")}`,
        fix: `pnpm --filter @wukong/worker exec wrangler secret put ${missing[0]} --name ${worker}`,
        dependsOn: "wrangler-auth",
      }
    : {
        id: "worker-secrets",
        status: "ok",
        detail: `${required.length} secrets set`,
        dependsOn: "wrangler-auth",
      };
}
```

Then replace the body of `secretsCheck` so it supplies the arguments — note the
`--name` and `--format json` that were missing:

```js
function secretsCheck(config, environment) {
  const worker = config.environments[environment].worker;
  const result = wrangler([
    "secret",
    "list",
    "--name",
    worker,
    "--format",
    "json",
  ]);
  return classifySecretList(result, config.requiredSecrets ?? [], worker);
}
```

- [ ] **Step 4: Update the call site**

In `main()`, `secretsCheck(config)` becomes `secretsCheck(config, environment)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/runtime-doctor.mjs tests/runtime-doctor.test.mjs
git commit -m "fix: name the missing worker instead of guessing"
```

---

### Task 5: Drop the dead `--json` flags

**Files:**

- Modify: `scripts/runtime-doctor.mjs`

- [ ] **Step 1: Remove the flags from main()**

In `main()`, the two list invocations currently pass `--json`, which wrangler
rejects outright. Change them to:

```js
    checkQueues(
      expectedQueueNames(config, environment),
      wrangler(["queues", "list"]).stdout,
      environment,
    ),
    checkHyperdrive(
      wrangler(["hyperdrive", "list"]).stdout,
      process.env.CLOUDFLARE_HYPERDRIVE_ID ?? "",
    ),
```

- [ ] **Step 2: Run the doctor against the real account**

Run: `pnpm runtime:doctor production`
Expected: `queues` reports `OK` (all four exist) and `hyperdrive` reports either
`OK` or `CLOUDFLARE_HYPERDRIVE_ID is unset` depending on whether the variable is
exported. Neither may say "could not read". `worker-secrets` must now say the
Worker does not exist yet, not `unknown`.

Paste the output into the commit message body if anything surprises you.

- [ ] **Step 3: Commit**

```bash
git add scripts/runtime-doctor.mjs
git commit -m "fix: stop passing a flag wrangler rejects"
```

---

### Task 6: Let a first deploy through the preflight

**Files:**

- Modify: `scripts/verify-cloudflare-secrets.mjs`
- Test: `tests/cloudflare-config.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `tests/cloudflare-config.test.mjs`, importing `classifyPreflight` from
`../scripts/verify-cloudflare-secrets.mjs`:

```js
test("preflight allows a first deploy when the Worker does not exist", () => {
  const decision = classifyPreflight({
    status: 1,
    stdout: "",
    stderr: 'Worker "wukong-runtime-production" not found.',
  });

  assert.equal(decision.allow, true);
  assert.match(decision.warning, /does not exist/i);
});

test("preflight reaches the name comparison when the Worker exists", () => {
  const decision = classifyPreflight({
    status: 0,
    stdout: JSON.stringify([{ name: "OPENAI_API_KEY" }]),
    stderr: "",
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.warning, undefined);
});

test("preflight aborts when wrangler fails for any other reason", () => {
  const decision = classifyPreflight({
    status: 1,
    stdout: "",
    stderr: "network unreachable",
  });

  assert.equal(decision.allow, false);
});
```

The second test asserts `allow: true` deliberately: `classifyPreflight` decides
only whether to _reach_ the name comparison. `verifyExactSecretNames` still does
the aborting on missing names, and its existing tests already cover that.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/cloudflare-config.test.mjs`
Expected: FAIL — `classifyPreflight` is not exported.

- [ ] **Step 3: Implement it**

Add to `scripts/verify-cloudflare-secrets.mjs`:

```js
/**
 * A Worker that does not exist yet cannot hold secrets, and `wrangler deploy` is
 * about to create it — so blocking here makes a first deploy impossible. Any
 * other failure still aborts.
 */
export function classifyPreflight(result) {
  if (result.status === 0) return { allow: true };
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (/Worker .*not found/i.test(output)) {
    return {
      allow: true,
      warning:
        "Worker does not exist yet; deploying to create it. Set the required secrets and redeploy before this environment is usable.",
    };
  }
  return { allow: false };
}
```

- [ ] **Step 4: Use it in main()**

Replace the `if (result.status !== 0) throw ...` block with:

```js
const decision = classifyPreflight(result);
if (!decision.allow) {
  throw new Error("Wrangler secret list failed; deployment aborted");
}
if (decision.warning) {
  process.stderr.write(`${decision.warning}\n`);
  return;
}
```

The `return` matters: with no Worker there are no secret names to compare, so
`verifyExactSecretNames` must not run on an empty list.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/cloudflare-config.test.mjs tests/runtime-doctor.test.mjs tests/ci-workflow.test.mjs`
Expected: PASS, with no edits to the pre-existing assertions.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-cloudflare-secrets.mjs tests/cloudflare-config.test.mjs
git commit -m "fix: let a first deploy create the worker it needs"
```

---

### Task 7: Update the runbook and open the PR

**Files:**

- Modify: `docs/runbooks/production-bring-up.md`

- [ ] **Step 1: Correct the known-defects section**

Replace the whole `## Known defects in the doctor` section with:

```markdown
## How the doctor reads Cloudflare state

`wrangler queues list` and `wrangler hyperdrive list` have no machine-readable
output — the only flag either accepts is `--page` — so the doctor parses their
box-drawing table, keyed off the header row.

That means the checks are parsing presentation output, and wrangler may change it.
A change surfaces as `unknown — output format changed`, never as a false answer.
If it recurs often, the fallback is the Cloudflare REST API, which costs a
`CLOUDFLARE_API_TOKEN` this repository deliberately does not currently need.
```

Then replace the `## Blocking issue: the deploy pipeline cannot perform a first deploy`
heading and its numbered workaround with:

```markdown
## First deploy of an environment

`deploy:production` now handles a Worker that does not exist: the secret preflight
warns and lets the deploy through, because `wrangler deploy` is about to create it.

The order still matters, because a Worker deployed without secrets fails at
runtime until they are set:

1. `pnpm --filter @wukong/worker deploy:production` — creates the Worker
2. Set the five secrets (commands in `docs/runbooks/production-ai-runtime.md`,
   with `--name wukong-runtime-production`)
3. `pnpm --filter @wukong/worker deploy:production` again — this time the
   preflight verifies the secrets properly
```

Leave the `SHOPLINE_TOKEN_ENCRYPTION_KEY` note, the render-inputs block, the
Vercel section, Verifying, Rollback and Escalation exactly as they are.

- [ ] **Step 2: Gates**

Run: `pnpm test` — expected 14/14 tasks. Postgres must be running; see the runbook.
Run: `pnpm typecheck` — expected 14/14.
Run: `node scripts/check-runtime-format.mjs` — expected `hash-pinned format debt waived: 0`.
Run: `npx prettier --write` on every file touched in this plan.

- [ ] **Step 3: Commit and open the PR**

```bash
git add docs/runbooks/production-bring-up.md
git commit -m "docs: the doctor now reads wrangler's real output"
git push -u origin HEAD
gh pr create --repo YNWAforever/wukong-ecommerce-os --base main --head codex/doctor-cloudflare-read-path --fill
```

---

## What "done" means

`pnpm runtime:doctor production` reports `queues` as `ok`, `hyperdrive` as `ok` or
a specific missing-id message, and names the absent Worker — none of them saying
"could not read". The preflight's decision logic is unit-tested in both directions.

Proving an actual first deploy succeeds is operator work and belongs to the
production bring-up phase, not this one.
