# Live model onboarding — OpenCode Go / `deepseek-v4.1-flash` (A3, prepared 2026-11-12)

Status: **configured and deployed on 2026-11-14 (Asia/Singapore); first live-model call unverified**.
The approved `opencode-go` / `deepseek-v4.1-flash` settings were applied through the existing admin
settings service using the non-superuser, RLS-enforced `wukong_app` database role: **USD 10.00 cumulative
workspace cap**, **USD 2.00 per-run ceiling**, **4,096 max output tokens**, pricing label
**`opencode-go-2026-11`**. Server readback and `studio.settings.updated` audit
`043aee38-53e5-4e06-a619-fe8261c23167` confirm the write; existing skills, retention and home settings
were preserved. Vercel Production lists `OPENCODE_GO_API_KEY`, and
`CONVERSATION_STUDIO_AI_ENABLED=true` is deployed in Ready deployment
`dpl_D4uHVzUYrjm8D4imFC27sf7GPMkf` on the production alias. Credential validity, provider usage and
settled cost still require a new model-backed run; the latest content-free database check found no
runs, model events or reservations after configuration. See section 11 of the activation package.

## What is already implemented

- The reviewed model registry (`packages/core/src/paid-listing-policy.ts`) contains exactly one Studio
  entry: `opencode-go` / `deepseek-v4.1-flash`, context **1,048,576** tokens, **$0.30** / **$1.20** per
  million input/output tokens.
- `apps/web/lib/studio/settings-admin.ts` exposes that entry in the admin settings panel and validates
  submissions against the registry; admission (`studioTurnReservation`) refuses any pair or price below
  the reviewed bound.
- A turn reserves the **full documented context** (including media) before calling the model, settles
  actual usage afterwards, never retries, and fails the model part of the turn closed with a safe error
  code — the deterministic artifact still stands.
- Model analysis is attempted only when **all** of these hold: `CONVERSATION_STUDIO_ENABLED` is on, the
  workspace is enabled, `CONVERSATION_STUDIO_AI_ENABLED=true`, the workspace `ai` block is non-null with
  a reviewed provider/model, and the provider credential is present. Anything missing means
  deterministic-only, never a silent fallback to a different model.

## Inputs the operator must provide

| Input                    | Where it goes                                  | Notes                                                                               |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `OPENCODE_GO_API_KEY`    | Vercel production env (sensitive, server-only) | never `NEXT_PUBLIC_*`, never committed; rotate by updating + redeploy               |
| Monthly budget cap (USD) | `monthlyBudgetUsd`                             | max **100.00**; this is the committed-USD admission cap, no auto-reset              |
| Per-run ceiling (USD)    | `runCeilingUsd`                                | must cover a full-context reservation (e.g. `2.00`); `<= monthlyBudgetUsd`          |
| Pricing version label    | `ai.pricingVersion`                            | free-form audit label, e.g. `opencode-go-2026-11`; record where the price came from |
| Max output tokens        | `ai.maxOutputTokens`                           | `<= 16,384`; 4,096 is a conservative start                                          |
| Keep-allowed skills      | `allowedSkills`                                | registry keys only, e.g. `catalog.find`; the admin panel lists them                 |

## Exact settings — do this only while A2 is live and audited

Use an **admin/owner** session on the audited settings surface (`/studio/settings` or
`PATCH /api/studio/settings`). Preserve the current `allowedSkills`, `retentionDays`, `defaultHome`
and `enabled` values when configuring AI. The body below illustrates those fields; they are not
new approvals to replace the workspace's existing configuration. The approved AI and budget values
are shown exactly. Never use hand-written `UPDATE` SQL to bypass the admin surface:

```json
{
  "enabled": true,
  "allowedSkills": ["catalog.find"],
  "monthlyBudgetUsd": "10.00",
  "runCeilingUsd": "2.00",
  "retentionDays": null,
  "defaultHome": false,
  "ai": {
    "provider": "opencode-go",
    "model": "deepseek-v4.1-flash",
    "pricingVersion": "opencode-go-2026-11",
    "maxInputTokens": 1048576,
    "maxOutputTokens": 4096,
    "inputUsdPerMillion": "0.30",
    "outputUsdPerMillion": "1.20"
  }
}
```

Rules the route enforces: money fields are strings (`^\d+(\.\d{1,6})?$`), prices `^\d+(\.\d{1,4})?$`,
`maxInputTokens >= 1,048,576`, input price `>= 0.30`, output price `>= 1.20`, `maxOutputTokens <= 16,384`,
`runCeilingUsd` must cover the conservative full-context ceiling and stay at or below
`monthlyBudgetUsd`. Every accepted PATCH writes one `studio.settings.updated` audit row with
`before`/`after` and no prompt content.

## Flag and credential sequencing

1. Confirm A2 is live: Studio settings row enabled, activation audited, `CONVERSATION_STUDIO_ENABLED`
   on, deterministic acceptance green.
2. Set the Vercel **production** env `OPENCODE_GO_API_KEY` (sensitive) and
   `CONVERSATION_STUDIO_AI_ENABLED=true`; redeploy.
3. PATCH the settings block above (settings first is also fine while the flag is off — the turn simply
   stays deterministic until both are present).
4. Verify on `/studio` with the pilot workspace's operator:
   - a turn returns model-backed analysis labelled as model output, with the deterministic artifact
     unchanged;
   - exactly one `studio.turn.metrics` line per turn with `modelCalls >= 1` and a non-null
     `settledUsd`; no prompts, answers, tokens or URLs in any log line;
   - `studio.budget.alert` appears at 80% utilization (`warning`) and at 100% (`exhausted`).
5. Record evidence in the activation package: timestamp, deployment id, settings readback, audit row
   id, one metrics line, and the observed settled cost.

## Failure and rollback

| Situation                        | Action                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| Credential missing or invalid    | turn stays deterministic and reports the safe model-unavailable code; fix the env + redeploy |
| Model call over budget / ceiling | admission refuses before the call; no provider request is made                               |
| Cost or quality surprise         | PATCH `ai: null` (audited) and unset `CONVERSATION_STUDIO_AI_ENABLED`, redeploy              |
| Provider incident                | same as above; the deterministic workflow does not depend on the model                       |
| Key rotation                     | update `OPENCODE_GO_API_KEY`, redeploy; reservations in flight settle at their pinned price  |

Commitments already reserved are not refunded by disabling AI; the budget cap is cumulative by design.

## Verification commands and gates

- `pnpm eval:live` — gated live eval; without the explicit opt-in it reports **blocked** and sends
  **0** provider requests, which is the evidence that live AI is off by default.
- `pnpm --filter @wukong/web test` / `pnpm typecheck` / `pnpm lint` — settings schema, admission,
  budget-alert and observability tests are the local proof; the PR that changes any of this runs the
  full CI gate.
- Read-only preflight (`scripts/studio-activation.mjs --preflight`) confirms the workspace row and the
  last activation posture; it does not call the model.

## What this does NOT decide

The first live-model verification remains pending; configured settings and a Ready deployment alone
do not prove a successful provider request. The operator separately authorized the pilot's role
change from `operator` to `admin` on 2026-11-14, recorded by audit
`6d18556b-9e71-4cd7-90c6-d02994735d23`. External MCP was explicitly deferred for this pilot and stays
disabled. No live Studio model request has been verified in this session.
