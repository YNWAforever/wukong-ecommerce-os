# Dependency and supply-chain security

Pilot scope: manual runbooks now, CI gating later. The goal is a **clean production dependency
tree** and a recorded way to keep it clean, without turning unrelated feature PRs into upgrade
trains.

## Current state (2026-11-10)

`pnpm audit` before the remediation pass reported **98 advisories** (7 critical, 40 high, 45
moderate, 6 low), led by critical Next.js RCE advisories (< 16.4.1) and better-auth
account-takeover advisories (< 1.7.7). After the upgrade PR the audit reports **0 advisories**.

Production/runtime upgrades:

| Package       | Before  | After   | Why                                          |
| ------------- | ------- | ------- | -------------------------------------------- |
| `next`        | 16.2.10 | 16.4.1  | critical RCE + middleware/SSRF/image fixes   |
| `better-auth` | ^1.5.5  | ^1.7.7  | account takeover, OAuth replay, XSS fixes    |
| `drizzle-orm` | 0.44.7  | ^0.45.2 | SQL-injection identifier escaping            |
| `zod`         | 4.4.3   | ^4.6.6  | memory exhaustion on constrained collections |
| `nodemailer`  | ^9.0.3  | ^10.1.4 | addressparser/DKIM denial-of-service fixes   |
| `sharp`       | ^0.35.3 | ^0.35.5 | libvips/libheif/librsvg CVEs                 |

Tooling/transitive upgrades: `turbo` 2.10.4 → 2.11.10, `vitest` 4.1.10 → 4.1.12,
`@playwright/test` 1.51.1 → 1.55.1, `happy-dom` 20.8.3 → 21.0.4, explicit `vite` 8.1.6.

Transitive fixes live in `pnpm-workspace.yaml` `overrides` (pnpm 11 no longer reads
`package.json#pnpm`): `nanoid`, `source-map-js`, `postcss`, `undici`,
`baseline-browser-mapping`, `esbuild` and `sharp`. Overrides are a **debt marker**, not a permanent
solution: remove one when the owning dependency ships a compatible fixed range.

## Procedure

1. `pnpm install` normally; then run `pnpm security:audit` (wraps `pnpm audit --audit-level high`).
2. Classify each advisory: production runtime, build-time tooling, or dev-only test tooling.
   Production runtime findings block a release; dev-only findings may ship with a recorded note.
3. Prefer widening a direct dependency to a fixed range. For transitive only, add a narrow override
   with the minimum patched version and a comment/owner in this file.
4. For a major upgrade (Next, better-auth, drizzle), run the local gates:
   `pnpm build` for workspace packages, `apps/web` `tsc --noEmit`, `next build`, root `node --test`
   suites, the full `apps/web` Vitest suite, `pnpm test:integration` where services exist, then let
   CI run the production build and real-stack Playwright. Browser-sign-in and admin SPA flows are the
   ones that catch auth/framework upgrades.
5. Record the before/after advisory counts and any residual risk in this file and the PR.

## Residual risk / notes

- `esbuild`/`@esbuild-kit` are pulled by `drizzle-kit`'s legacy loader chain (dev/build only); the
  override pins a patched esbuild. Revisit when drizzle-kit drops that chain.
- Vite advisories were reachable only through the Vitest dev server; the explicit `vite` pin keeps
  the resolved version patched.
- Overrides can hide compatibility problems: after any override change run the full local gates
  above, not only `pnpm install`.
- `pnpm-workspace.yaml` must stay UTF-8 **without a BOM**. A byte-order mark makes Turbo treat the
  workspace file as unreadable (it reports a recursive `turbo` invocation instead of a parse error),
  so keep edits to that file newline-normalised and byte-clean.
- `pnpm audit` needs registry access; it is intentionally not a CI gate yet, so a red audit never
  blocks an unrelated PR. Re-run it before every pilot release and after any dependency change.
- Secrets, customer data and provider credentials never belong in this workflow; no lockfile entry
  may contain a token or signed URL.
