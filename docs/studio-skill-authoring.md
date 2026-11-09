# Studio skill authoring guide (C4)

How to add, version and review a Conversation Studio skill. The registry is
code-reviewed, not runtime-mutated: a skill status change is a reviewed change
with recorded verification, and the workspace settings page (`/studio/settings`)
only chooses which already-pilot skills a workspace may run.

## 1. Decide the contract first

A skill is a read-only playbook with a bounded outcome. Before writing code, fill in:

- **key** — `<domain>.<action>` (e.g. `category.map_proposal`), lower-case, stable forever.
- **status** — `planned`, `pilot` or `blocked`. `planned` renders on template cards but cannot run;
  `blocked` additionally states the missing external dependency; only `pilot` is executable.
- **inputs** — required and optional descriptions (usually `listingId` and/or a free-text question).
- **allowedTools** — the smallest reviewed tool allowlist; every id must exist in
  `packages/core/src/studio/tool-definitions.ts`.
- **evidence.requiredSources** — canonical sources the answer must read; unknown stays
  `null`/`missing` with a reason, never zero or a guess.
- **outputKind** — `finding`, `copy_proposal`, `gap_report`, `merchant_audit` or `dispatch`.
- **budgetClass** / **completion** — `free` vs `model-turns-v1`; schema+evidence(+readback) is the
  minimum for any artifact-producing skill.
- **limitation** — the honest sentence users see (what the skill does _not_ do).

## 2. Definitions and versions

1. Add the definition to `SKILL_DEFINITIONS` (and its prompt binding to
   `STUDIO_SKILL_PROMPT_BINDINGS` if it can call a model). Bump `version` for any reviewed behavioural
   change and add a line to the change note. Status promotion and version bumps are separate
   decisions: `planned` → `pilot` only after the verification in §6 exists.
2. Keep prompts in `packages/ai` and pin them in `STUDIO_PROMPT_VERSIONS`. Any prompt text change
   bumps the affected version; accepted turns record the versions they ran under.
3. Model output is untrusted: validate identity (listing/thread match), allowed fields, evidence refs
   against the pack, duplicates, and drop/count anything unsupported. Never add write authority to a
   model path.
4. Update `packages/core/src/studio/skill-manifest.ts` bindings and run
   `packages/core/src/studio/skill-manifest.test.ts`. The manifest is the machine-readable summary
   authors and docs use; the fingerprint changes when a reviewed surface changes.

## 3. Evidence and deterministic first slice

Ship the deterministic evidence pack before any model call:

- add a builder in `apps/web/lib/studio/evidence.ts` (or a dedicated module) that reads only through
  `StudioReadDeps` (workspace-scoped repositories), records `sources`, `checks`, `coverage`, `trace`
  and honest limitations;
- missing required input is a `needs_input` reply with a copy key, not a model guess;
- report unreadable/missing sources explicitly (`null` + limitation);
- keep the pack free of prompts/model output; it is records-only.

## 4. Turn, artifact and reply

Wire the skill through `turn-service.ts`:

- deterministic composer section(s) in `compose-deterministic.ts`;
- optional model step under the reviewed budget admission (`studioTurnReservation`, reserve/settle/
  uncertain), with the same 45 s/step/model budgets;
- artifact-producing skills persist a versioned output via `output-service.ts` (canonical digest,
  readback, audit `studio.output.proposed`) and return `reply.outputs`;
- no canonical writes: applying anything remains a human action in the existing review screens; a
  dispatch skill must go through the explicit confirmed route, never a tool call.

## 5. UI and copy

- Render the artifact with a small read-only card in `apps/web/components/` (reuse existing
  `.studio-*` classes where possible);
- all user-visible text lives in `apps/web/lib/studio-copy.ts` (bilingual parity, banned-claim scan,
  emitted-key tests); no literal CJK outside copy modules;
- include the honest "not applied / requires human review" wording and a link to the relevant
  existing screen;
- add a needs-input/failure/partial state test, not just the happy path.

## 6. Tests and promotion gate

Every skill change needs:

- registry test (`skill-definitions.test.ts`) plus manifest test;
- evidence tests: complete, needs-input, missing/unreadable source, honest coverage;
- fake-model tests for grounding/validation/drop counting (no network);
- turn-service test that persists/reads back the artifact (or returns a deterministic answer);
- copy/UI tests;
- full `apps/web` suite, `packages/core`/`packages/ai` units, `pnpm lint`, format gate and CI.

Promote `planned` → `pilot` only in the same change that records that verification. A skill with no
recorded execution evidence stays `planned`; a skill that needs a missing external dependency stays
`blocked` with the reason in its limitation and description.

## 7. Workspace enablement

`studio_workspace_settings.allowed_skills` (admin settings, A1) is an allowlist over pilot skills;
empty means all pilot skills. It cannot promote a planned/blocked skill. Every execution re-checks
the skill status and the workspace allowlist server-side.

## 8. Review checklist (copy into the PR)

- [ ] definition, version and status recorded; manifest/prompt bindings updated
- [ ] evidence sources/checks/coverage/limitations honest (missing ≠ zero)
- [ ] deterministic path works with no model; model path is grounded, budgeted and untrusted-input safe
- [ ] artifact (if any) versioned with digest/readback/audit; no canonical writes
- [ ] UI/copy bilingual, review-only wording, no unreviewed claims
- [ ] tests + CI green; capability-registry state only changed with recorded verification
