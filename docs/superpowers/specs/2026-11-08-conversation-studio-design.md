# Conversation Studio, MCP tools and skills design (2026-11-08)

Status: **design for review**. This document is research plus a written specification. It does not
authorise product code, a schema migration, provider activation, an external MCP connection, a
deployment or a Git push. The paired implementation plan is
`docs/superpowers/plans/2026-11-08-conversation-studio.md`.

## Problem

The live runtime (`https://wukong-ecommerce-os.vercel.app`) is an evidence-first catalog operations
app: Workbench, Catalog, Imports, Exports & results, plus tools; a listing state machine
(`packages/core/src/workflow.ts`), a review/confirmation ledger, SHOPLINE projection, and an audit
port on every domain mutation. Every workflow has its own screen, and the operator has to know
which screen and which fields.

The product direction the user selected on 2026-11-08 is the "commerce orchestration" framing
published at `https://wukong-commerce-orchestration.lovable.app`: an AI operating system with eight
agent roles (listing, image, content, category mapping, supplier, customer service, SEO/Merchant,
logistics) entered through conversation. The interaction reference is Ads Copilot
(`https://ads-copilot-alpha.vercel.app`): a persistent conversation space, task templates, a visible
tool-execution trace, evidence tables, honest `null`/`—` instead of `0`, and report artifacts that
cannot be published until signed off.

The repo has none of that machinery today. A source audit on 2026-11-08 found no chat, thread,
streaming, MCP or skill code: the single model client always sends `stream: false`
(`packages/ai/src/typed-json-completion.ts`), and the nearest analogue is the listing-run surface,
which is a server shell plus panels polling read routes
(`apps/web/app/(app)/dashboard/page.tsx`, `apps/web/app/api/listings/[id]/runs/[runId]/route.ts`).
Building a chat UI over unconstrained model calls would break the rules this repo is built on:
workspace scoping from the session only, forced RLS, an audit event on every mutation, prompt
version pinning, untrusted model input, and human approval before consequential writes.

So this design adds a conversation surface that is an **orchestrator over existing services**, not
a second runtime and not a bypass.

## Evidence baseline (checked 2026-11-08, Asia/Singapore)

| Reference                                                                         | What was observed                                                                                                                                                                                                                                                                                                                                                                                                    | Confidence                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `https://github.com/YNWAforever/wukong-ecommerce-os`                              | HTTP 404 anonymously. The local checkout's `origin` is the same URL, so the repository is private or renamed; public state cannot be established.                                                                                                                                                                                                                                                                    | Observed 404; repo visibility unverified |
| `https://wukong-ecommerce-os.vercel.app/signin?callbackUrl=%2F`                   | Live sign-in. Public copy: "CATALOG OPERATIONS OS", 71 SHOPLINE template columns, 8 editable content fields, 0 direct SHOPLINE writes, invite-only workspace membership, approval gates, production direct writes disabled.                                                                                                                                                                                          | Observed                                 |
| `https://wukong-commerce-orchestration.lovable.app/`                              | Static marketing landing (Vite bundle, 140 KB HTML): "悟空電商 AI Operating System", 8 pain × 8 agents, five-step workflow layer, data/knowledge platform, HK$299/799/1999 tiers, scripted draft-workspace demo. No runtime, API or authentication observed.                                                                                                                                                         | Marketing-only; not product evidence     |
| `https://ads-copilot-alpha.vercel.app`                                            | `/` and `/admin` redirect to `/login`; `/login` is a Google-workspace sign-in page. Every other probed route returns 404. Post-login behaviour was **not** observed from this environment.                                                                                                                                                                                                                           | Auth-gated; unverified after login       |
| Four operator-supplied screenshots (`Desktop\ad copilot.png` … `ad copilot3.png`) | Left rail (new conversation, overview, conversations, reports, settings, recents), space switcher, composer with attachments, per-step execution trace ("17 個工具" with scope sub-lines), conclusion-first answers, evidence table (`檢查`/`結果`), explicit nulls, weekly report artifact with `待簽` → `標記為可發佈`.                                                                                            | UI reference only; not interacted with   |
| Wukong source baseline                                                            | Branch `claude/production-recovery-spec`, HEAD `a12ad1c5`. 56 SQL files in `packages/db/drizzle/`, numbers `0000`–`0053` (duplicate `0008`/`0015` prefixes); latest number is `0053`. No chat/thread/MCP/skill/streaming code.                                                                                                                                                                                       | Observed                                 |
| Sibling implementations                                                           | Aiso ships a Conversation Studio (two tables, deterministic saved reply plus a separately labelled live card, one-shot 20 s live call, durable weekly quota, honest coverage); BuyerOS has an approved design for versioned skill playbooks plus a hosted MCP provider; Adfocate/KOCmax and KinnsoOS have conversation-studio designs. None contains a Wukong-hosted MCP server or a versioned skill implementation. | Reference, not dependency                |

Research notes with file:line evidence are retained locally (gitignored) at
`.superpowers/brainstorm/20261108-wukong-conversation-studio/research/{aiso-studio,skills-mcp,wukong-audit}.md`.

## Decisions (user, 2026-11-08)

- **Conversation Studio becomes the new primary operator surface.** It is not a side panel and not a
  customer-service flow builder. Existing Workbench/Catalog/Imports/Exports screens are preserved and
  remain reachable; the preservation matrix is part of acceptance.
- **Extend the existing application.** `apps/web` (Next.js 16 App Router), the existing Postgres
  schema/RLS, the existing queue/Worker and the existing deployment identity are kept. No new app,
  no framework migration.
- **Deliver both MCP planes.** Wukong hosts an MCP server exposing typed read/propose tools, and it
  may consume administrator-approved external MCP servers. Versioned skill playbooks map the agent
  catalogue onto existing domain services.
- **Deliverable order:** this design, the paired implementation plan, and a static visual concept
  come first. Product code, migration, activation and deployment need separate explicit approval.
- **Ads Copilot is an interaction reference only.** Do not copy its visual identity, palette or
  brand voice.
- **No autonomous consequential action.** Model output is a validated proposal. Canonical writes
  remain human actions through existing services and approval gates.

## Goal and success criteria

1. An operator can open Studio, ask a question in Traditional Chinese or English, and receive an
   answer assembled deterministically from workspace records, with per-source coverage and evidence,
   **without any model call**.
2. When a model is configured, its analysis is a separately labelled card that cites the evidence
   pack; it cannot introduce facts absent from the pack, and its absence degrades gracefully
   ("Live model not configured — records answer shown").
3. At least four skills are live behind the skill registry (catalog finding, listing-draft dispatch,
   catalog gap review, merchant/SEO audit). The remaining agent roles appear as `planned` or
   `blocked`, never as fake entry points.
4. Threads, messages, runs, trace events and outputs survive reload. A failed or unknown run is
   distinguishable from success and is never silently re-dispatched.
5. Proposals and reports are versioned artifacts with as-of time, scope and sign-off state. No
   canonical write happens from the Studio except an explicit user dispatch through an existing
   route.
6. The Wukong-hosted MCP server exposes the same typed tool registry to an allowlisted client, using
   workspace-scoped tokens; every call is audited; no write tools are exposed.
7. External MCP consumption is administrator-approved, credential-owned server-side, allowlisted and
   disabled by default.
8. Every new mutation writes an audit event; `audit:verify` reports `0` missing actions and `0`
   accessible foreign records with the new tables in `TENANT_TABLES`; every new tenant table has
   `ENABLE` + `FORCE` RLS and the workspace policy.
9. All Studio copy has zh-Hant/en parity; no horizontal overflow at 390 px; keyboard, focus,
   reduced-motion and contrast floors hold.
10. Global and per-workspace flags default off, and every existing route still works with the
    feature off.

**Failure conditions** (release-blocking): UI-only chat; invented facts or numbers; any
cross-workspace read or write; duplicate or unlabelled paid dispatch; a "completed" state before the
output is saved and read back; model output applied without a human action; a `planned` capability
rendered as if it worked.

## Constraints

- Workspace scoping is the security boundary. The workspace and actor come from
  `authSessionContext` (`apps/web/lib/session-context.ts`); data access goes through
  `db.forWorkspace(workspaceId, …)`, which sets the `app.workspace_id` GUC
  (`packages/db/src/client.ts`), and Postgres RLS is forced on tenant tables. No request body, tool
  argument, model output or MCP caller may name a workspace.
- Every domain mutation writes an audit event through the `AuditWriter` port
  (`packages/core/src/audit.ts`). `audit:verify` (`packages/db/src/cli/audit-verify.ts`) must list
  every new tenant table.
- Prompt text changes bump a version constant; accepted operations pin it
  (`packages/core/src/listing-prompt-versions.ts`). Studio prompts get the same discipline under a
  new `STUDIO_PROMPT_VERSIONS` constant. Nothing in this phase changes the listing pipeline's
  prompts, so no web/Worker prompt-version coupling is introduced.
- Model input is untrusted data: system instructions say to ignore instructions inside it, source
  material goes in the user turn as JSON, and output passes server-side schema and grounding
  validation. Tool output, prior messages, attachments and MCP responses are untrusted too.
- SHOPLINE writes stay disabled in production; this design adds no write path. `shopline-real-publish`
  remains `blocked` in the capability registry.
- New outbound network destinations require an allowlist and a credential-ownership decision; no
  user-supplied MCP endpoint or credential is accepted.
- Logs stay single-line JSON with IDs only — no prompts, model output, customer content, signed URLs
  or credentials. Trace content lives in database rows, not logs.
- Migrations are additive, numbered `0054` onward, and run before the code that reads them deploys.
- UI uses plain CSS custom properties and kebab-case class names; no Tailwind, shadcn, Radix or new
  UI dependency. Bilingual copy uses `localized(locale, zh, en)` from `apps/web/lib/ui-copy.ts` and
  the locale cookie, not `next-intl`.

## Section 1: Product model

### 1.1 Five layers

```
operator intent / template
        │
        ▼
   skill (versioned playbook) ── selects ──▶ tool plan (typed, allow-listed)
        │                                        │
        ▼                                        ▼
 evidence pack (canonical records, coverage) ◀── tool results
        │
        ▼
 validated reply + proposals + outputs (deterministic + optional labelled model)
        │
        ▼
 human action: open existing screen / dispatch existing workflow / accept artifact
```

The orchestrator is a **dispatcher and evidence assembler**. It does not own listing state, approval
or publishing; it reads them and links to them.

### 1.2 Agent catalogue → Wukong skills and tools

The eight agents are a product vision (marketing page), not shipped capability. The mapping below is
a proposal; "v1" is what the first implementation phase delivers.

| Lovable agent        | Wukong skill (proposed id)   | Tools over existing surfaces                                                                 | Output / destination                                                                  | v1 status           |
| -------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------- |
| 悟空上架 Agent       | `listing.draft_from_sources` | `catalog.search`, `assets.list`, `listing.create_draft` (dispatch), `listing.get_run_status` | dispatch to existing `/api/listings` + queue; operator reviews in the existing screen | **pilot**           |
| 圖片處理 Agent       | `product_shot.prepare`       | `assets.list` (executable read), `product_shot.dispatch` (existing gated flow)               | prepared handoff (source ids + persisted review state); nothing processed in Studio   | **pilot** (v1.1.0)  |
| 內容生成 Agent       | `listing.copy_proposal`      | `catalog.get_listing`, `quality.get_gaps`; output proposal only                              | versioned copy proposal artifact with evidence; operator opens the existing editor    | planned (phase 3/4) |
| 分類映射 Agent       | `category.map_proposal`      | `catalog.search`, platform taxonomy data (new read model)                                    | mapping proposal with confidence; applied in existing catalog flow                    | planned             |
| 供應商情報 Agent     | `supplier.intel_proposal`    | `workbook_imports.list`, `website_products.list`                                             | field-level supplier proposal; reviewed save                                          | planned             |
| 客服自動化 Agent     | `customer.reply_draft`       | none (no inbox data source in Wukong)                                                        | must render as `blocked`; no fake inbox                                               | **blocked**         |
| SEO / Merchant Agent | `merchant.audit`             | `catalog.list`, `quality.get_gaps`, `shopline.projection_preview`                            | report artifact with evidence table, as-of time, sign-off state                       | **pilot**           |
| 物流營運 Agent       | `logistics.followup`         | none (no order/shipment data source)                                                         | must render as `blocked`                                                              | **blocked**         |

Two additional read skills round out v1: `catalog.find` (find/explain listings, quality and jobs from
records) and `catalog.gap_review` (which listings block approval/export and why). These are the
lowest-risk, highest-value starting points and prove the deterministic-first model.

A skill's availability is a property of its definition (`pilot`, `planned`, `blocked`) and is shown
on the template card before the first send. Natural-language requests and template cards enter the
same skill engine: the planner may select a skill or ask for missing inputs, but the server — not the
model — decides what runs.

### 1.3 What "orchestration" means here

It orchestrates existing domain services and bounded reads. It is not a general workflow builder, not
an autonomous agent host, and not a replacement for the listing state machine or approval ledger.
The extension points (durable studio runs, external MCP providers, more skills) are designed but not
all delivered in v1.

## Section 2: User experience

### 2.1 Surfaces and navigation

| Route                  | Purpose                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `/studio`              | Conversation home: deterministic overview, composer, template cards, recent threads |
| `/studio/t/[threadId]` | One thread: question, trace, record answer, model card, evidence, outputs           |
| `/studio/threads`      | All conversations, searchable, grouped by recency                                   |
| `/studio/outputs`      | Saved proposals and reports with version, as-of and sign-off state                  |
| `/studio/connections`  | Tools and MCP: hosted token status, external connections, availability labels       |
| `/studio/settings`     | Admin/owner: workspace Studio enablement, budgets, skills, tokens                   |

A "Studio" primary nav item is added ahead of Workbench when the feature is enabled for the
workspace; every existing item stays. Making Studio the post-sign-in home is a **separate flag**
(`CONVERSATION_STUDIO_DEFAULT_HOME`, default off) so the pilot can roll back to `/dashboard`
without data loss. This mirrors Aiso's default-home rollback and keeps the old workbench reachable.

Desktop layout: existing top bar and shell, with a Studio rail (≈200 px) listing "New conversation",
nav, and recent threads, plus the thread pane. The evidence/output inspector is a right-hand drawer
(desktop) or a separate view (mobile). Mobile (≤620 px): rail collapses; "Conversations" and
"Tools" become segmented views; the composer stays sticky. No horizontal overflow at 390 px.

### 2.2 Conversation home

- **Deterministic overview strip (no model call).** Counts and states from records only: open blocking
  flags, listed-but-unapproved drafts, failed jobs awaiting attention, quality gaps, last import and
  last export attempt with their state. Each tile deep-links to the existing screen. Copy states the
  rule: "From workspace records; no AI call." This follows the Ads Copilot overview pattern
  (snapshot numbers, no model) and Aiso's saved-composition rule.
- **Composer** with attach affordance (existing presigned asset flow), locale-aware placeholder, and
  a permanent disclaimer: "AI may be wrong; verify important numbers." (`AI 可能會出錯；重要數字請先核對。`)
- **Template cards** for the eight roles: label, one-line outcome, expected output, honest
  availability (`Ready`, `Pilot`, `Planned`, `Unavailable`), and each skill's own limitation line.
  A card fills the composer, focuses it, and does not send (Aiso behaviour). Unavailable cards are
  not clickable and say why.
- **Recent conversations** with relative times and derived skill tags.

### 2.3 Thread anatomy

1. Operator turn (text and/or selected attachments and an optional skill chip).
2. Execution trace, collapsed by default: "Execution trace · N steps". Each step shows only what the
   turn actually requested, with status (`done`, `running`, `unavailable`, `blocked`) and a scope
   sub-line (e.g., "Catalog · workspace scope", "Listing `…` · version 7"). A failed read is never
   `done`.
3. **"From your records"** — deterministic answer composed from the evidence pack: conclusion first,
   then a `check → result` table, then coverage chips (`present`, `missing`, `unsupported`). Missing
   is never `0`; unsupported is never "not connected". Every claim links to its source row.
4. **"AI suggestion · unverified"** — only when a live model is configured and the skill allows it.
   Separate visual treatment, per-claim citations into the evidence pack, explicit limitation line,
   and no write authority. If the provider fails, this card says so while the records answer stays.
5. **Outputs** — proposal or report cards with version, as-of time, scope, sign-off state, and
   actions: open in the existing screen, save artifact, copy link. In v1, "approve"/"publish" acts
   never occur inside Studio; actions deep-link to the existing approval/publish screens.
6. At most one clarifying question per turn, with named branches (Ads Copilot pattern), plus
   follow-up chips.
7. Composer with stop-at-navigation semantics only in v1 (no token streaming); a failed send keeps
   the draft and offers retry with the same client message key.

### 2.4 Honest states

| State                       | UI                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Workspace Studio disabled   | "Studio is not enabled for this workspace." + where an admin enables it            |
| Sky-level flag off          | Nav item absent; direct route 404                                                  |
| Model not configured        | Records answer shown; AI card replaced by "Live analysis is not configured"        |
| Evidence missing            | Coverage chip `missing` + next action ("open import", "run quality review")        |
| Run failed                  | Error category + retry affordance; no fabricated answer                            |
| Run outcome unknown         | Explicit "we do not know whether the provider charged or completed"; no auto-retry |
| Quota/budget exhausted      | Remaining count + reset time; paid actions disabled                                |
| Skill `planned` / `blocked` | Card non-interactive with reason (no data source, disabled capability)             |
| Foreign thread id           | 404, never 403 (ids reveal nothing)                                                |

### 2.5 Bilingual and accessibility

Copy lives in `apps/web/lib/studio-copy.ts` as bilingual tuples, with parity tests over every key.
Prompts are English instructions with the operator's locale passed explicitly so answers are written
in zh-Hant or English as requested. A11y floors: 12 px minimum text, 44 px targets, visible 3 px
focus ring, semantic lists for the trace, `aria-live` for run status only (not streamed text),
reduced-motion respected. Acceptance matrix: en/zh-Hant × 1440/900/390 × home, thread, outputs,
connections, settings.

### 2.6 Visual concept

A static, fictional-data concept is stored (gitignored) at
`.superpowers/brainstorm/20261108-wukong-conversation-studio/concept/` — `index.html`, `css/studio.css`
and `README.md`. It covers conversation home, an active thread (trace, evidence, review cards,
output card), connections & tools, and states/edge cases including a 390 px specimen. The README
records what is derived from the repo, what is mocked, and what is not included. Static validation
passed (no external assets/network, balanced markup and CSS, no duplicate ids, 390/1440 breakpoints,
focus and reduced-motion rules); rendered visual review by a browser was blocked in this environment,
so the concept is a design aid awaiting the user's visual review — not implementation and not
acceptance evidence.

## Section 3: Architecture

### 3.1 Components

```
apps/web
  app/(app)/studio/**                 pages (server components: session + workspace + flag)
  app/api/studio/**                   route handlers (factory + withRouteErrors)
  app/api/mcp/route.ts                hosted MCP endpoint (Node runtime, bearer token)
  components/studio-*.tsx             client UI
  lib/studio/*.ts                     server services (evidence, skills, tools, runs, model)
  lib/studio-copy.ts                  bilingual copy

packages/core/src/studio/
  skill-definitions.ts                versioned skill manifests + zod schemas
  tool-registry.ts                    tool ids, input/output schemas, role, cost class
  evidence-pack.ts                    evidence types, coverage rules, composition helpers
  studio-prompt-versions.ts           STUDIO_PROMPT_VERSIONS constant
packages/db/src/
  schema.ts                           new tables
  repositories/studio*.ts             workspace-scoped repositories
  drizzle/0054_conversation_studio.sql
packages/ai/src/
  studio-model.ts                     StudioModel port + adapters (typed JSON, no streaming)
  studio-prompts.ts                   system/planner/composer prompts
  mcp-client.ts                       approved external MCP client (phase 5)
packages/jobs/src/                    no new queue in v1 (extension point documented)
apps/worker/                          unchanged in v1
```

### 3.2 Turn protocol (typed, non-streaming in v1)

Request (server-validated, `.strict()`): `threadId?`, `clientMessageId`, `text`, `skillKey?`,
`attachmentAssetIds?`, `locale`. Nothing names a workspace, role or model.

Server order (the gate order every sibling design converges on):

1. Feature flag (global and workspace) — before auth, SQL or provider dispatch.
2. Session/workspace from `authSessionContext`; role check for the requested action.
3. Thread ownership/visibility check inside `forWorkspace`; foreign id → 404.
4. Skill resolution: pinned definition version; requested skill must be `pilot`/live and allowed for
   the workspace; otherwise planner (model if configured, deterministic keyword routing otherwise)
   may propose at most one skill and must collect missing inputs.
5. Admission: budget class reservation (USD, fixed reviewed ceiling), quota, provider readiness.
6. Evidence pack assembly through the tool registry (read tools only in this phase), bounded steps
   and deadline; each step persisted as a run event.
7. Deterministic reply composition. Always produced.
8. Optional model analysis (single call, bounded output, schema-validated, citations must resolve to
   pack refs; ungrounded claims rejected). Failure degrades to step 7 only.
9. Persist assistant message, run result, trace events and any proposed outputs in one transaction;
   write audit events for thread/run/output mutations.
10. Respond with the composed turn. No token streaming, no SSE in v1.

Why no streaming: there is no streaming precedent in the repo (`stream: false` is the only AI call
shape), `withRouteErrors` buffers a `Response` and has no streaming branch, and the readiness gate
forbids logging model deltas. Streaming is listed as a later decision, not a hidden implementation
detail.

Bounds: turn deadline 45 s server-side (model calls 25 s each, max 2 calls); at most 6 tool steps;
max 64 KiB request; bounded evidence excerpts; no automatic retry of any provider or tool call; a
lost/ambiguous provider response is `outcome_unknown` and keeps its budget hold.

### 3.3 Evidence engine

`EvidencePack` (persisted as part of the run, referenced by the reply):

- `sources[]`: `{ kind, refId, version|digest, label, asOf, coverage, excerpt?, deepLink }` where
  `kind ∈ listing | catalog | quality | source_import | export_attempt | job | audit | website |
workbook | shopline_projection`. Excerpts are bounded and never contain credentials or signed URLs.
- `coverage`: per expected-source-kind `present | missing | unsupported`.
- `checks[]`: deterministic `check → result` rows used by the evidence table.
- Revocation: every read re-resolves the source through the workspace repository; a source that was
  removed is marked `restricted` and its excerpt is not rendered or exported.

Deterministic composers per skill produce the "From your records" part and the `checks` table from
the pack; they never format estimates as facts. This is the Aiso saved-composition rule adapted to
Wukong records. Composition returns copy keys + values, so the same counts render in either locale.

### 3.4 Model port

`StudioModel` (new, in `packages/ai`) with two typed operations:

- `plan(input): StudioPlan` — skill selection (>= confidence), missing inputs, at most 3 tool
  requests from the skill's allowlist, one clarifying question. Zod-validated, unknown tool or
  out-of-allowlist request is rejected server-side (not retried with the same prompt).
- `compose(input): StudioAnalysis` — answer sections, claim list each with `evidenceRef` ids,
  limitation line, follow-up suggestions. Every claim must resolve to a pack ref; unresolved claims
  are dropped and counted.

Implementation reuses the reviewed `TypedJsonCompletionClient` plumbing (OpenAI-compatible,
`stream: false`, provider/model/timeout/usage observer) and supports its two backends in v1,
`openrouter` and `opencode-go`; `openai`-backed Studio models are a later reviewed addition because
that path uses a different provider class. Provider and model selection is a **new reviewed entry**,
not an unlisted model: the Studio budget class must name the reviewed `provider:model` pair from the
existing cost registry (`packages/core/src/paid-listing-policy.ts`) and fail closed on an unknown
pair. `STUDIO_PROMPT_VERSIONS` pins planner/composer prompts; in-flight
runs store the pinned versions. Model input is untrusted; system prompts carry the ignore-instructions
rule used by the listing and wine prompts.

### 3.5 Tool registry and internal tools

One TypeScript registry is the source of truth for both the internal agent loop and the hosted MCP
server. Every tool declares: `id`, bilingual label, zod input/output schema, `kind`
(`read | propose | dispatch`), minimum role, cost class (`free`, `model`, `paid`), capability-registry
id, and a bounded result size. Server code executes tools; the model only requests them by id with
validated JSON arguments.

v1 tools (all workspace-scoped through `forWorkspace`):

| Tool                     | Kind     | Wraps                                                                           |
| ------------------------ | -------- | ------------------------------------------------------------------------------- |
| `catalog.search`         | read     | catalog repository search/page                                                  |
| `catalog.get`            | read     | listing detail + active version summary                                         |
| `quality.get_gaps`       | read     | quality projection / gap computation                                            |
| `imports.list`           | read     | workbook imports and source imports                                             |
| `exports.get`            | read     | export attempts + reconciliation state                                          |
| `jobs.list`              | read     | jobs ledger read route logic                                                    |
| `assets.list`            | read     | source assets for a listing                                                     |
| `listing.get_run_status` | read     | existing listing pipeline run read                                              |
| `listing.create_draft`   | dispatch | existing `POST /api/listings` service path, only after explicit UI confirmation |
| `listing.propose_copy`   | propose  | creates a studio output artifact; no canonical write                            |

No tool exposes raw SQL, arbitrary URL fetch, credentials, signed URLs or unbounded pagination.

### 3.6 Skill registry and versioning

Skill definitions are code, not user data: `packages/core/src/studio/skill-definitions.ts`, validated
by zod, reviewed by PR like any code change. Shape (adapted from the approved BuyerOS contract):

```
SkillDefinition {
  key, version, status: pilot|planned|blocked, title/outcome/limitation (bilingual),
  inputs / optionalInputs (zod), allowedTools: ToolId[], outputKind,
  evidence: { requiredSources, anchors, unknownsPolicy },
  budgetClass: fixed reviewed USD reservation snapshot,
  completion: server predicate (schema + evidence + saved readback [+ human review]),
  upstream?: { source, commit, pathHash, licence }   // only for adapted playbooks
}
```

Rules: in-flight runs pin the definition version, prompt versions and tool allowlist; a definition
change while a run is active cannot widen its permissions; the registry cannot grant a capability an
operator's role lacks; a `planned`/`blocked` skill cannot execute even if a request names it;
activation of a new skill version is an audited admin action. No dynamic installation, no
user-authored prompts or tools in v1.

### 3.7 Hosted MCP server

- **Host:** `apps/web/app/api/mcp/route.ts` (Next.js Node runtime). Vercel is chosen because token
  authentication, workspace resolution and the repositories already live there; hosting it on the
  Worker would duplicate auth and DB access. Same-host limitation: no long-running stream, one
  bounded request per tool call.
- **Transport:** MCP Streamable HTTP, JSON responses (no server-initiated SSE stream in v1).
  Supported methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
  Unknown method ⇒ JSON-RPC `-32601`; malformed body ⇒ `-32600`; auth failure ⇒ HTTP 401 with a
  JSON-RPC error body.
- **Auth:** `Authorization: Bearer wuk_…` workspace token, stored only as SHA-256 hash + prefix, with
  scopes (`read`, `propose`), created/revoked by admin/owner, audited, `last_used_at` updated. The
  token row supplies workspace and actor; tool arguments can never supply them. Tokens are scoped
  to one workspace and never grant a role above the creator's role at call time.
- **Tools:** the same registry subset with `kind ∈ read|propose` and capability ids; `dispatch` tools
  are not exposed in v1. Every call writes a content-free `studio_mcp_calls` row and an audit event
  (tool, args digest, outcome, duration); argument values are audited only as a digest.
- **Limits:** request ≤ 64 KiB, one call per request, 20 s deadline, per-token and per-workspace
  quotas (table-backed counters), no pagination beyond the tool's fixed cap, no writes.
- **Gating:** `STUDIO_MCP_SERVER_ENABLED` (default off) plus the workspace flag; pilot connects one
  internal client first.

### 3.8 External MCP consumption

- Registry table `studio_mcp_connections`: label, endpoint URL (fixed HTTPS origin, no redirects),
  transport, tool allowlist (pinned names + schema hashes), status (`draft | approved | disabled`),
  credential envelope (AES-GCM, `v1.<iv>.<ct>` format), generation counter, created/approved by,
  timestamps.
- Credential ownership: workspace-admin-owned binding, assigned to the workspace; never per-user
  OAuth in v1 and never a developer's session. Encryption uses a **new** key
  `STUDIO_MCP_ENCRYPTION_KEY` so SHOPLINE token rotation stays independent; decryption happens
  server-side only and only inside the MCP client call.
- Allowlisting: fixed endpoint, tool-name allowlist, advertised-schema hash re-validated at
  activation (unknown required-field drift fails closed), response projection allowlist (defined
  fields only; raw payloads not retained).
- Bounds: 64 KiB decoded response, 12 s deadline, no retry, no auto-pagination; untrusted output
  enters the evidence pack as a labelled `external` source with retrieval time and provider name.
- **v1 ships the registry, admin UI, client and tests; external connections stay `disabled`.**
  Turning one on requires an explicit user decision plus credentials. Wrapping existing direct
  adapters (Tavily, Photoroom, SHOPLINE) in MCP is not automatically justified; the direct adapters
  stay as they are.

### 3.9 Persistence model

One additive migration `0054_conversation_studio.sql`, plus Drizzle declarations and workspace-scoped
repositories. Every table: `workspace_id text NOT NULL REFERENCES workspaces(id)`, composite
`(workspace_id, id)` unique index, `ENABLE` + `FORCE` RLS with the standard workspace policy, and
grants to `wukong_app` limited to the operations the feature needs.

| Table                        | Purpose and key invariants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studio_threads`             | `id`, `workspace_id`, `visibility ('workspace'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 'private')`, `created_by`, `title`, `skill_key`, `status ('open' | 'archived')`, `last_message_at`, timestamps. Index `(workspace_id, last_message_at desc)`; 200 threads per workspace cap enforced in SQL/service |
| `studio_messages`            | append-only; `thread_id`, `sequence > 0`, `role ('operator'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 'assistant'                                                      | 'system'                                                                                                                                         | 'tool')`, `content jsonb`bounded ≤ 64 KiB,`client_message_id`unique per thread (idempotent send),`run_id?`, `created_by`, `created_at`; unique `(workspace_id, thread_id, sequence)` |
| `studio_runs`                | one per assistant turn execution: `trigger_message_id`, `status ('queued'                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 'running'                                                        | 'succeeded'                                                                                                                                      | 'failed'                                                                                                                                                                             | 'cancelled'                                                                                                                                          | 'outcome_unknown')`, `skill_key`, `skill_version`, `provider`, `model`, `prompt_versions jsonb`, `context_digest`, `idempotency_key`, `input_tokens/output_tokens`, `estimated_cost_usd numeric(14,6)`, `reserved_usd/settled_usd`, `error_code`, `started_at/finished_at`; unique `(workspace_id, idempotency_key)` |
| `studio_run_events`          | append-only ordered trace: `run_id`, `sequence > 0`, `kind ('tool'                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 'model'                                                          | 'evidence'                                                                                                                                       | 'notice'                                                                                                                                                                             | 'error')`, `tool_id?`, `state`, `payload jsonb`bounded,`duration_ms`, `created_at`; unique `(workspace_id, run_id, sequence)`; update/delete revoked |
| `studio_outputs`             | artifact identity: `kind ('copy_proposal'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 'gap_report'                                                     | 'merchant_audit'                                                                                                                                 | 'finding')`, `title`, `status ('draft'                                                                                                                                               | 'saved'                                                                                                                                              | 'signed_off'                                                                                                                                                                                                                                                                                                         | 'discarded')`, `current_version int`, `run_id?`, `thread_id?`, timestamps |
| `studio_output_versions`     | immutable versions: `output_id`, `revision > 0`, `payload jsonb` bounded, `content_digest ^[a-f0-9]{64}$`, `as_of`, `scope jsonb`, `created_by`, `created_at`; unique `(workspace_id, output_id, revision)`; update/delete revoked                                                                                                                                                                                                                                                                                                              |
| `studio_budget_reservations` | `run_id` unique, `pricing_version`, `reserved_usd`, `settled_usd`, `state ('reserved'                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 'settled'                                                        | 'released'                                                                                                                                       | 'uncertain')`; FK to run with `ON DELETE RESTRICT`                                                                                                                                   |
| `studio_workspace_settings`  | one row per workspace (PK `workspace_id`): `enabled bool default false`, `allowed_skills text[]`, `monthly_budget_usd numeric`, `run_ceiling_usd numeric`, `retention_days int`, `default_home bool default false`, `ai_provider text`, `ai_model text`, `pricing_version text`, `max_input_tokens int`, `input_usd_per_million numeric`, `output_usd_per_million numeric`, `max_output_tokens int`, `updated_by`, timestamps. The `ai_*` columns are NULL when no live model is configured; the model admission path fails closed in that case |
| `studio_mcp_connections`     | external connections (§3.8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `studio_mcp_calls`           | append-only call ledger: `run_id?`, `connection_id?`, `tool_name`, `request_digest`, `response_digest`, `status`, `error_code`, `latency_ms`, `caller ('agent'                                                                                                                                                                                                                                                                                                                                                                                  | 'external_mcp')`, `created_at`                                   |
| `studio_api_tokens`          | hosted-MCP tokens: `workspace_id`, `label`, `token_hash` unique, `prefix`, `scopes text[]`, `created_by`, `revoked_at?`, `last_used_at?`, timestamps. No plaintext token column                                                                                                                                                                                                                                                                                                                                                                 |

Audit actions added (examples): `studio.thread.created`, `studio.message.received`,
`studio.run.started`, `studio.run.completed`, `studio.run.failed`, `studio.output.saved`,
`studio.output.signed_off`, `studio.settings.updated`, `studio.mcp.connection.approved`,
`studio.mcp.token.created`, `studio.mcp.token.revoked`, `studio.mcp.call`. New tables go into
`TENANT_TABLES` in `packages/db/src/cli/audit-verify.ts` in the same change.

Retention: thread content is workspace data. v1 retains while the workspace exists and exposes an
admin export/delete path later; `retention_days` is stored but not enforced until the retention task
is approved. No content is copied into logs.

### 3.10 Execution classes and dispatch

- **Interactive turn (v1):** inside the web request, bounded as §3.2. The only paid activity is at
  most two model calls under a fixed reviewed budget class.
- **Dispatch action (v1):** an explicit operator click on a proposal card calls an existing service
  path (the intake logic currently embedded in the listings route is extracted into a service first;
  the route handler is rewired to it with unchanged behaviour). The Studio stores the returned
  job/run reference and polls the existing run read route; it does not run domain work in the model
  loop.
- **Durable studio run (deferred):** if a skill later needs Worker-length work, add a
  `studio-queue` contract and consumer with the existing lease/idempotency rules. v1 adds no queue
  message, no Worker change and therefore no new web/Worker deploy coupling.

### 3.11 Cost, quota and failure accounting

- USD only, fixed reviewed budget class per skill (mirrors `wineOperationBudget` /
  `paidListingReservation` discipline; the hold rounds **up** to 6 dp and unknown pricing fails
  closed).
- Admission checks `studio_workspace_settings.monthly_budget_usd` against settled + reserved,
  reserves before dispatch, settles actual usage once, releases only known-unused liability.
- Unknown/failed attempts stay charged (Aiso rule); no automatic retry. `outcome_unknown` retains
  the hold and requires operator reconciliation.
- The overview strip and all reads are free and never reserved. Only an explicit send with a live
  model reserves.

## Section 4: Roles and permissions

| Role       | Studio                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `viewer`   | Read workspace threads and saved outputs. Cannot send turns, create threads, or use tools                                             |
| `operator` | Create threads, send turns, run read skills; paid model use subject to workspace budget                                               |
| `reviewer` | Operator abilities; may sign off report artifacts (`signed_off`)                                                                      |
| `admin`    | Reviewer abilities; enable/disable Studio for the workspace, set budgets, manage skills activation, manage MCP connections and tokens |
| `owner`    | Admin abilities; cannot be locked out of Studio settings; token creation audited                                                      |

Server-side only: role is resolved from the membership record; hiding a nav item is UX, never a
security boundary. Foreign or invisible thread ids return 404. MCP tokens never grant a role above
their creator's current role.

## Section 5: Safety, tenancy and cost constraints the implementation must not break

1. Workspace and actor from the session only; `forWorkspace` + RLS as the second boundary; tool/MCP
   arguments cannot carry workspace or role.
2. Every Studio mutation writes an audit event; new tenant tables appear in `audit:verify`.
3. Model input and tool/MCP output are untrusted data: declaration, structural separation, strict
   output schema, citation grounding, then human action. No write tool exists.
4. Prompt versions are pinned per run; any prompt text change bumps `STUDIO_PROMPT_VERSIONS`.
5. No streaming, no deltas in logs; trace content is DB rows; single-line content-free logs.
6. No new outbound destination without allowlist + credential ownership; external MCP disabled by
   default; no user-supplied endpoints or credentials; new encryption key, not SHOPLINE's.
7. SHOPLINE writes remain disabled; Studio adds no publish path; capability registry entries change
   in the same PR as the real state.
8. Feature flags default off; migrations are additive and deploy before dependent code.
9. Cost is bounded, reserved and settled; unknown cost fails closed; no auto-retry of paid calls.
10. Preservation: every existing route, role and deep link keeps working with Studio off.

## Section 6: Failure and recovery states

| State                | Meaning                                              | Behaviour                                                                            |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `needs_input`        | Skill needs a required input                         | One clarifying question with branches; no provider call                              |
| `queued` / `running` | Turn in progress                                     | Trace shows steps; navigation allowed; no second send for the same client message id |
| `succeeded`          | Reply + outputs persisted                            | Readback available after reload                                                      |
| `partial`            | Some sources `missing`/`unsupported`                 | Answer states coverage; next action offered                                          |
| `failed`             | Deterministic failure (validation, provider refusal) | Error category + retry; nothing invented                                             |
| `cancelled`          | Request aborted before completion                    | No partial assistant message persisted                                               |
| `outcome_unknown`    | Provider/tool response lost                          | Hold retained, no re-dispatch, operator reconciliation                               |
| `quota_exhausted`    | Workspace/monthly cap reached                        | Paid actions disabled with reset time; reads still work                              |
| `unavailable`        | Model/connection/skill not configured                | Explicit notice; deterministic answer where possible                                 |

## Section 7: Rollout phases and acceptance

| Phase                        | Delivers                                                                                                                                | Gate                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| P0 (this document)           | Spec + implementation plan + visual concept                                                                                             | User review and approval                                         |
| P1 Foundation                | Migration 0054, schema, repositories, audit entries, flags, `/studio` shell with empty states, nav item                                 | Local typecheck/tests; migration replayed on disposable Postgres |
| P2 Deterministic studio      | Evidence engine, tool registry (read), `catalog.find` + `catalog.gap_review`, thread persistence, home overview, trace                  | Unit + integration + Playwright with model disabled              |
| P3 Model turns               | `StudioModel` port + fake adapter + composer/planner prompts, `listing.copy_proposal` output + review cards; honest model-off behaviour | Deterministic provider fixtures; no live provider call in CI     |
| P4 Dispatch + merchant audit | `listing.create_draft` dispatch with confirmation, `listing.get_run_status` polling, `merchant.audit` report artifact and sign-off      | Existing pipeline run read; no canonical write from model        |
| P5 MCP                       | Hosted MCP server + tokens + tool exposure; external MCP registry/client (disabled)                                                     | MCP protocol conformance tests; token scoping negatives          |
| P6 Hardening/release         | Budget/quotas, retention decision, a11y matrix, e2e, runbook, capability registry updates                                               | Release checklist; production activation separately authorised   |

Acceptance checks (each recorded `PASS`/`FAIL`/`BLOCKED`/`NOT_RUN` with revision and environment):

- Feature off: nav absent, `/studio` 404, every existing route unchanged; tests prove it.
- Deterministic answer on a workspace with no model: correct records, coverage, and honest
  "model not configured" notice.
- Model on: every claim resolves to an evidence ref; an ungrounded claim is dropped and surfaced as
  a limitation; a provider failure leaves the records answer intact.
- Thread/message/trace/output survive reload; duplicate send with the same client id is idempotent;
  two concurrent sends cannot double-reserve.
- Foreign thread, foreign output, foreign MCP token ⇒ 404/403 as designed; cross-workspace reads
  fail; RLS policies exercised through `wukong_app`.
- `audit:verify` reports 0 missing actions / 0 accessible foreign records including new tables.
- Hosted MCP: `initialize`/`tools/list`/`tools/call` work with a scoped token; wrong scope, revoked
  token, other workspace token and unknown tool all fail; every call leaves a ledger + audit row.
- External MCP disabled by default; enabling requires admin action with audit; tool/schema drift
  fails closed; timeout and oversized response are explicit failures.
- Budget: reservation admitted atomically under concurrency, settled once, unknown outcome keeps the
  hold, monthly cap enforced, pricing drift fails closed.
- zh-Hant/en copy parity and banned-claim tests pass; no horizontal overflow at 390 px; keyboard and
  focus behaviour verified; reduced-motion respected.
- Preservation matrix: every existing route reachable and unchanged for each role with Studio on.
- No prompts, model output, customer content, signed URLs or credentials in logs (readiness scan).

Metrics (after baseline): time to first usable answer, share of turns answered without a model,
ungrounded-claim rejection rate, output save/readback rate, run failure/unknown rate, cost per saved
output, operator correction rate.

## Out of scope

- Autonomous publishing, autonomous approval, or any SHOPLINE write from Studio.
- A customer-service inbox or WhatsApp send path; CS and logistics stay `blocked`.
- A general workflow builder, scheduled agents, or user-authored skills/prompts/tools.
- `next-intl`, Tailwind, shadcn, Radix or other UI-framework migration.
- Per-user OAuth for external MCP providers; credit-ledger pricing; FX conversion.
- Token streaming/SSE, voice, and multi-agent fan-out.
- Billing/plan entitlements and SKU tiers from the marketing page.
- Production activation, migration execution, deployment and Git push (separate authorisation).

## Risks

| Risk                                                    | Mitigation                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat becomes a second write path that bypasses approval | No write tools; dispatch only through existing routes with explicit confirmation; deep links for approve/publish; audit on every mutation         |
| Model invents facts or numbers                          | Deterministic records answer is the primary output; model card is separate and citation-grounded; ungrounded claims dropped; copy guardrail tests |
| Cross-workspace leakage via model/MCP arguments         | Workspace from session/token only; tool schemas reject tenant fields; every query through `forWorkspace` + RLS; negative tests                    |
| Paid-call leakage through "free" UI                     | Deterministic home and reads never reserve; explicit send only; fixed budget classes; fail closed on unknown pricing                              |
| Duplicate dispatch from retries/tabs                    | `client_message_id` + run idempotency keys; reservation unique per run; no automatic retry; unknown outcome held                                  |
| Prompt drift with the listing pipeline                  | Separate `STUDIO_PROMPT_VERSIONS`; no listing prompt changes in this phase; pinned per run                                                        |
| New tables weaken the audit gate                        | Add to `TENANT_TABLES` and audit actions in the same change; gate runs in CI/release                                                              |
| Secret custody for MCP credentials                      | New dedicated key, envelope format copied from the SHOPLINE vault, admin-owned binding, server-side decryption only; encryption tests             |
| MCP endpoint abused                                     | Token hashing/scopes/revocation, per-token quotas, no write tools, audit ledger, disabled by default                                              |
| Scope creep from the 8-agent marketing vision           | Explicit `pilot`/`planned`/`blocked` catalogue; acceptance checks that unimplemented agents render honestly                                       |
| Thread privacy expectations differ between operators    | `visibility` column and a review question; default proposal is workspace-visible read, creator-private archive                                    |
| JSONB content becomes a shadow record store             | Bounded payloads, evidence refs to canonical rows, no canonical state stored only in Studio                                                       |

## Open questions for review

Recommended defaults are in parentheses; each can be settled before the matching plan phase.

1. **Thread visibility.** Workspace members may read all threads, creator controls archive; private
   threads only if the user prefers (`private` column exists from P1).
2. **Approval inside Studio.** v1 deep-links to existing approval/publish screens; later, a
   server-revalidated in-chat approval may be added. (Deep links first.)
3. **Live-model default.** Model analysis off until the user configures a reviewed provider/model and
   budget (`CONVERSATION_STUDIO_AI_ENABLED=false` initially).
4. **Which external MCP first.** None in v1; first candidate is a read-only research provider, after
   credential ownership and terms review.
5. **Retention.** Retain with workspace; enforce `retention_days` only after an admin export/delete
   path is approved.
6. **Default home.** Studio becomes post-sign-in home only after pilot acceptance, behind
   `CONVERSATION_STUDIO_DEFAULT_HOME`.
7. **Report sign-off role.** Reviewer and above may sign off artifacts; publishing remains outside
   Studio.
8. **Wine/Opak specialisation.** First skills use generic catalog data; wine-specific evidence
   integration (wine stages/TypeSafe) is a later skill, not a v1 dependency.
9. **Billing/plan limits.** Not in v1; SKU quotas from the marketing page are not enforced.
10. **Thread branching.** Not in v1; "start a separate discussion from this answer" is a later
    addition (Aiso pattern).

## References

- `https://wukong-commerce-orchestration.lovable.app/` — product vision (marketing only).
- `https://wukong-ecommerce-os.vercel.app/signin?callbackUrl=%2F` — live product positioning and
  current safety copy.
- `https://ads-copilot-alpha.vercel.app/login` — interaction reference (auth-gated).
- `docs/product/ecommerce-os-product-plan.md` — existing product direction and repository roles.
- `docs/superpowers/specs/2026-10-08-production-recovery-design.md` — current schema/deploy baseline.
- `docs/superpowers/specs/2026-07-18-production-ai-runtime-design.md` — AI runtime and deploy
  coupling that this design preserves.
- `docs/superpowers/specs/2026-09-01-capability-registry-system-map-admin-tab-design.md` — capability
  disclosure rules.
- `CLAUDE.md`, `CONTEXT.md` — standing architecture rules and shipped-behaviour context.
- Local research notes (gitignored): `.superpowers/brainstorm/20261108-wukong-conversation-studio/`
  (`research/aiso-studio.md`, `research/skills-mcp.md`, `research/wukong-audit.md`; `concept/`).
