# Runtime Bring-Up Doctor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm runtime:doctor <env>` names the one broken step of a production bring-up and prints its fix; `pnpm runtime:provision <env>` idempotently creates the four queues the repository already declares.

**Architecture:** Two Node scripts under `scripts/`, each built as pure exported functions plus a thin `main()` that shells out to `wrangler`/`vercel` — the structure `scripts/verify-cloudflare-secrets.mjs` already uses. Resource names come from `cloudflare-runtime.config.json`, never from the scripts. The Worker's existing `/health` route learns to accept a signed `POST`, so the doctor can prove Vercel's ingress secret matches the Worker's rather than checking each side separately.

**Tech Stack:** Node 24 ESM (`.mjs`), `node --test` for script tests, TypeScript + Vitest for the Worker and `packages/db`, Wrangler CLI, Vercel CLI.

**Spec:** `docs/superpowers/specs/2026-08-01-runtime-bring-up-doctor-design.md`

---

## Scope note

Tasks 1–8 are code. Actually running the bring-up against Cloudflare and Vercel is
operator work and appears as a checklist at the end.

## File structure

| File                                    | Responsibility                               | Change                          |
| --------------------------------------- | -------------------------------------------- | ------------------------------- |
| `packages/db/src/client.ts`             | `Database` port                              | Add `ping()`                    |
| `packages/db/src/client.test.ts`        | `Database` unit tests                        | Add `ping` test                 |
| `apps/worker/src/cloudflare-runtime.ts` | `workerHealth`                               | Add `authenticatedWorkerHealth` |
| `apps/worker/src/ingress.ts`            | Route dispatch                               | Accept signed `POST /health`    |
| `apps/worker/src/ingress.test.ts`       | Ingress tests                                | Add `POST /health` cases        |
| `scripts/runtime-doctor.mjs`            | Check model, wrangler/vercel parsing, report | New                             |
| `scripts/provision-queues.mjs`          | Idempotent queue creation                    | New                             |
| `tests/runtime-doctor.test.mjs`         | Pure-function tests for both scripts         | New                             |
| `package.json`                          | Root scripts + root test list                | Modify                          |
| `apps/worker/package.json`              | Deploy scripts gain the precondition gate    | Modify                          |

**Check ids** used across every task — reuse these exact strings:

`wrangler-auth`, `queues`, `hyperdrive`, `worker-secrets`, `health-get`, `vercel-env`, `health-signed`

**Check statuses:** `"ok"`, `"failed"`, `"blocked"`, `"unknown"`.

---

### Task 1: Give `Database` a `ping()`

The signed health probe must prove Postgres actually answers through Hyperdrive.
`Database` today is `{ migrate, forWorkspace, close }` — `forWorkspace` opens a
transaction and sets a tenant GUC, which is the wrong tool for a liveness check.

**Files:**

- Modify: `packages/db/src/client.ts:63-75` (options + type), and the object returned by `createDatabase`
- Create: `packages/db/src/client.test.ts` — this file does not exist yet

`createDatabase` today calls `postgres(url, …)` directly with no injectable seam,
so this task adds one. That matches the repo's ports-and-adapters rule: tests
inject a fake, production keeps the real driver as the default.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/client.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createDatabase } from "./client.js";
```

then add:

```ts
it("pings the database with a trivial query", async () => {
  const queries: string[] = [];
  const database = createDatabase("postgres://user:pass@localhost:5432/db", {
    createClient: ((url: string, options: unknown) => {
      const client = async (strings: TemplateStringsArray) => {
        queries.push(strings.join("?"));
        return [{ ok: 1 }];
      };
      client.end = async () => undefined;
      return client;
    }) as never,
  });

  await database.ping();

  expect(queries).toEqual(["select 1"]);
});
```

Add the seam to `DatabaseOptions` in `packages/db/src/client.ts:63`:

```ts
export type DatabaseOptions = {
  migrationUrl?: string;
  maxConnections?: number;
  /** Injected by tests; production uses the real postgres driver. */
  createClient?: typeof postgres;
};
```

and in `createDatabase`, replace the direct `postgres(...)` call with
`const client = (options.createClient ?? postgres)(url, { ... })`, leaving the
existing option object exactly as it is.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root packages/db src/client.test.ts`
Expected: FAIL — `database.ping is not a function`.

- [ ] **Step 3: Add `ping` to the type**

In `packages/db/src/client.ts`, extend the `Database` type:

```ts
export type Database = {
  migrate(): Promise<void>;
  ping(): Promise<void>;
  forWorkspace<T>(
    workspaceId: string,
    work: (repositories: WorkspaceRepositories) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
};
```

- [ ] **Step 4: Implement it**

In the object `createDatabase` returns, alongside `migrate`:

```ts
    async ping() {
      // Deliberately not forWorkspace: this proves the connection answers, and
      // must not open a tenant transaction or set a workspace GUC.
      await client`select 1`;
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --root packages/db`
Expected: PASS, including the pre-existing suites.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/client.ts packages/db/src/client.test.ts
git commit -m "feat: let a database report that it answers"
```

---

### Task 2: Authenticated worker health

**Files:**

- Modify: `apps/worker/src/cloudflare-runtime.ts:164-177`
- Test: `apps/worker/src/cloudflare-runtime.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";

import { authenticatedWorkerHealth } from "./cloudflare-runtime.js";
import type { WorkerEnv } from "./worker-env.js";

function env(): WorkerEnv {
  return {
    HYPERDRIVE: { connectionString: "postgres://x" } as never,
    LISTING_QUEUE: { send: vi.fn(async () => undefined) } as never,
    SHOPLINE_QUEUE: { send: vi.fn(async () => undefined) } as never,
    QUEUE_INGRESS_SECRET: "q".repeat(32),
    BUILD_SHA: "abc123",
    SHOPLINE_ADAPTER: "disabled",
  };
}

describe("authenticatedWorkerHealth", () => {
  it("reports a reachable database", async () => {
    const database = {
      ping: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    const health = await authenticatedWorkerHealth(env(), {
      createDatabase: () => database as never,
    });

    expect(health.authenticated).toBe(true);
    expect(health.checks.hyperdriveConnects).toBe(true);
    expect(database.close).toHaveBeenCalled();
  });

  it("reports an unreachable database without throwing", async () => {
    const database = {
      ping: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      close: vi.fn(async () => undefined),
    };

    const health = await authenticatedWorkerHealth(env(), {
      createDatabase: () => database as never,
    });

    expect(health.checks.hyperdriveConnects).toBe(false);
    expect(database.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root apps/worker src/cloudflare-runtime.test.ts`
Expected: FAIL — `authenticatedWorkerHealth` is not exported.

- [ ] **Step 3: Implement it**

Append to `apps/worker/src/cloudflare-runtime.ts`:

```ts
type HealthDeps = {
  createDatabase?: (env: WorkerEnv) => Database;
};

export async function authenticatedWorkerHealth(
  env: WorkerEnv,
  deps: HealthDeps = {},
) {
  const create = deps.createDatabase ?? createWorkerDatabase;
  let hyperdriveConnects = false;
  let database: Database | undefined;
  try {
    database = create(env);
    await database.ping();
    hyperdriveConnects = true;
  } catch {
    // A health probe reports the failure; it must never propagate it, or the
    // caller learns "the worker is down" instead of "the database is down".
    hyperdriveConnects = false;
  } finally {
    await database?.close().catch(() => undefined);
  }
  return {
    ...workerHealth(env),
    authenticated: true,
    checks: { hyperdriveConnects },
  } as const;
}
```

`Database` is already imported in this file via `createWorkerDatabase`; if only
the value is imported, add `import type { Database } from "@wukong/db";`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --root apps/worker`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/cloudflare-runtime.ts apps/worker/src/cloudflare-runtime.test.ts
git commit -m "feat: report database reachability in worker health"
```

---

### Task 3: Accept a signed `POST /health`

**Files:**

- Modify: `apps/worker/src/ingress.ts:63-68`
- Test: `apps/worker/src/ingress.test.ts`

The existing `signedRequest` helper in that test file already builds a signed
`POST`; reuse it rather than writing a second one.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("Cloudflare Worker ingress", ...)`:

```ts
it("answers a signed POST /health with authenticated detail", async () => {
  const response = await handleIngress(
    await signedRequest("/health", {}),
    env(),
    undefined,
    { nowSeconds: () => nowSeconds },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    authenticated: true,
    bindings: { ingressSecret: true },
  });
});

it("rejects an unsigned POST /health", async () => {
  const response = await handleIngress(
    new Request("https://worker.test/health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    env(),
    undefined,
    { nowSeconds: () => nowSeconds },
  );

  expect(response.status).toBe(401);
});

it("rejects a POST /health signed with the wrong secret", async () => {
  const response = await handleIngress(
    await signedRequest("/health", {}, { signature: "not-a-signature" }),
    env(),
    undefined,
    { nowSeconds: () => nowSeconds },
  );

  expect(response.status).toBe(401);
});

it("rejects a replayed POST /health outside the timestamp window", async () => {
  const response = await handleIngress(
    await signedRequest("/health", {}, { timestamp: nowSeconds - 3_600 }),
    env(),
    undefined,
    { nowSeconds: () => nowSeconds },
  );

  expect(response.status).toBe(401);
});

it("keeps the unauthenticated GET /health body unchanged", async () => {
  const response = await handleIngress(
    new Request("https://worker.test/health", { method: "GET" }),
    env(),
    undefined,
    { nowSeconds: () => nowSeconds },
  );

  expect(response.status).toBe(200);
  // Pins the unauthenticated surface: it must never grow authenticated detail.
  expect(Object.keys(await response.json()).sort()).toEqual([
    "adapterMode",
    "bindings",
    "buildSha",
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --root apps/worker src/ingress.test.ts`
Expected: FAIL — the signed POST returns 405, because `/health` currently allows
only GET.

- [ ] **Step 3: Implement the route**

In `apps/worker/src/ingress.ts`, replace the `/health` branch:

```ts
if (path === "/health") {
  if (request.method === "GET") return Response.json(workerHealth(env));
  if (request.method !== "POST") return response(405);

  const body = await readLimitedBody(request);
  if (body instanceof Response) return body;
  const secret = env.QUEUE_INGRESS_SECRET?.trim();
  const timestamp = request.headers.get("x-wukong-timestamp") ?? "";
  const signature = request.headers.get("x-wukong-signature") ?? "";
  if (!secret || !timestamp || !signature) return response(401);

  const authenticated = await verifyQueueRequest({
    secret,
    nowSeconds: (
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000))
    )(),
    timestamp,
    signature,
    path,
    body,
  });
  if (!authenticated) return response(401);
  return Response.json(await authenticatedWorkerHealth(env));
}
```

Add `authenticatedWorkerHealth` to the existing import from
`./cloudflare-runtime.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --root apps/worker`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/ingress.ts apps/worker/src/ingress.test.ts
git commit -m "feat: authenticate a signed health probe"
```

---

### Task 4: The check model

This is the part that decides whether the report is useful or noisy.

**Files:**

- Create: `scripts/runtime-doctor.mjs`
- Test: `tests/runtime-doctor.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/runtime-doctor.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveStatuses, formatReport } from "../scripts/runtime-doctor.mjs";

test("marks dependents of a failed check as blocked, not failed", () => {
  const resolved = resolveStatuses([
    {
      id: "queues",
      status: "failed",
      detail: "missing wukong-listing-production",
      fix: "pnpm runtime:provision production",
    },
    { id: "health-get", dependsOn: "queues" },
    { id: "health-signed", dependsOn: "health-get" },
  ]);

  assert.deepEqual(
    resolved.map((check) => [check.id, check.status]),
    [
      ["queues", "failed"],
      ["health-get", "blocked"],
      ["health-signed", "blocked"],
    ],
  );
});

test("blocked checks name what blocked them", () => {
  const [, blocked] = resolveStatuses([
    { id: "queues", status: "failed", detail: "missing", fix: "x" },
    { id: "health-get", dependsOn: "queues" },
  ]);

  assert.equal(blocked.detail, "blocked by queues");
});

test("an unknown check blocks dependents but is not a failure", () => {
  const resolved = resolveStatuses([
    {
      id: "wrangler-auth",
      status: "unknown",
      detail: "wrangler is not logged in",
      fix: "wrangler login",
    },
    { id: "queues", dependsOn: "wrangler-auth" },
  ]);

  assert.equal(resolved[0].status, "unknown");
  assert.equal(resolved[1].status, "blocked");
});

test("passing checks leave dependents to run", () => {
  const resolved = resolveStatuses([
    { id: "queues", status: "ok", detail: "4 queues present" },
    {
      id: "health-get",
      status: "ok",
      detail: "bindings resolved",
      dependsOn: "queues",
    },
  ]);

  assert.deepEqual(
    resolved.map((check) => check.status),
    ["ok", "ok"],
  );
});

test("the report prints a fix for every red check and never a secret value", () => {
  const report = formatReport([
    {
      id: "queues",
      status: "failed",
      detail: "missing wukong-listing-production",
      fix: "pnpm runtime:provision production",
    },
    { id: "worker-secrets", status: "ok", detail: "5 secrets set" },
  ]);

  assert.match(report, /FAIL {2}queues/);
  assert.match(report, /pnpm runtime:provision production/);
  assert.match(report, /OK {4}worker-secrets/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: FAIL — cannot find `../scripts/runtime-doctor.mjs`.

- [ ] **Step 3: Implement the model**

Create `scripts/runtime-doctor.mjs`:

```js
const STATUS_LABEL = {
  ok: "OK   ",
  failed: "FAIL ",
  blocked: "BLOCK",
  unknown: "?????",
};

/**
 * A check whose dependency did not pass is `blocked`, never `failed`. Reporting
 * it as a second failure sends the operator fixing two things when one is
 * broken. `unknown` is likewise distinct from `failed`: an unauthenticated
 * wrangler must not render as "your queues are missing".
 */
export function resolveStatuses(checks) {
  const byId = new Map();
  const resolved = [];
  for (const check of checks) {
    const dependency = check.dependsOn ? byId.get(check.dependsOn) : undefined;
    const blocked = dependency && dependency.status !== "ok";
    const entry = blocked
      ? {
          ...check,
          status: "blocked",
          detail: `blocked by ${check.dependsOn}`,
          fix: dependency.fix,
        }
      : { ...check, status: check.status ?? "unknown" };
    byId.set(entry.id, entry);
    resolved.push(entry);
  }
  return resolved;
}

export function formatReport(checks) {
  const lines = [];
  for (const check of resolveStatuses(checks)) {
    lines.push(`${STATUS_LABEL[check.status]} ${check.id} — ${check.detail}`);
    if (check.status !== "ok" && check.fix)
      lines.push(`      fix: ${check.fix}`);
  }
  return lines.join("\n");
}

export function hasFailure(checks) {
  return resolveStatuses(checks).some((check) => check.status !== "ok");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/runtime-doctor.mjs tests/runtime-doctor.test.mjs
git commit -m "feat: model runtime checks with blocked and unknown states"
```

---

### Task 5: Parse wrangler output

**Files:**

- Modify: `scripts/runtime-doctor.mjs`
- Test: `tests/runtime-doctor.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime-doctor.test.mjs`, extending the existing import to add
`checkQueues`, `checkHyperdrive`, and `expectedQueueNames`:

```js
test("expectedQueueNames reads the four queues from runtime config", () => {
  const names = expectedQueueNames(
    {
      environments: {
        production: {
          listingQueue: "wukong-listing-production",
          listingDlq: "wukong-listing-dlq-production",
          shoplineQueue: "wukong-shopline-production",
          shoplineDlq: "wukong-shopline-dlq-production",
        },
      },
    },
    "production",
  );

  assert.deepEqual(names, [
    "wukong-listing-production",
    "wukong-listing-dlq-production",
    "wukong-shopline-production",
    "wukong-shopline-dlq-production",
  ]);
});

test("checkQueues names every missing queue", () => {
  const check = checkQueues(
    ["wukong-listing-production", "wukong-listing-dlq-production"],
    JSON.stringify([
      { queue_name: "wukong-listing-production" },
      { queue_name: "unrelated" },
    ]),
    "production",
  );

  assert.equal(check.status, "failed");
  assert.match(check.detail, /wukong-listing-dlq-production/);
  assert.match(check.fix, /runtime:provision production/);
});

test("checkQueues passes when every expected queue exists", () => {
  const check = checkQueues(
    ["a", "b"],
    JSON.stringify([
      { queue_name: "a" },
      { queue_name: "b" },
      { queue_name: "c" },
    ]),
    "production",
  );

  assert.equal(check.status, "ok");
});

test("checkQueues reports unparsable output as unknown, not failed", () => {
  const check = checkQueues(["a"], "not json", "production");

  assert.equal(check.status, "unknown");
});

test("checkHyperdrive matches the configured id", () => {
  const listed = JSON.stringify([{ id: "abc123", name: "wukong" }]);

  assert.equal(checkHyperdrive(listed, "abc123").status, "ok");
  assert.equal(checkHyperdrive(listed, "def456").status, "failed");
  assert.equal(checkHyperdrive(listed, "").status, "failed");
  assert.equal(checkHyperdrive("not json", "abc123").status, "unknown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: FAIL — `expectedQueueNames` is not exported.

- [ ] **Step 3: Implement the parsers**

Append to `scripts/runtime-doctor.mjs`:

```js
export function expectedQueueNames(config, environment) {
  const selected = config.environments?.[environment];
  if (!selected) throw new Error(`unsupported environment: ${environment}`);
  return [
    selected.listingQueue,
    selected.listingDlq,
    selected.shoplineQueue,
    selected.shoplineDlq,
  ];
}

function parseNames(json, key) {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
  return parsed.map((entry) => entry?.[key]).filter(Boolean);
}

export function checkQueues(expected, listJson, environment) {
  let present;
  try {
    present = parseNames(listJson, "queue_name");
  } catch {
    return {
      id: "queues",
      status: "unknown",
      detail: "could not read `wrangler queues list --json`",
      fix: "wrangler queues list --json",
    };
  }
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

export function checkHyperdrive(listJson, configuredId) {
  let ids;
  try {
    ids = parseNames(listJson, "id");
  } catch {
    return {
      id: "hyperdrive",
      status: "unknown",
      detail: "could not read `wrangler hyperdrive list --json`",
      fix: "wrangler hyperdrive list --json",
    };
  }
  if (!configuredId) {
    return {
      id: "hyperdrive",
      status: "failed",
      detail: "CLOUDFLARE_HYPERDRIVE_ID is unset",
      fix: "wrangler hyperdrive create wukong --connection-string <neon-url>",
    };
  }
  if (!ids.includes(configuredId)) {
    return {
      id: "hyperdrive",
      status: "failed",
      detail: `no Hyperdrive config matches CLOUDFLARE_HYPERDRIVE_ID`,
      fix: "wrangler hyperdrive list --json",
    };
  }
  return { id: "hyperdrive", status: "ok", detail: "configured id exists" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/runtime-doctor.mjs tests/runtime-doctor.test.mjs
git commit -m "feat: check queues and hyperdrive against runtime config"
```

---

### Task 6: Check the health probes

**Files:**

- Modify: `scripts/runtime-doctor.mjs`
- Test: `tests/runtime-doctor.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime-doctor.test.mjs`, adding `checkHealthGet` and
`checkHealthSigned` to the import:

```js
test("checkHealthGet fails when a binding is unresolved", () => {
  const check = checkHealthGet({
    buildSha: "abc",
    adapterMode: "disabled",
    bindings: {
      hyperdrive: true,
      listingQueue: true,
      shoplineQueue: false,
      ingressSecret: true,
    },
  });

  assert.equal(check.status, "failed");
  assert.match(check.detail, /shoplineQueue/);
});

test("checkHealthGet passes when every binding resolves", () => {
  const check = checkHealthGet({
    buildSha: "abc",
    adapterMode: "disabled",
    bindings: {
      hyperdrive: true,
      listingQueue: true,
      shoplineQueue: true,
      ingressSecret: true,
    },
  });

  assert.equal(check.status, "ok");
});

test("checkHealthSigned treats 401 as a secret mismatch, the failure this tool exists for", () => {
  const check = checkHealthSigned({ status: 401 });

  assert.equal(check.status, "failed");
  assert.match(check.detail, /does not match/i);
  assert.match(check.fix, /QUEUE_INGRESS_SECRET/);
});

test("checkHealthSigned fails when the database is unreachable", () => {
  const check = checkHealthSigned({
    status: 200,
    body: { authenticated: true, checks: { hyperdriveConnects: false } },
  });

  assert.equal(check.status, "failed");
  assert.match(check.detail, /database/i);
});

test("checkHealthSigned passes when the secret agrees and the database answers", () => {
  const check = checkHealthSigned({
    status: 200,
    body: { authenticated: true, checks: { hyperdriveConnects: true } },
  });

  assert.equal(check.status, "ok");
});

test("checkHealthSigned reports an unreachable worker as unknown", () => {
  assert.equal(checkHealthSigned({ error: "ECONNREFUSED" }).status, "unknown");
});

// Pins the duplicated HMAC against packages/jobs/src/cloudflare-queue.ts. If
// signQueueRequest's message format ever changes, this vector fails and the
// doctor stops silently signing requests the Worker will reject.
test("signHealthProbe matches the queue signing algorithm", () => {
  const signature = signHealthProbe({
    secret: "q".repeat(32),
    timestamp: 1_784_556_000,
    path: "/health",
    body: "{}",
  });

  assert.equal(signature, "6UdPcVDj1a7-vHLBVMYWhcENn3OQzYFUdJVk2GhFpkE");
});
```

Add `signHealthProbe` to the import from `../scripts/runtime-doctor.mjs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: FAIL — `checkHealthGet` is not exported.

- [ ] **Step 3: Implement the checks**

Append to `scripts/runtime-doctor.mjs`:

```js
export function checkHealthGet(body) {
  const bindings = body?.bindings ?? {};
  const unresolved = Object.entries(bindings)
    .filter(([, resolved]) => !resolved)
    .map(([name]) => name);
  if (unresolved.length) {
    return {
      id: "health-get",
      status: "failed",
      detail: `unresolved bindings: ${unresolved.join(", ")}`,
      fix: "pnpm --filter @wukong/worker deploy:production",
      dependsOn: "worker-secrets",
    };
  }
  return {
    id: "health-get",
    status: "ok",
    detail: `deployed, build ${body.buildSha}`,
    dependsOn: "worker-secrets",
  };
}

export function checkHealthSigned(result) {
  if (result.error) {
    return {
      id: "health-signed",
      status: "unknown",
      detail: `worker unreachable: ${result.error}`,
      fix: "check QUEUE_INGRESS_URL in Vercel",
      dependsOn: "health-get",
    };
  }
  if (result.status === 401) {
    return {
      id: "health-signed",
      status: "failed",
      // The defining failure: both sides look configured, neither agrees.
      detail: "Vercel's QUEUE_INGRESS_SECRET does not match the Worker's",
      fix: "wrangler secret put QUEUE_INGRESS_SECRET  # must equal the Vercel value",
      dependsOn: "health-get",
    };
  }
  if (result.status !== 200) {
    return {
      id: "health-signed",
      status: "unknown",
      detail: `unexpected status ${result.status}`,
      fix: "check the worker deployment logs",
      dependsOn: "health-get",
    };
  }
  if (!result.body?.checks?.hyperdriveConnects) {
    return {
      id: "health-signed",
      status: "failed",
      detail:
        "secret matches, but the database did not answer through Hyperdrive",
      fix: "wrangler hyperdrive list --json  # confirm the connection string",
      dependsOn: "health-get",
    };
  }
  return {
    id: "health-signed",
    status: "ok",
    detail: "secret agrees and the database answers",
    dependsOn: "health-get",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/runtime-doctor.mjs tests/runtime-doctor.test.mjs
git commit -m "feat: prove the ingress secret matches across vercel and the worker"
```

---

### Task 7: Wire the doctor's `main()` and the provision script

**Files:**

- Modify: `scripts/runtime-doctor.mjs`
- Create: `scripts/provision-queues.mjs`
- Modify: `package.json`
- Test: `tests/runtime-doctor.test.mjs`

- [ ] **Step 1: Write the failing test for provisioning**

Append to `tests/runtime-doctor.test.mjs`, importing `planQueueCreation` from
`../scripts/provision-queues.mjs`:

```js
test("planQueueCreation creates only the queues that are absent", () => {
  const plan = planQueueCreation(
    ["a", "b", "c"],
    JSON.stringify([{ queue_name: "b" }]),
  );

  assert.deepEqual(plan.create, ["a", "c"]);
  assert.deepEqual(plan.existing, ["b"]);
});

test("planQueueCreation never plans a deletion", () => {
  const plan = planQueueCreation(
    ["a"],
    JSON.stringify([{ queue_name: "zzz" }]),
  );

  assert.deepEqual(plan.create, ["a"]);
  assert.equal(plan.delete, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: FAIL — cannot find `../scripts/provision-queues.mjs`.

- [ ] **Step 3: Write the provision script**

Create `scripts/provision-queues.mjs`:

```js
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
```

- [ ] **Step 4: Add the doctor's `main()`**

Append to `scripts/runtime-doctor.mjs`:

`scripts/` is not a workspace package and the root manifest does not depend on
`@wukong/jobs`, so the signing helper cannot be imported — and it should not be.
A diagnostic has to run when the workspace build is broken, which is exactly when
you reach for it, so it takes no build-order dependency. The algorithm is four
lines and pinned by a test vector in Task 6.

```js
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Mirrors signQueueRequest in packages/jobs/src/cloudflare-queue.ts, which is
 * the source of truth. Duplicated deliberately so the doctor has no build
 * dependency; the test vector in tests/runtime-doctor.test.mjs fails loudly if
 * the two ever diverge.
 */
export function signHealthProbe({ secret, timestamp, path, body }) {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${path}\n${body}`)
    .digest("base64url");
}

function wrangler(args) {
  const result = spawnSync("wrangler", args, { encoding: "utf8" });
  return result.stdout ?? "";
}

async function probeSigned(url, secret) {
  const body = "{}";
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = signHealthProbe({
    secret,
    timestamp,
    path: "/health",
    body,
  });
  try {
    const response = await fetch(new URL("/health", url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wukong-timestamp": String(timestamp),
        "x-wukong-signature": signature,
      },
      body,
    });
    return {
      status: response.status,
      body: response.status === 200 ? await response.json() : undefined,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const environment = process.argv[2]?.trim();
  if (!environment) throw new Error("usage: runtime:doctor <environment>");
  const config = JSON.parse(
    readFileSync(
      new URL("../cloudflare-runtime.config.json", import.meta.url),
      "utf8",
    ),
  );
  const ingressUrl = process.env.QUEUE_INGRESS_URL?.trim();
  const ingressSecret = process.env.QUEUE_INGRESS_SECRET?.trim();

  const checks = [
    { id: "wrangler-auth", ...whoamiCheck() },
    checkQueues(
      expectedQueueNames(config, environment),
      wrangler(["queues", "list", "--json"]),
      environment,
    ),
    checkHyperdrive(
      wrangler(["hyperdrive", "list", "--json"]),
      process.env.CLOUDFLARE_HYPERDRIVE_ID ?? "",
    ),
    secretsCheck(config, environment),
    { id: "vercel-env", ...vercelEnvCheck(ingressUrl, ingressSecret) },
  ];

  if (ingressUrl) {
    const health = await fetch(new URL("/health", ingressUrl)).then(
      (response) => response.json(),
      () => null,
    );
    checks.push(
      health
        ? checkHealthGet(health)
        : {
            id: "health-get",
            status: "unknown",
            detail: "worker unreachable",
            fix: "check QUEUE_INGRESS_URL",
            dependsOn: "worker-secrets",
          },
    );
    if (ingressSecret)
      checks.push(
        checkHealthSigned(await probeSigned(ingressUrl, ingressSecret)),
      );
  }

  console.log(formatReport(checks));
  console.log(
    "\nnote: SHOPLINE_TOKEN_ENCRYPTION_KEY and the two shopline queues are required by the\n" +
      "preflight but inert under CSV-only operation; a generated placeholder is correct.",
  );
  if (hasFailure(checks)) process.exitCode = 1;
}

function whoamiCheck() {
  const output = wrangler(["whoami"]);
  return output.includes("@") || /account/i.test(output)
    ? { status: "ok", detail: "wrangler authenticated" }
    : {
        status: "unknown",
        detail: "wrangler is not logged in",
        fix: "wrangler login",
      };
}

function secretsCheck(config, environment) {
  const required = config.requiredSecrets ?? [];
  let configured = [];
  try {
    configured = JSON.parse(wrangler(["secret", "list"])).map(
      (entry) => entry.name,
    );
  } catch {
    return {
      id: "worker-secrets",
      status: "unknown",
      detail: "could not list worker secrets",
      fix: "wrangler secret list",
      dependsOn: "wrangler-auth",
    };
  }
  const missing = required.filter((name) => !configured.includes(name));
  return missing.length
    ? {
        id: "worker-secrets",
        status: "failed",
        detail: `missing ${missing.join(", ")}`,
        fix: `wrangler secret put ${missing[0]}`,
        dependsOn: "wrangler-auth",
      }
    : {
        id: "worker-secrets",
        status: "ok",
        detail: `${required.length} secrets set`,
        dependsOn: "wrangler-auth",
      };
}

function vercelEnvCheck(url, secret) {
  const missing = [
    ...(url ? [] : ["QUEUE_INGRESS_URL"]),
    ...(secret ? [] : ["QUEUE_INGRESS_SECRET"]),
  ];
  return missing.length
    ? {
        status: "failed",
        detail: `missing ${missing.join(", ")} in this environment`,
        fix: `vercel env add ${missing[0]} production`,
      }
    : { status: "ok", detail: "ingress url and secret present" };
}

if (process.argv[1]?.endsWith("runtime-doctor.mjs")) await main();
```

Move the two `import` statements to the top of the file — ESM requires it.

- [ ] **Step 5: Register the scripts**

In the root `package.json` `"scripts"`, add:

```json
    "runtime:doctor": "node scripts/runtime-doctor.mjs",
    "runtime:provision": "node scripts/provision-queues.mjs",
```

and extend the root test command so the new suite runs in CI:

```json
    "test": "node --test tests/ci-workflow.test.mjs tests/cloudflare-config.test.mjs tests/runtime-doctor.test.mjs && turbo run test",
```

- [ ] **Step 6: Run the tests**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: PASS
Run: `pnpm runtime:doctor production`
Expected: a report listing every check; non-zero exit while the environment is
unconfigured. It must not throw a stack trace.

- [ ] **Step 7: Commit**

```bash
git add scripts/runtime-doctor.mjs scripts/provision-queues.mjs tests/runtime-doctor.test.mjs package.json
git commit -m "feat: add the runtime doctor and queue provisioner"
```

---

### Task 8: Gate the deploy scripts on the preconditions

**Files:**

- Modify: `apps/worker/package.json`
- Test: `tests/ci-workflow.test.mjs`

Checks 1–4 (`wrangler-auth`, `queues`, `hyperdrive`, `worker-secrets`) must hold
before a deploy can succeed. Checks 5–7 need a deployed Worker and stay in
`runtime:doctor` alone.

- [ ] **Step 1: Add the pre-deploy mode**

In `scripts/runtime-doctor.mjs`'s `main()`, read a `--pre-deploy` flag and stop
after the first four checks:

```js
  const preDeployOnly = process.argv.includes("--pre-deploy");
  ...
  if (!preDeployOnly && ingressUrl) {
```

- [ ] **Step 2: Call it from both deploy scripts**

In `apps/worker/package.json`, insert the doctor before the existing render step
in `deploy:preview` and `deploy:production`:

```
node ../../scripts/runtime-doctor.mjs preview --pre-deploy && <existing command>
```

Use `production` for `deploy:production`. Leave the rest of each command exactly
as it is.

- [ ] **Step 3: Run the config suites**

Run: `node --test tests/ci-workflow.test.mjs tests/cloudflare-config.test.mjs`
Expected: PASS with no test changes. `tests/ci-workflow.test.mjs:377` asserts only
that `verify-cloudflare-secrets.mjs` appears _before_ `wrangler deploy` in both
scripts; prefixing the doctor ahead of the render step preserves that ordering.
If this step fails, the prefix was inserted in the wrong place.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/package.json scripts/runtime-doctor.mjs tests/ci-workflow.test.mjs
git commit -m "feat: gate worker deploys on the bring-up preconditions"
```

---

### Task 9: Gates before opening the PR

- [ ] **Step 1: Full suites**

Run: `pnpm test` — expected: all packages pass, including the new
`tests/runtime-doctor.test.mjs`.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck` — expected: no output.

- [ ] **Step 3: Format gate**

Run: `npx prettier --write scripts/runtime-doctor.mjs scripts/provision-queues.mjs tests/runtime-doctor.test.mjs`
Run: `node scripts/check-runtime-format.mjs`
Expected: `hash-pinned format debt waived: 0` and no "requiring Prettier" list.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin HEAD
gh pr create --repo YNWAforever/wukong-ecommerce-os --base main --head codex/runtime-bring-up-doctor --fill
```

---

## Operator checklist (no code)

- [ ] `pnpm runtime:doctor production` — read the first red check
- [ ] `pnpm runtime:provision production` — create the four queues
- [ ] `wrangler hyperdrive create wukong --connection-string <neon-url>`; export the printed id as `CLOUDFLARE_HYPERDRIVE_ID`
- [ ] `wrangler secret put` for each of the five required secrets
- [ ] `pnpm --filter @wukong/worker deploy:production`
- [ ] Set `QUEUE_INGRESS_URL` and `QUEUE_INGRESS_SECRET` in Vercel production and redeploy
- [ ] `pnpm runtime:doctor production` — every check green, including `health-signed`
- [ ] Only then resume the CSV phase's Track 1 and Track 3
