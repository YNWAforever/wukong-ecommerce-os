# Studio team access P3 — implementation plan (2026-11-18)

Follows the P2 SaaS-packaging milestone. One UI/copy PR: no schema migration, no
new API route, no model call, no change to role enforcement.

## Problem this slice solves

P2 shows seats in the Studio plan card, but there is no Studio destination where an
admin can act on them. The only member UI is the legacy `/admin` page, and the setup
checklist's "Connect SHOPLINE" link opened `/admin` on the members tab rather than
the connection form. A pilot workspace therefore looks packaged but cannot be
administered from the same surface.

## Scope in this PR

1. **`/studio/team`** — admin-only team surface with the existing audited member
   panel: members, role changes, pending invitations, invite and revoke. It also
   explains the five roles using the same copy as the account menu, so the surface
   does not invent a second permission model.
2. **Seats link** — the Studio settings plan card gains "Manage team" next to the
   existing Growth contact link.
3. **Exact admin deep links** — `/admin?tab=connection|members|settings|capabilities`
   opens the requested tab. Unknown values fall back to members. Setup steps now
   link to the connection tab and the members tab explicitly.
4. **Rail** — a Team destination in the Studio admin group, visible only to admins.
5. **Docs** — the product plan records the team surface and corrects the stale
   "invitation acceptance missing" claim: the enrollment path exists; production
   SMTP delivery still needs verification.

## Deferred (needs product or data work)

- Billing, entitlements and quotas: no plan record exists, so the page continues to
  show only counts and the pilot agreement.
- Persisted lead intake and demo provisioning: the marketing site still owns the
  public funnel.
- URL sync on every admin tab click: only the initial tab is read from the query, so
  the existing admin dirty-navigation guard and history behaviour stay unchanged.

## Tests

- `adminTabFromQuery` unit test: known tabs, unknown/missing/repeated values.
- Admin page test: deep-linked tab reaches `AdminTabs`; unknown value falls back.
- Admin tabs test: initial tab renders the matching panel.
- Team page test: admin sees the role guide and member panel; non-admin 404s;
  signed-out reader redirects.
- Settings page test: seats link points to `/studio/team`.
- Shell test: Team is admin-only.
- Browser acceptance: owner surfaces include `/studio/team`; the seats link opens
  the real table; a viewer gets the Studio not-found boundary.
