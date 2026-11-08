# Conversation Studio release record — 2026-11-09

Status: **merged to `main` and deployed to production with every Studio flag off.** No live model,
external MCP, SHOPLINE write or workspace activation was performed.

## Shipped

- PR [#143](https://github.com/YNWAforever/wukong-ecommerce-os/pull/143) — 34 commits, merge commit
  `87459d83cbc7229983e8f0b3d270d749eb63fa2c`.
- CI run `42506384584` on Node 24, 25m19s, all steps green: frozen install, format/forbidden-runtime
  gates, build, migrations, lint, typecheck, root `pnpm test`, Opak integration regressions,
  production build, real-stack Playwright (including the Studio flags-off acceptance),
  `audit:verify` against the synthetic Opak draft, and wine/Queue acceptance.
- Migration `0056_studio_fk_indexes.sql` (added during CI remediation) covers the two composite
  Studio foreign keys the release-gate FK inventory requires.

## Production deployment

| Item                        | Value                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Deployment                  | `https://wukong-ecommerce-fsoeyw4vp-ynwaforevers-projects.vercel.app` (Ready, production, built from `main`) |
| Project alias               | `https://wukong-ecommerce-os.vercel.app`                                                                     |
| `/signin`                   | 200                                                                                                          |
| `/` unauthenticated         | 307 → `/signin?callbackUrl=%2F`                                                                              |
| `/studio` unauthenticated   | 307 → `/signin?callbackUrl=%2Fstudio` (flag off; authenticated route still returns 404)                      |
| Studio APIs unauthenticated | 401                                                                                                          |
| `POST /api/mcp`             | 404 (hosted MCP flag off)                                                                                    |

### Readiness log scan (best effort)

`vercel logs --environment production --limit 200 --json` returned 50 recent production log lines.
Scanned for OpenAI-style keys, bearer tokens, Postgres URLs, AWS signatures, password/API-key
fields, SHOPLINE token prefixes and prompt-injection markers: **0 matches**. This is an automated
sample, not the human log-review sign-off the release gate requires.

## Not activated (deliberate)

- All `CONVERSATION_STUDIO_*` / `STUDIO_*` flags are unset (default off).
- Production env names contain no `OPENCODE_GO_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`, so
  live analysis cannot be turned on safely even if the workspace were configured.
- Deterministic Studio activation would additionally require: applying migrations `0054`–`0056` to
  the production database, enabling the pilot workspace's `studio_workspace_settings` row, setting
  `CONVERSATION_STUDIO_ENABLED=true` in Vercel and redeploying, then an authenticated production
  acceptance run. No production user credentials are available in this environment, so the
  authenticated acceptance could not be verified; activation was therefore withheld.
- No external MCP connection is approved or live; no SHOPLINE write was made.

## Rollback

- Web: promote the previous production deployment in Vercel (deployment `h31irvdbo`, 2026-11-09) or
  revert `87459d83` on `main` and redeploy; no data migration is involved for a flags-off deployment.
- Production schema is unchanged by this deployment: migrations `0054`–`0056` were **not** applied to
  the production database.
