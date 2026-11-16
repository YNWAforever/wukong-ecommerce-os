# Studio usability audit — why the shipped roadmap is hard to use

Date: 2026-11-16 (Asia/Singapore). Scope: the shipped Studio surfaces after the bounded
multi-listing review milestone (roadmap `2026-11-09-next-development-roadmap.md`, PRs #230–#232).
Method: heuristic walkthrough of the routes, navigation, copy catalogue and the browser acceptance
screenshots at 1280px and 390px. This is a code/UI inspection, not user interviews; the last section
proposes validation with real operators.

## 1. Executive summary

The product is functionally complete but **cognitively expensive**. Users are not confused because a
feature is missing; they are confused because the interface exposes the implementation model and
asks them to assemble a workflow from eight screens. Five root causes:

1. **Navigation was added per milestone, not designed per job.** There are 22 app pages, an
   11-item global nav (12 with Admin), and a second Studio rail with 7 destinations plus a
   recent-list link. On phones the Studio rail renders _above_ the page content, so the actual task
   can start more than a screen down.
2. **The internal object model is the user model.** People see `thread`, `run`, `output`, `version`,
   `revision`, `content digest`, `scope`, `skillKey: merchant.audit`, budget reservation, provider
   and tokens. The product's real objects are _listing_, _review_, _gap_, _proposal_ and _decision_.
3. **Safety engineering is expressed as user copy.** The honesty rules became dozens of
   "read-only / never writes / no AI call / not implemented" notices. They reassure engineers and
   leave operators unsure what the screen actually does for them.
4. **One workflow is split across several surfaces and two explicit confirmation steps.** The
   primary journey is: Catalog → listing → a secondary "Start guided review" link → Studio home
   (prefilled composer) → Send → thread → "Prepare gap review" (fills the composer at the bottom) →
   Send → save artifact → refresh journey → reviewer sign-off → Inbox/Outputs. There is no single
   "what do I do next" surface.
5. **There is no onboarding, next-step guidance or role clarity.** Landing is the legacy Workbench,
   the beginner template grid explains limitations instead of tasks, and users cannot see their own
   role or what the next person is expected to do.

Verification is excellent; **guidance is missing**. The fix is mostly information architecture,
labels and component placement — not new domain capability.

## 2. Concrete confusion points (evidence)

Severity: P0 = blocks the primary journey; P1 = causes wrong turns/support load; P2 = polish.

| #   | What the user meets                                                                                                                                                                                                                                                                                                             | Why it confuses                                                                                                                                                                            | Sev. | Evidence                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | Two navigation systems at once: global rail (Studio, Workbench, Catalog, Imports, Exports & results + Tools group of six) and a Studio rail (Overview, Inbox, Reviews, Conversations, Outputs, Tools, Settings, recent link).                                                                                                   | Two "Tools", two "reviews", up to 20 links visible on desktop. The Studio rail has **no active-page state**, so users cannot tell where they are.                                          | P0   | `apps/web/app/(app)/shell-nav-items.ts:8-50`, `apps/web/components/studio-shell.tsx:35-42,127-148`; no `aria-current`/`[data-active]` in `studio.module.css` |
| B   | "Settings" is always in the Studio rail, but `/studio/settings` answers **404 "Studio page not found… or Studio is not enabled"** to non-admins.                                                                                                                                                                                | A normal operator concludes Studio is broken or their workspace is disabled.                                                                                                               | P0   | `studio-shell.tsx:139-146`; `app/(app)/studio/settings/page.tsx:144-169`                                                                                     |
| C   | Raw internals in primary UI: `技能: merchant.audit`, `內容摘要 {64-hex digest}`, `版本 {revision}`, `執行詳情與費用`, `模型服務`, `輸入 tokens`, `預算保留狀態`, `範圍`, `資料截至`.                                                                                                                                            | Users must decode engineering state to trust a proposal. The digest alone (64 hex chars) reads as an error code.                                                                           | P0   | `studio-thread-view.tsx:392-396`; `studio-copy.ts:21-35,1082,1162-1163`                                                                                      |
| D   | The same concept has 3–4 names: Workspace audit / Merchant audit / 商家稽核 / 概況審查; gap review / Listing gaps / Gap report / 缺口報告; output / artifact / 成品 / 建議; review / sign-off / 簽核 / 確認.                                                                                                                    | Users cannot build a mental model; search and support conversations use different words. Two copy modules (`studio-copy.ts`, `studio/guided-copy.ts`) translate the same idea differently. | P0   | `studio-copy.ts:1135-1140,1913-1914`; `guided-copy.ts:11-13`                                                                                                 |
| E   | In a thread, the "Improve this listing" journey card renders **above the thread title and messages**, while its "Prepare gap review" button only fills the composer **at the bottom**. A second "Refresh journey status" button sits next to the composer's own "Reload conversation".                                          | Clicking "Prepare" appears to do nothing; users do not know Send is the real action. Two refresh buttons do overlapping jobs.                                                              | P0   | `studio-thread-view.tsx:331-365,401-417,503-536`; `studio-guided-journey.tsx:288-310,340-350`                                                                |
| F   | The guided entry is a small secondary link inside the already dense listing review page, and it navigates to `/studio?guideListing=…&guideVersion=…`.                                                                                                                                                                           | Users looking at a listing in Catalog never see the main Studio journey; those who find it land on a different page with a prefilled box and must work out that this starts a thread.      | P1   | `components/listing-review-client.tsx:1225-1234`; `app/(app)/studio/page.tsx:54-81`                                                                          |
| G   | Four places show the same work: Inbox ("needs attention"), Reviews (latest recorded per listing), Conversations (threads), Outputs (artifacts). After a batch, results show "Complete"; after reload they show "Recorded".                                                                                                      | No rule for which surface to use. "Complete" vs "Recorded" looks like a status change; the batch results never say "open each conversation to continue the copy proposal".                 | P1   | `studio-copy.ts:1856-1948`; `app/(app)/studio/inbox/page.tsx:127-341`; `app/(app)/studio/reviews/page.tsx`                                                   |
| H   | Six overlapping state vocabularies: listing status, thread status/visibility, journey stage, output status (draft/saved/signed off/discarded), outcome (complete/partial/failed/recorded), confirmation (confirmed/unconfirmed/version unavailable), evidence freshness (current/stale/unavailable).                            | A user cannot answer "is this done?" without learning all six.                                                                                                                             | P1   | `studio-copy.ts:1077-1205,1929-1948`; `studio/guided-contracts.ts`                                                                                           |
| I   | Role fog: viewer/operator/reviewer/admin/owner gates are invisible; controls are disabled with long notes ("An operator or higher role is required…"). Reviewer sign-off lives in a different card than operator preparation.                                                                                                   | Nobody knows what they can do, who approves, or why a button is dead.                                                                                                                      | P1   | `studio-copy.ts:58-61,136-139,1206+`; `studio-review-batch.tsx` viewer branch                                                                                |
| J   | First run: `/` redirects to `/dashboard` (legacy Workbench, import-first). Studio home is "Welcome back" + a 10-card template grid where every card leads with an availability badge and a limitation sentence (8 pilot, 2 blocked) and the only action is "Fill", which just pre-fills the composer.                           | New users get no first task, no sample listing, no explanation of the audit→gap→copy→sign-off journey. "Pilot/Blocked" reads as "unfinished product".                                      | P1   | `app/page.tsx:14`; `components/studio-home.tsx:371-437`; `packages/core/src/studio/skill-definitions.ts` (8 pilot / 2 blocked)                               |
| K   | At ≤960px the Studio grid becomes one column with the **rail first**: workspace card, New conversation, 7 links, then the recent-conversation list, then the page. A 390px screenshot shows page content starting about 1000px down (beyond one 844px viewport).                                                                | Phone/tablet users scroll navigation before every task and mistake the rail for the page.                                                                                                  | P1   | `studio.module.css:1639-1676`; CI screenshot `studio-review-batch-390-zh.png`                                                                                |
| L   | 13 standalone bilingual safety notices ("Studio never approves or publishes…", "read-only… never writes, publishes or calls AI", "nothing is scheduled, retried…"), plus "not implemented"/"planned"/"unavailable" states. ~55 bilingual strings use internal/technical vocabulary. 751 Studio copy keys in one flat catalogue. | Transparency is a strength, but as primary-page copy it reads as disclaimers and raises doubt ("so what _does_ it do?").                                                                   | P2   | `studio-copy.ts:99-102,194-197,205-212`; `guided-copy.ts`; key counts below                                                                                  |

Additional facts: 22 app pages, 9 Studio pages, 11 global destinations (12 with Admin), 7 Studio rail
destinations plus a recent-list link, no in-app help/onboarding route (only `/support`), and the
legacy listing-review page carries approve/publish/process/product-shot/guided actions together.

## 3. Current map vs the user's actual jobs

| User job                           | Where it lives today                                                                                  | Friction                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| "What needs my attention?"         | Inbox (read-only aggregate), Reviews (batch start), Outputs (draft/saved), Workbench (listing states) | Four entry points, no prioritised "today" list, no ownership.                                                         |
| "Fix this listing"                 | Catalog → listing → listing review page → guided link → Studio home → new thread                      | Two screens and a query-string handoff before any work starts.                                                        |
| "Ask a question about a listing"   | Studio home composer or thread composer                                                               | No listing context picker; no recent listings.                                                                        |
| "Run the audit/gap/copy journey"   | Thread journey card ("Prepare …" then Send)                                                           | Card is detached from the composer; Send is a separate step; a manual Refresh is required for handoff.                |
| "Review someone's proposal"        | Inbox → artifact detail → save → sign off; or Outputs                                                 | Reviewer must know the artifact exists; no queue count/owner; "read-only" wording hides that actions exist in detail. |
| "Approve/publish a listing"        | Legacy listing review page                                                                            | Different vocabulary and visual language from Studio ("approval" vs "sign-off").                                      |
| "Administer AI/budget/connections" | Studio Settings (admin 404 for others), Connections ("Hosted MCP tokens", "Capability code")          | Developer vocabulary in operator-facing nav; dead end for non-admins.                                                 |

## 4. Canonical vocabulary (proposal)

| Concept                    | Today                                                    | Recommend (zh-Hant / en)     |
| -------------------------- | -------------------------------------------------------- | ---------------------------- |
| The listing-level effort   | guided review, listing review, 商品審核, 改善這個商品    | 商品審查 / Listing review    |
| Deterministic records pass | workspace audit, merchant audit, 概況審查, 商家稽核      | 工作區稽核 / Workspace audit |
| Listing-specific gaps      | gap review, listing gaps, gap report, 缺口檢視, 缺口報告 | 缺口檢視 / Gap review        |
| AI draft                   | copy proposal, artifact, output, 成品, 建議              | 文案建議 / Copy proposal     |
| Human approval             | sign-off, review confirmation, 簽核, 確認                | 覆核 / Review sign-off       |
| Saved items                | outputs, artifacts, 輸出, 成品                           | 已儲存建議 / Saved work      |
| Batch trigger              | multi-listing review, reviews, 多商品審核                | 批次審查 / Batch review      |
| Attention list             | inbox, orchestration inbox, 收件匣, 編排收件匣           | 待辦 / Needs attention       |
| Conversation               | thread, conversation, 對話                               | 對話 / Conversation          |

Rule: user-facing labels never show `threadId`, `runId`, `revision`, `digest`, `scope`, `skillKey`,
`reservation` or provider names. Pins and budget belong behind a "Details" disclosure.

## 5. Why it happened

- **Milestone accretion.** Each approved cycle added a surface and a nav item to satisfy an exact
  requirement (inbox, exact versions, guided journey, batch review). Nothing ever removed or merged
  a destination, so the app grew outward from the code structure.
- **Honesty requirements became UI copy.** "Never writes", "no AI call", "exact revision/digest" are
  contract-level guarantees; they were printed on every screen instead of moved into a help page.
- **The implementation object model leaked into UX.** Threads, runs, artifacts and versions were the
  natural unit of the backend and of the tests, so they became the unit of navigation.
- **Two products were glued together.** The catalogue/listing-operations app (imports, queue,
  quality, approve/publish) and Conversation Studio have different vocabularies, different visual
  languages and the same users.
- **No role-based or first-run design.** Role gating was implemented as "disable and explain", and
  onboarding was never in scope, so every new milestone added another unexplained control.

## 6. Prioritised remediation

### P0 — one PR, UI-only (no schema, model, queue or policy change)

1. **Navigation truth.** Add `aria-current` + active styling to the Studio rail; hide Settings for
   non-admins (or show an "Admins only" disabled state instead of a 404); move Settings/Tools into
   an "Admin" group; rename Reviews → "Batch review" and Outputs → "Saved work" (labels only).
2. **Content first on mobile.** Below 960px render the page content above the rail; turn the rail
   into a collapsed context bar (workspace + current section + menu), and move recent conversations
   into a sheet/drawer.
3. **Journey next to the composer.** Move the guided-journey card below the thread header (or make it
   a sticky step bar above the composer); replace "Prepare …" + Send with one inline request panel:
   show the exact request text and a primary "Send audit request" button, then refresh
   automatically. Remove the duplicate refresh buttons.
4. **De-jargon primary labels.** Replace the raw `skillKey` badge with "Guided review"; move
   revision/digest/run/token/budget facts under a "Details" disclosure. Use kind names ("Gap review",
   "Copy proposal") instead of "artifact/output" on primary screens.
5. **One vocabulary.** Pick the section 4 terms, merge `guided-copy.ts` into the Studio catalogue
   (or keep a shared glossary module), and add a parity test that the canonical term is used.

### P1 — IA pass (can be one PR after P0)

6. **A real home.** Studio home becomes "Today": (a) listings needing review with one primary
   action, (b) conversations waiting for you, (c) proposals awaiting sign-off, plus a 3-step "How
   this works" block. Move the 10 template cards behind "More skills".
7. **One attention queue.** Fold Inbox + pending Outputs + batch failures into one prioritised list
   with owners and one obvious action each; keep Reviews as the creation flow ("Review selected
   listings") inside Listings/Today.
8. **Entry point where the listing is.** Add a primary "Start guided review" action on the catalogue
   row/listing page (same component in both), replacing the cross-screen `?guideListing=` handoff.
9. **Role clarity.** Show the signed-in role and its capabilities in the account menu and an
   admin-editable permission summary; for gated controls say "Ask an admin to…" with the exact role
   needed.

### P2 — trust copy and validation

10. **Capability statements instead of disclaimers.** Keep one plain line per surface ("Reads
    workspace records. Changes nothing."), move guarantees and pin explanations to a "How this
    works" page linked from the rail.
11. **Validate with users.** Five think-aloud sessions on the same script (import a listing, run the
    guided journey, review and sign off, find what needs attention), measure time-to-first-review,
    wrong turns and help requests; iterate before adding the next feature.
12. **Clean the catalogue.** Remove dead keys (e.g. `studio.outputs.pending` still says "outputs and
    sign-off are not implemented yet" though it is no longer rendered), and add lint for
    "not implemented"/"planned" copy on live surfaces.

## 7. Suggested next milestone ("Operator clarity", 2 PRs)

- PR 1 (P0 items 1–5, UI/copy only, no migration, no model calls, existing tests plus new nav/copy
  tests, 390px screenshots).
- PR 2 (P1 items 6–10 + usability evidence from 5 sessions).
- Success measures: a new operator completes a first guided review without help in <5 minutes;
  zero "which page?" and "what does this button do?" questions in the sessions; Settings/Tools dead
  ends removed; no technical identifier on a primary screen.

## 8. Evidence appendix

- Screenshot (CI artifact): `studio-review-batch-390-zh.png` — rail-first mobile stacking; a 2182px
  page for a page whose content begins ~1000px down.
- Key counts: 22 app pages; 13 global nav destinations; 8 Studio rail destinations; 751 Studio copy
  keys; ~55 bilingual strings exposing technical state; 13 standalone safety notices.
- Key files: `apps/web/components/studio-shell.tsx`, `studio-thread-view.tsx`,
  `studio-guided-journey.tsx`, `studio-home.tsx`, `app-shell-nav.tsx`,
  `apps/web/app/(app)/shell-nav-items.ts`, `apps/web/lib/studio-copy.ts`,
  `apps/web/lib/studio/guided-copy.ts`, `apps/web/components/listing-review-client.tsx`,
  `apps/web/components/studio.module.css`.

## 9. P0 delivery record (2026-11-17)

The P0 remediation in section 6 is shipped as UI/copy-only changes: no schema migration, no model
call, no queue/scheduler and no change to the "explicit operator initiation" policy.

- **Rail:** active destination is marked with `aria-current="page"` and a visible active row;
  destinations are grouped into Work, Records and Admin; Connections and Settings render only for
  administrators, so an operator no longer taps a link that answers 404. Below 960px the rail is a
  compact bar (workspace, current section, Menu) that expands on request instead of stacking a full
  navigation panel above the page.
- **Guided journey:** the card now sits next to the composer, and "Prepare gap review" opens an
  inline confirmation panel that shows the exact request text; the step runs only when the operator
  presses "Send request". This keeps the one-run-per-explicit-action contract while removing the
  "fill the box, scroll down, press Send" gap. The duplicate thread reload button is gone; the
  single "Refresh journey status" remains for saved-status changes.
- **Vocabulary:** `apps/web/lib/studio/terms.ts` is the canonical glossary; the rail, batch page and
  guided journey read it, and `terms.test.ts` pins the English and zh-Hant wording. Renames:
  Reviews → Batch review, Outputs → Saved work, Tools (rail) → Connections, Tasks inside the rail
  grouped rather than appended.
- **De-jargon:** the thread badge shows "Workspace audit"/"Gap review" instead of
  `merchant.audit`; output revision/date/digest moved behind a "Version details" disclosure. Run
  details remain behind their existing load-details control.
- **Tests:** unit coverage for the shell (active state, admin gating, menu toggle), guided
  confirmation, terms parity and page headings; the two CI-typechecked e2e acceptance flows were
  updated to send from the confirmation panel.

Remaining audit work (P1: a task-based Today home, one attention queue, listing-level entry point,
role help) is unchanged and should be a separate change.
