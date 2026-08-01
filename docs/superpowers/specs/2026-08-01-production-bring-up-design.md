# Production bring-up — design

Date: 2026-08-01
Status: accepted

## Goal

The Cloudflare Worker is deployed and `pnpm runtime:doctor production` reports
every check green — including `health-signed`, which is the first moment anything
proves Vercel and the Worker hold the same ingress secret.

The phase is finished when that command exits zero against real infrastructure.
Nothing less counts: the whole point is that every intermediate step already
reports success locally while the pipeline stays unreachable.

## Why this, and why now

This phase ships no feature. It exists because three phases of code have now been
written on top of a runtime that has never run.

`main` is red. Three pull requests are open and unmerged. The Worker has never
been deployed, `QUEUE_INGRESS_URL` and `QUEUE_INGRESS_SECRET` are unset in Vercel,
and drafts still fall back to `retry_required`. The previous phase built a
diagnostic specifically to unblock this deployment, and that diagnostic has never
been pointed at a real Cloudflare account.

Building a fourth phase of code before any of that lands would compound the exact
problem the third phase was meant to solve.

## Sequence

Four stages, each gated on the previous.

**1. Green main.** Merge #25 only. It changes two test assertions that #23 broke,
and a red `main` is a hazard in its own right. #24 and #26 stay open until CI can
verify them — GitHub Actions is blocked on billing, and #23 demonstrated that a
locally-green branch is not the same as a verified one. The working branch already
contains #25, so local runs are unaffected either way.

**2. Diagnose.** Run `pnpm runtime:doctor production` from the repository root
against real Cloudflare. Its output becomes an ordered gap list, each entry
carrying the exact command that closes it.

**3. Close the pre-deploy gaps.** The four queues, the Hyperdrive config, and the
five `wrangler secret put` calls. These are checks 1–4, the ones that must hold
_before_ a deploy can succeed, and `pnpm runtime:doctor production --pre-deploy`
is the loop to run until they are green. Every step here carries a credential
value and stays with the operator.

**4. Deploy, then close the rest.** Checks 5–7 cannot pass before the Worker
exists — `health-get` and `health-signed` both require something to answer. So the
order is: deploy the Worker, set `QUEUE_INGRESS_URL` and `QUEUE_INGRESS_SECRET` in
Vercel, redeploy the web app, then run the full `pnpm runtime:doctor production`
until it exits zero. `health-signed` is the last check to go green and the only
one that proves the two sides agree.

## Division of labour

The assistant merges pull requests, runs the doctor, interprets its output, and
fixes defects it exposes in repository code.

The assistant creates nothing in the Cloudflare or Vercel accounts — including
the four queues, even though `runtime:provision` exists and `wrangler` is
authenticated locally. Account mutation and every step handling a secret value
belong to the operator, as does GitHub Actions billing.

Credential values are never pasted back into the session.

## What we expect to go wrong

The doctor has never run against a real Cloudflare account. `checkQueues` and
`checkHyperdrive` parse `--json` output whose shape was inferred from
documentation rather than observed. A wrong field name is likely.

When that happens the affected check reports `unknown` rather than a confident
false diagnosis — that is the design working as intended — but it still means a
code fix mid-phase. Predicting it now is better than presenting it later as a
surprise.

The previous phase's review already caught one instance of this class: the
diagnostic could not find `wrangler` at all from the repository root, and reported
it as "wrangler is not logged in". Expect more of the same shape.

## Error handling

A defect found in doctor code is fixed on a branch off `main`, with a regression
test whose fixture is captured from the **real** wrangler response — strictly
better evidence than the inferred fixtures the suite has today.

Gaps in _coverage_ rather than correctness — R2 reachability and queue-consumer
health, neither of which is checked — are logged as follow-ups. Absorbing them
here would make the phase unbounded, which is how the last three phases each
ended without the runtime ever running.

## Testing

No new automated tests unless doctor code changes. When it does, the existing
`tests/runtime-doctor.test.mjs` pattern applies: pure functions, fixture JSON,
`node --test`.

The real verification in this phase is manual and singular — a green doctor run
against production infrastructure. That cannot be mocked, and mocking it is what
produced the current situation.

## Deliverable

`docs/runbooks/production-bring-up.md`, written as the phase proceeds rather than
afterwards: the ordered sequence with real commands, what each check means when it
fails, and an explicit note that `SHOPLINE_TOKEN_ENCRYPTION_KEY` and the two
shopline queues are required by the secret preflight but inert under CSV-only
operation. A placeholder that looks wrong is the kind of thing that stalls a
bring-up.

## Out of scope

SHOPLINE Track 1 (importing the sample CSV into Opak's store) and Track 3 (running
one real wine end to end). Both depend on this phase succeeding, and folding them
in would leave the phase without a boundary. They are the next phase.

Also out of scope: merging #24 and #26, which wait on CI; and any new capability —
batch export, multi-operator access, direct SHOPLINE API integration.

## Risks

- **Cloudflare Queues requires a paid Workers plan.** If the account is not on
  one, stage 3 stops until that is resolved, and no amount of tooling helps.
- **The doctor passes and the pipeline still fails.** Seven checks are not the
  whole system. R2 and consumer health are unverified, so a green doctor is
  necessary rather than sufficient — Track 3 remains the real proof.
- **Merging #25 without CI.** Accepted deliberately: it touches only test
  assertions, and the alternative is leaving `main` red indefinitely while
  Actions billing is unresolved.
