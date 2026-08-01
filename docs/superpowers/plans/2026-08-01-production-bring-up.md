# Production Bring-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Cloudflare Worker is deployed and `pnpm runtime:doctor production` exits zero against real infrastructure, with `health-signed` proving Vercel and the Worker hold the same ingress secret.

**Architecture:** A gated sequence, not a feature. Each stage is verified by the doctor before the next begins: green `main` → diagnose → close pre-deploy gaps → deploy → close post-deploy gaps → green doctor → runbook. Steps that handle a credential value belong to the operator and are marked **OPERATOR**; everything else is assistant work.

**Tech Stack:** Wrangler CLI, Cloudflare Queues + Hyperdrive + R2, Vercel CLI, Node 24, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-01-production-bring-up-design.md`

---

## Note on shape

Most tasks here are not TDD, because most of this phase is configuration against
live infrastructure rather than code. Task 4 is the exception: it is the
contingency for the parsing defect the spec predicts, and it is written as a
normal red/green cycle.

**Do not** invent Cloudflare or Vercel values. Every value either comes from
`cloudflare-runtime.config.json` or is supplied by the operator.

Production names, for reference (from `cloudflare-runtime.config.json`):

| Thing     | Value                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Worker    | `wukong-runtime-production`                                                                                                  |
| Queues    | `wukong-listing-production`, `wukong-listing-dlq-production`, `wukong-shopline-production`, `wukong-shopline-dlq-production` |
| R2 bucket | `wukong-opak-prod-assets`                                                                                                    |
| Secrets   | `QUEUE_INGRESS_SECRET`, `OPENAI_API_KEY`, `SHOPLINE_TOKEN_ENCRYPTION_KEY`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`        |

---

### Task 1: Green `main`

**Files:** none — this is a merge.

- [ ] **Step 1: Confirm #25 is still mergeable**

Run: `gh pr view 25 --repo YNWAforever/wukong-ecommerce-os --json state,mergeable --jq '{state,mergeable}'`
Expected: `{"mergeable":"MERGEABLE","state":"OPEN"}`

- [ ] **Step 2: Merge it**

```bash
gh pr merge 25 --repo YNWAforever/wukong-ecommerce-os --merge
```

`--merge` (not `--squash`) matches the repository's convention of merge commits into `main`.

- [ ] **Step 3: Verify `main` is actually green**

```bash
git fetch origin
git checkout -b verify-main-green origin/main
pnpm test
```

Expected: `Tasks: 14 successful, 14 total`.

Postgres must be running for `@wukong/db`. If it is not:

```bash
colima start
docker run -d --name wukong-local-pg -e POSTGRES_USER=wukong -e POSTGRES_PASSWORD=wukong -e POSTGRES_DB=wukong -p 54329:5432 postgres:17-alpine
docker exec wukong-local-pg psql -U wukong -d wukong -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END \$\$;"
DATABASE_URL="postgres://wukong_app:wukong-app-local@localhost:54329/wukong" DATABASE_ADMIN_URL="postgres://wukong:wukong@localhost:54329/wukong" pnpm --filter @wukong/db db:migrate
```

then re-run `pnpm test` with `DATABASE_URL`, `DATABASE_ADMIN_URL`, `TEST_DATABASE_URL` and `TEST_DATABASE_ADMIN_URL` all set to those two URLs.

- [ ] **Step 4: Delete the scratch branch**

```bash
git checkout codex/production-bring-up
git branch -D verify-main-green
```

If `pnpm test` was not 14/14, STOP and report. Everything downstream assumes a
green baseline, and a second red `main` is not something to build on.

---

### Task 2: First real diagnostic run

This is the first time the doctor meets a real Cloudflare account. Its output is
the deliverable of this task — not a green result.

**Files:** none.

- [ ] **Step 1: Confirm wrangler is authenticated**

Run: `pnpm --filter @wukong/worker exec wrangler whoami`
Expected: an account table. If it says you are not logged in, STOP — `wrangler login` is an
**OPERATOR** step, since it opens a browser session against their Cloudflare account.

- [ ] **Step 2: Run the doctor**

```bash
pnpm runtime:doctor production 2>&1 | tee /tmp/doctor-run-1.txt
```

Expected: a report of seven or fewer checks and a non-zero exit. Nothing is
configured yet, so red is correct.

- [ ] **Step 3: Classify every non-green check**

For each check that is not `OK`, write down which of these it is:

1. **A real gap** — the resource genuinely does not exist. Goes to Task 3 or 5.
2. **A doctor defect** — the resource exists but the check cannot read it, or the
   message is wrong. Goes to Task 4.

The distinguishing move is to run the underlying command by hand:

```bash
pnpm --filter @wukong/worker exec wrangler queues list --json
pnpm --filter @wukong/worker exec wrangler hyperdrive list --json
pnpm --filter @wukong/worker exec wrangler secret list --name wukong-runtime-production
```

If a command returns data but its check reported `unknown`, that is a doctor
defect, not a gap.

- [ ] **Step 4: Record the classification**

Save the raw output of each command above to `/tmp/` — Task 4 needs the real JSON
shape as a test fixture, and it cannot be reconstructed later.

No commit: nothing in the repository changed.

---

### Task 3: Close the pre-deploy gaps — **OPERATOR**

Every step here handles a credential value or mutates the Cloudflare account.
The assistant does not run these.

**Files:** none.

- [ ] **Step 1: Confirm the Workers plan**

Cloudflare Queues requires a paid Workers plan. If the account is on the free
plan, everything below fails and no tooling helps. Confirm first.

- [ ] **Step 2: Create the four queues**

```bash
pnpm runtime:provision production
```

Expected: four `created <name>` lines, or `exists <name>` for any already present.
It never deletes.

- [ ] **Step 3: Create the Hyperdrive config**

Use the runtime Neon role, never the admin URL — see
`docs/runbooks/production-ai-runtime.md` line 38.

```bash
pnpm --filter @wukong/worker exec wrangler hyperdrive create wukong-production --connection-string "<neon-runtime-url>"
```

Keep the printed configuration id. Export it for the deploy in Task 5:

```bash
export CLOUDFLARE_HYPERDRIVE_ID="<configuration-id>"
```

The id is not a secret; the connection string is.

- [ ] **Step 4: Set the five Worker secrets**

The exact commands are already documented at
`docs/runbooks/production-ai-runtime.md` lines 61-65. Use
`--name wukong-runtime-production`.

`SHOPLINE_TOKEN_ENCRYPTION_KEY` is required by the secret preflight but inert
under CSV-only operation — a generated placeholder is correct here, not a real
key.

- [ ] **Step 5: Verify the pre-deploy checks are green**

```bash
pnpm runtime:doctor production --pre-deploy
```

Expected: `wrangler-auth`, `queues`, `hyperdrive` and `worker-secrets` all `OK`,
exit zero. Loop back through the steps above until they are.

If a check stays red while the resource demonstrably exists, that is Task 4.

---

### Task 4: Fix a doctor parsing defect — contingency

Run this task only if Task 2 Step 3 or Task 3 Step 5 classified something as a
doctor defect. Skip it entirely otherwise, and say so.

The spec predicts this: `checkQueues` and `checkHyperdrive` parse `--json` shapes
inferred from documentation rather than observed.

**Files:**

- Modify: `scripts/runtime-doctor.mjs`
- Test: `tests/runtime-doctor.test.mjs`

- [ ] **Step 1: Write a failing test from the REAL output**

Take the actual JSON saved in Task 2 Step 4 and add a test using it verbatim.
For a queue-list field-name mismatch it looks like this — replace the literal
with the real payload:

```js
test("checkQueues reads the real wrangler queues list shape", () => {
  // Captured from `wrangler queues list --json` on 2026-08-01. Do not
  // hand-edit: the point of this fixture is that it was observed, not inferred.
  const real = JSON.stringify([
    { queue_id: "abc", queue_name: "wukong-listing-production" },
  ]);

  const check = checkQueues(["wukong-listing-production"], real, "production");

  assert.equal(check.status, "ok");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: FAIL — the check reports `unknown` or `failed` against real data.

- [ ] **Step 3: Fix the parser**

Adjust the field name in `parseNames(json, key)`'s caller — `checkQueues` passes
`"queue_name"`, `checkHyperdrive` passes `"id"`. Change only what the real payload
requires. Do not loosen the parse into accepting anything, which would trade a
wrong answer for a silent one.

- [ ] **Step 4: Run the full script suite**

Run: `node --test tests/runtime-doctor.test.mjs`
Expected: PASS, with the new fixture test included.

- [ ] **Step 5: Commit**

```bash
git add scripts/runtime-doctor.mjs tests/runtime-doctor.test.mjs
git commit -m "fix: parse the real wrangler output shape"
```

- [ ] **Step 6: Re-run the doctor**

```bash
pnpm runtime:doctor production --pre-deploy
```

Expected: the previously-defective check is now `OK`.

---

### Task 5: Deploy the Worker

**Files:** none — this renders `.wrangler/wrangler.generated.jsonc` (gitignored) and deploys.

- [ ] **Step 1: Deploy with the eight render inputs**

`CLOUDFLARE_HYPERDRIVE_ID` comes from Task 3 Step 3. The others are fixed for
production:

```bash
CLOUDFLARE_HYPERDRIVE_ID="<configuration-id>" \
BUILD_SHA="$(git rev-parse HEAD)" \
AI_PROVIDER=openai \
OPENAI_LISTING_MODEL=gpt-5-mini \
S3_BUCKET=wukong-opak-prod-assets \
S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
S3_REGION=auto \
S3_FORCE_PATH_STYLE=false \
pnpm --filter @wukong/worker deploy:production
```

`CLOUDFLARE_ENV` is set to `production` by the deploy script itself — do not pass it.

`<account-id>` is the Cloudflare account id; the renderer rejects an endpoint that
is not an R2 S3 API root, so a wrong value fails fast rather than deploying
something broken.

This command runs, in order: the doctor's pre-deploy checks, the config renderer,
the secret preflight, then `wrangler deploy`. Any of them failing aborts the deploy.

- [ ] **Step 2: Confirm the Worker answers**

```bash
curl -s https://wukong-runtime-production.<subdomain>.workers.dev/health | head -20
```

Expected: JSON with `buildSha`, `adapterMode`, and a `bindings` object whose four
booleans are all `true`.

If `hyperdrive` is `false`, the binding did not attach — re-check
`CLOUDFLARE_HYPERDRIVE_ID`. Do not proceed with a false binding.

---

### Task 6: Wire Vercel — **OPERATOR**

**Files:** none.

- [ ] **Step 1: Set the two variables**

`QUEUE_INGRESS_URL` is the Worker's origin from Task 5 Step 2.
`QUEUE_INGRESS_SECRET` must be **byte-identical** to the Worker secret set in
Task 3 Step 4 — this is the single most common failure in this whole sequence,
and the one `health-signed` exists to catch.

```bash
vercel env add QUEUE_INGRESS_URL production
vercel env add QUEUE_INGRESS_SECRET production
```

- [ ] **Step 2: Redeploy the web app**

Vercel environment variables apply at build time, so an existing deployment will
not pick them up.

```bash
vercel --prod
```

---

### Task 7: Prove it

**Files:** none.

- [ ] **Step 1: Run the full doctor with the Vercel values in the environment**

The doctor signs its probe with `QUEUE_INGRESS_SECRET` and reaches the Worker at
`QUEUE_INGRESS_URL`, so both must be present locally:

```bash
QUEUE_INGRESS_URL="<worker-origin>" \
QUEUE_INGRESS_SECRET="<same-secret>" \
CLOUDFLARE_HYPERDRIVE_ID="<configuration-id>" \
pnpm runtime:doctor production
```

Expected: every check `OK`, exit zero.

- [ ] **Step 2: Read `health-signed` specifically**

This is the phase's definition of done. If it reports
`Vercel's QUEUE_INGRESS_SECRET does not match the Worker's`, the two values differ
— re-set the Worker secret to match Vercel exactly and redeploy the Worker.

If it reports `secret matches, but the database did not answer through Hyperdrive`,
the secret is fine and the Neon connection string is wrong.

- [ ] **Step 3: Confirm end to end in the app**

Create a draft in the production web app and confirm it no longer falls back to
`retry_required`. This is the behaviour the entire pilot has been blocked on.

---

### Task 8: Write the runbook

**Files:**

- Create: `docs/runbooks/production-bring-up.md`

- [ ] **Step 1: Write it from what actually happened**

Not from this plan — from the commands that were really run and the output really
seen. It must contain:

- the ordered sequence, with the real commands including the eight render inputs
  (`CLOUDFLARE_ENV` is set by the deploy script, not passed)
- what each of the seven checks means when it fails, and the command that fixes it
- the note that `SHOPLINE_TOKEN_ENCRYPTION_KEY` and the two shopline queues are
  required by the preflight but inert under CSV-only operation
- any doctor defect found in Task 4, and what the real output shape turned out to be
- the coverage gaps that remain: R2 reachability and queue-consumer health are not
  checked, so a green doctor is necessary but not sufficient

- [ ] **Step 2: Format and commit**

```bash
npx prettier --write docs/runbooks/production-bring-up.md
git add docs/runbooks/production-bring-up.md
git commit -m "docs: record the production bring-up sequence"
```

---

### Task 9: Gates and PR

- [ ] **Step 1: Full suites**

Run: `pnpm test` — expected 14/14 (Postgres running, per Task 1 Step 3).
Run: `pnpm typecheck` — expected 14/14.
Run: `node scripts/check-runtime-format.mjs` — expected `hash-pinned format debt waived: 0`.

- [ ] **Step 2: Open the PR**

```bash
git push -u origin HEAD
gh pr create --repo YNWAforever/wukong-ecommerce-os --base main --head codex/production-bring-up --fill
```

- [ ] **Step 3: Log the follow-ups**

Open an issue for each coverage gap rather than absorbing it:

- doctor does not check R2 reachability
- doctor does not check queue-consumer health
- `packages/db`'s `test` script `--exclude src/**/*.integration.test.ts` does not
  actually exclude them, so the package needs Postgres to pass
- `scripts/verify-cloudflare-secrets.mjs` invokes `corepack`, which is not
  installed everywhere `pnpm` is — `scripts/runtime-doctor.mjs` now falls back and
  the older script should too

---

## What "done" means

`pnpm runtime:doctor production` exits zero with `health-signed` green, a draft
created in production reaches the pipeline instead of `retry_required`, and
`docs/runbooks/production-bring-up.md` records how to do it again.

SHOPLINE Track 1 and Track 3 are the next phase and are deliberately not here.
