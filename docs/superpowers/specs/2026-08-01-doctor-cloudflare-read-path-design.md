# Runtime doctor Cloudflare read path — design

Date: 2026-08-01
Status: accepted

## Goal

`pnpm runtime:doctor production` reports the real state of the four queues and
the Hyperdrive config, instead of `unknown — could not read`. A first-ever
`deploy:production` succeeds instead of being blocked by its own preflight.

The phase is finished when two things hold:

1. The doctor, run against the live Cloudflare account, reports `queues` and
   `hyperdrive` as `ok` — they genuinely exist — and names the missing Worker
   instead of reporting a vague unknown. This is verified by running it.
2. The preflight's decision logic is unit-tested: Worker-absent permits, and a
   Worker with missing secret names still aborts.

The second is deliberately a unit-level claim. Proving an actual first deploy
succeeds requires creating a real Worker, which is operator work and belongs to
the production bring-up phase, not here.

## Why

Two checks have never worked. They shell out with `--json`, which
`wrangler queues list` and `wrangler hyperdrive list` do not accept — the only
option either takes is `--page`. The flag was inferred from documentation rather
than observed, and the unit-test fixtures were written to match the inference, so
the suite passed while the checks could not function.

Separately, `deploy:production` cannot bootstrap a new environment. Its preflight
runs `wrangler secret list --name <worker>` and aborts on any non-zero exit, which
is guaranteed when the Worker does not exist. Secrets cannot be set without a
Worker, and the Worker cannot deploy without secrets. That deadlock is what
currently blocks the pilot.

## Decisions taken

**The checks stay.** The doctor exists to name the broken step _before_ a deploy.
`health-get` needs a deployed Worker, and `wrangler deploy`'s failure is raw
Cloudflare output rather than a fix instruction.

**Parse the table; do not add a credential.** The Cloudflare REST API is a stable,
versioned interface, but it needs a `CLOUDFLARE_API_TOKEN` that this repository
does not have and does not otherwise want. A diagnostic reached for when things
are broken should not gain one more thing that can be missing. wrangler is already
OAuth-authenticated, so table parsing costs nothing to set up.

This is the weaker engineering choice in isolation and is taken deliberately.
Table output is presentation, not an interface, and it will change. The mitigation
is that a parse failure degrades to `unknown`, never to a false answer, and the
fixtures are captured from real output rather than imagined.

**`wrangler secret list` keeps its JSON path.** It does support `--format json`;
the failure observed there was "Worker not found", not an unknown argument. Only
`queues list` and `hyperdrive list` need parsing.

## Components

**`parseWranglerTable(text)`** — new pure function in `scripts/runtime-doctor.mjs`.

```
parseWranglerTable(text) → { columns: string[], rows: Array<Record<string, string>> } | null
```

Strips ANSI escapes, finds the header row between the top border and the
separator, splits on the box-drawing column separator, and returns rows keyed by
column name. Returns `null` when the input contains no table it recognises.

Keying off the header rather than column positions means an added or reordered
column does not break it — and a header lacking the expected column is detectable,
which is what turns silent misparsing into a named diagnosis.

**`checkQueues(expected, listOutput, environment)`** and
**`checkHyperdrive(listOutput, configuredId)`** — signatures change from taking
JSON text to taking raw stdout. `checkQueues` requires a `name` column,
`checkHyperdrive` an `id` column.

**`secretsCheck`** — gains a branch matching `Worker … not found`, reporting
`failed` with a detail naming the missing Worker and a fix pointing at the
bootstrap deploy.

**`verify-cloudflare-secrets.mjs`** — gains the same distinction: a Worker that
does not exist warns on stderr and allows the deploy through, because
`wrangler deploy` is about to create it. A Worker that exists with missing or
unexpected secret names aborts exactly as it does today.

## Three outcomes, not two

This is where the value sits.

| Situation                                     | Result                                                  |
| --------------------------------------------- | ------------------------------------------------------- |
| Table parsed, expected rows present           | `ok`                                                    |
| Table parsed, header valid, rows missing      | `failed` — genuinely absent; fix is `runtime:provision` |
| No table, or header lacks the expected column | `unknown` — "wrangler output format changed"            |

The middle row matters most. An empty but well-formed table means the resources
really are missing and the operator should be told to create them. Collapsing it
into `unknown` would make the check useless in the one case it exists for.

## Error handling

A parse failure is always `unknown`, never `failed`. The existing rule holds: a
confidently wrong diagnosis is worse than none, because it is acted upon.

ANSI escapes are stripped before parsing. Output captured through a pipe was
clean, but wrangler may colourise when attached to a TTY, and the doctor must not
depend on how it was invoked.

## Testing

Fixtures are the **real** output captured from wrangler 4.112.0 on 2026-08-01 —
the four-queue table and the single-row Hyperdrive table, verbatim, with a comment
in the test file recording that they were observed rather than inferred. The
original defect was inferred fixtures agreeing with inferred code, so the
provenance belongs in the file.

Cases: happy path; one queue missing; zero rows with a valid header; header
missing the expected column; unparseable input; ANSI-wrapped output. For the
preflight: Worker absent allows the deploy, Worker present with missing secrets
aborts.

## Out of scope

Adding R2 reachability or queue-consumer checks — real coverage gaps, already
logged, but not this phase. Migrating to the Cloudflare REST API, which stays the
fallback plan if table parsing breaks again. Any change to the check model,
report format, or the signed health probe.

## Risks

- **wrangler changes its table rendering.** Likely eventually. The design cannot
  prevent it, only make it loud: the header check reports "output format changed"
  rather than silently reading nothing. If this recurs, take the API token.
- **The bootstrap relaxation weakens the preflight.** A first deploy now ships a
  Worker with no secrets, which fails at runtime until they are set. That is
  strictly better than today's deadlock, and the warning says so, but it does mean
  the preflight no longer guarantees "deployed implies configured" for the very
  first deploy of an environment.
