# Workspace Admin Area — Design

## Problem

Today the app has no admin surface at all. Two real gaps follow from this:

1. **No way to manage who's on a workspace.** The schema already models `memberships` and `workspace_invites`, and the auth side already knows how to check invite eligibility during registration, but nothing writes to those tables from the application — there is no invite flow, no member list, no way to change or revoke a role.
2. **No way to manage the SHOPLINE connection or workspace settings from the UI.** `shopline_connections` only has read methods (`getDefault`, `getById`) — connecting a shop or rotating a token today means a manual DB/seed-script step. Workspace settings fare slightly better: `POST /api/workspace/settings` already exists, admin-gated and audited, and can update `brandBackgroundColor` — but nothing in the UI calls it.

This is the second of two sub-projects under a "role-based UI" umbrella (the first, smaller one — making every existing screen consistently honor the permissions the API already computes — is a separate spec). This spec covers building the admin area itself: member/role management, SHOPLINE connection management, and wiring up the existing settings endpoint.

## Goals

- Admins (and the workspace owner) can invite a teammate by email and role, see who's on the workspace (active members and pending invites together), change a member's role, remove a member, or revoke a pending invite.
- Admins can connect a SHOPLINE shop (domain + access token) if none is connected yet, and rotate the access token if one is.
- Admins can set the workspace's brand background color through the UI instead of only via direct API call.
- A workspace can never be left with zero admins/owners, and an admin can never remove or demote themself.

## Non-goals

- Sending actual invite emails. The invite row is created; the admin shares the signup link out-of-band. Real email delivery (via the `nodemailer` setup already used for magic-link auth) is a natural fast-follow, not blocking.
- Editing any `workspaceProfileSchema` field beyond `brandBackgroundColor` (name, tone, claimPolicy, requiredFields). Those feed the AI pipeline and compliance checks directly; editing them safely needs its own validation design.
- An OAuth-style SHOPLINE connect flow. Manual credential entry (shop domain + access token) matches how the connection is read today and needs no new integration.
- Assigning the `owner` role via this UI. `owner` is the workspace-bootstrap role; this UI can only assign `viewer | operator | reviewer | admin`, to avoid a self-service path to the top rank.
- Changing which roles exist, or the rank order between them (`packages/db`'s `roleOrder`/`requireWorkspaceRole` machinery is reused as-is).

## Architecture

### Access

Gated identically to the existing settings route: `requireWorkspaceRole("admin", session.role)` — `admin` and `owner` pass, everything below is rejected server-side, not just hidden client-side. The app shell nav (`apps/web/app/(app)/layout.tsx`) shows an "Admin" link only when the signed-in session's role clears this bar.

### Page structure

One route, `apps/web/app/(app)/admin/page.tsx`, gated the same way the API is. It renders a client component, `admin-tabs.tsx`, owning which of three tabs is active: **Members**, **SHOPLINE Connection**, **Settings**. Each tab is its own panel component that fetches its own data on mount — no shared client-side data layer between tabs, matching how `listing-review-client.tsx` already composes independent panels.

A tabbed single page (rather than three separate routes, or one long scrolling page) was chosen deliberately: this is a rarely-visited area for a small pilot team, so it doesn't need three route trees, but the three concerns (people, connection, branding) are distinct enough to deserve visual separation rather than one continuous scroll.

### Data layer

Two new/extended repository files in `packages/db/src/repositories/`:

**`memberships.ts`** (new):

- `listForWorkspace()` — joins `memberships` → `users` for email, returns `{userId, email, role, createdAt}[]`.
- `listInvites()` — pending rows from `workspace_invites`, returns `{id, email, role, createdAt}[]`.
- `createInvite(email, role)` — inserts into `workspace_invites`. Rejects (at the repository level, via a pre-check plus reliance on the existing unique index) if the email is already an active member OR already has a pending invite.
- `revokeInvite(inviteId)` — deletes the invite row.
- `updateRole(userId, role)` — updates `memberships.role`. Enforces both guard rails below.
- `remove(userId)` — deletes the membership row. Enforces both guard rails below.

**Guard rails**, enforced in the repository (not just the route, so they hold regardless of caller):

1. **Last-admin protection**: `updateRole`/`remove` reject with a typed error if the target is the only remaining `admin`-or-`owner` among _active_ memberships in the workspace — pending invites (even ones inviting a new admin) don't count toward this, since they aren't a real admin yet.
2. **No self-service demotion/removal**: `updateRole`/`remove` reject if `userId` matches the acting admin's own user id. This is deliberately stricter than "block only if you're the last admin" — losing access to the page you're standing on mid-action is confusing regardless of whether someone else could theoretically restore you.

**`shopline-connections.ts`** (extended): two new methods alongside the existing `getDefault`/`getById`:

- `create({shopDomain, accessToken})` — encrypts `accessToken` via the existing token-vault helper (`packages/shopline`, the same one `seed-shopline-connection.ts` already uses) before insert. Rejects if a connection already exists for the workspace (single-connection-per-workspace model, matching `getDefault()`'s existing assumption).
- `update(id, {accessToken})` — encrypts and replaces the token on the existing connection. Shop domain is not editable this way — changing it means connecting to a different store, which is a `create` after removing the old connection, not a field update.

### API routes

New, under `apps/web/app/api/workspace/`, all wrapped in `withRouteErrors`, all gated with `requireWorkspaceRole("admin", session.role)`, all writing an audit event on success:

| Route                               | Method | Behavior                                                                                   | Audit event                     |
| ----------------------------------- | ------ | ------------------------------------------------------------------------------------------ | ------------------------------- |
| `/api/workspace/members`            | GET    | Merged list: active members + pending invites, each tagged `status: "active" \| "pending"` | — (read)                        |
| `/api/workspace/members/invite`     | POST   | `{email, role}` → creates invite                                                           | `workspace.member_invited`      |
| `/api/workspace/members/[userId]`   | PATCH  | `{role}` → updates role, guard rails apply                                                 | `workspace.member_role_changed` |
| `/api/workspace/members/[userId]`   | DELETE | Removes member, guard rails apply                                                          | `workspace.member_removed`      |
| `/api/workspace/invites/[inviteId]` | DELETE | Revokes a pending invite                                                                   | `workspace.invite_revoked`      |
| `/api/workspace/connection`         | GET    | Returns `{shopDomain, connectedAt} \| null` — **never** the token                          | — (read)                        |
| `/api/workspace/connection`         | POST   | `{shopDomain, accessToken}` → creates connection                                           | `workspace.connection_created`  |
| `/api/workspace/connection`         | PATCH  | `{accessToken}` → rotates token                                                            | `workspace.connection_rotated`  |

The **Settings tab reuses the existing `POST /api/workspace/settings` route** unchanged — this spec adds no new route there, only a UI that calls it.

### Error handling

Standard `ApiError(status, code, message)`, no new pattern:

- `403 forbidden` — sub-admin on any of these routes.
- `409 conflict` — duplicate invite/member email, connection already exists, last-admin or self-removal/demotion violation.
- `400 validation_failed` — malformed email, invalid role enum value, malformed connection payload (zod `.strict()` schemas, matching the settings route's existing style).
- `404 not_found` — acting on a member/invite/connection id that isn't in the caller's workspace (workspace-scoped queries + RLS make this a natural 404, not a leak-then-403).

The UI surfaces each of these as an inline error banner near the action that triggered it, reusing whatever banner pattern the delivery/review panels already use.

### UI components

New files in `apps/web/components/`:

- **`admin-tabs.tsx`** — tab shell, owns active-tab state.
- **`admin-members-panel.tsx`** — merged table (email, role, status badge, joined/invited date); per-row role `<select>` and remove button, both disabled (with helper text) for the acting admin's own row and for the last-admin row; an "Invite member" form (email + role) at the top.
- **`admin-connection-panel.tsx`** — connect form when no connection exists; read-only `shopDomain` + connected-since date plus a "Rotate token" action (reveals just the token input) when one does. The token itself is never fetched or rendered.
- **`admin-settings-panel.tsx`** — the brand-background-color control already built for `product-shot-panel.tsx`, re-pointed at `POST /api/workspace/settings`.

All four follow this codebase's established form conventions (refetch-after-mutation rather than optimistic local state, inline error banner, disabled-during-submit), matching `listing-fields-form.tsx` rather than introducing a new pattern.

## Testing

- **Repository unit tests** (`memberships.test.ts`, extending `shopline-connections.test.ts`): the guard rails specifically — last-admin block, self-removal/demotion block, duplicate-invite rejection — since those are the properties most worth locking in against regression.
- **Route tests** for every new handler: 403 for sub-admin, happy path, each documented 409/400 case — table-driven, matching `workspace/settings/route.test.ts`'s existing style.
- **Component tests** for the four new components, using this codebase's `renderToStaticMarkup`/fetch-mocking convention.
- **Integration tests**: `memberships.integration.test.ts` and an extension of `shopline-connections.integration.test.ts` (if one exists, else new) against real Postgres, verifying the unique indexes and cascade-delete behavior the guard rails depend on.

## Open questions resolved during brainstorming

- Scope: member management + SHOPLINE connection management + workspace settings, all in one project (confirmed).
- Member operations: invite, view, change role, remove — full set (confirmed).
- Connection flow: manual credential entry, not OAuth (confirmed).
- Settings scope: `brandBackgroundColor` only for this pass (confirmed).
- Guard rail: block last-admin removal/demotion (confirmed), extended during design to also block self-removal/demotion outright (confirmed).
- Page structure: tabbed single page, chosen over separate routes or one long scrolling page (confirmed via visual mockup).
