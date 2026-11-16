# Operator clarity P1 — implementation plan (2026-11-17)

Follows `docs/superpowers/specs/2026-11-16-studio-usability-audit.md` §6 P1. One UI/copy PR:
no schema migration, no model call, no queue or policy change, no new workspace permission.

## Problem this slice solves

P0 made the rail, vocabulary and guided send honest. The remaining first-run confusion is that
Studio still opens on a greeting + composer + ten equal-weight template cards, while the work that
actually needs a person is spread across Inbox, Quality, Jobs and Saved work. A new operator cannot
answer "what should I do now?" from the home screen.

## Scope in this PR

1. **Real Today home.** `/studio` renders a server-read priority queue above the composer:
   listings waiting for review, listings with quality gaps, listings without an active version or
   that cannot be assessed, pipeline jobs needing attention, drafts/saved work awaiting action and
   recent conversations. Each row has one priority-ordered action and an owner role. A three-step
   "How this works" block explains the read → check → sign-off path. A failed queue read says so;
   it never renders zeroes.
2. **One attention queue.** The same queue is the first section of `/studio/inbox`; the existing
   per-source cards move under a "Browse by source" disclosure so the page has one primary list.
   Inbox keeps every existing deep link and honest unavailable/truncation state.
3. **Role clarity (read-only).** The account menu states what the signed-in role can do and which
   role is needed for the rest. The viewer send note names the role to ask instead of saying
   "operator or higher" without a person to ask.
4. **Entry point.** The listing review screen's guided entry becomes a primary action
   ("Start guided review"), still read-only and explicit-send.

The queue reuses `studioService().inbox()` — the same workspace-scoped, fail-soft reads the inbox
already uses. No new API route, no new SQL and no change to what any surface can read.

## Deferred (needs data, API or product work)

- Row-level guided entry on the catalogue table: `/api/listings` does not expose
  `activeVersionId`, and adding it to the collection payload is an API-contract change, not UI/copy.
- Admin-editable permission summary: editing role capabilities is a settings/schema decision; this
  PR only shows the read-only capability text.
- The five think-aloud sessions and success measures in the audit remain the P2 validation step;
  no usability session data is invented here.

## Tests

- Pure builder unit test: priority order, owner/action mapping, count-zero suppression,
  unavailable sources skipped, bounded list.
- `StudioToday` render test: ordered rows, owner chips, single action links, all-clear,
  unavailable, how-it-works.
- Home component test: Today node renders above the composer; templates are inside a collapsed
  "More skills" disclosure and still fill the composer.
- Inbox page test: queue is first, source cards remain reachable under the disclosure.
- Account menu test: each role gets a capability line; existing identity/logout behaviour unchanged.
- Browser acceptance: open "More skills" before using a template; home Today links are present;
  390px still has no horizontal overflow.
