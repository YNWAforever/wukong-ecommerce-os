# Native auth submission repair — 2026-10-03

ST25 / T08 was reproduced during the isolated synthetic browser rehearsal: submitting the server-rendered password form before hydration used the browser's default GET method. Named credential fields consequently entered the navigation URL. The shared form now explicitly uses POST. Its hydrated handler still prevents native navigation and calls the existing server authentication APIs.

The failed rehearsal also exposed the owned synthetic operator password in an incorrectly printed error excerpt. Only that isolated account was rotated: the old hash was rejected, the replacement verified, twelve sessions were revoked, and the private fixture was updated. Eight scope/rotation assertions passed. The staging endpoint returned to disabled/idle. Production accounts, provider keys and other actors were untouched. Original private failure evidence remains outside Git; raw URLs, passwords and errors must not be published.

## Verification

| Check                                                    | Actual result                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Real SSR form, JavaScript disabled, old isolated Preview | RED: intercepted native request was GET instead of POST                                                    |
| Same helper, newly production-built owned loopback Web   | GREEN: five assertions; POST, no email/password query fields, both fields in body; owned server terminated |
| Auth form and sign-in unit files                         | 56/56 passed                                                                                               |
| `pnpm test`                                              | exit 0; Web 2,275/2,275; fourteen Turbo tasks successful, thirteen valid cached tasks                      |
| `pnpm lint` / `pnpm typecheck`                           | exit 0; fourteen tasks each; lint here is TypeScript                                                       |
| `pnpm build`                                             | exit 0; eight tasks, Web freshly built                                                                     |
| Focused browser helper strict TypeScript check           | exit 0                                                                                                     |
| Prettier / `git diff --check`                            | passed after formatting the form                                                                           |
| Runtime format / forbidden-runtime checks                | exit 0; no forbidden runtime dependencies/imports/services                                                 |
| `pnpm release-gate:check`                                | six machine checks passed; fourteen human gates remain, no production sign-off                             |
| Independent review of the three-file code/test delta     | no Critical, Important or Minor actionable finding                                                         |

`tests/e2e/auth-native-submit-checks.ts` exercises the actual rendered form in a fresh JavaScript-disabled context. It intercepts native navigation before application/provider dispatch and uses non-account synthetic fields. Assertions report booleans and method only. The existing Opak account-assignment browser spec invokes it in the existing CI gate.

This proves safe native submission, not working authentication without JavaScript: the page does not implement a native POST authentication handler. The normal hydrated password/session flow is covered separately. The predecessor head `8773a61ab1c3a6689d0e84618494bc3ac8488543` completed [CI37106290279](https://github.com/YNWAforever/wukong-ecommerce-os/actions/runs/37106290279) successfully; that result does not cover this new application delta. New-head CI and guarded isolated Preview smoke must be recorded separately before merge.

Executed follow-up: auth source `0b398a7b4ff3b5b8f9c3dccde8aae91a2eef192b` completed [CI37111215982](https://github.com/YNWAforever/wukong-ecommerce-os/actions/runs/37111215982) SUCCESS and Vercel checks passed. Its guarded isolated733 Preview is READY/exact alias; v22's32/32 checks include the same native helper and actual hydrated reviewer/operator password200/session/logout200/401. [Cloud receipt and scope](./opak-staging-browser-auth-2026-10-03.md) preserve intermediate failures and the independent watchdog/disabled compute stop. The later evidence-only head requires its own checks; production/merchant gates remain open.

## Configuration and rollback

No migration, dependency, provider key or application environment name changes. Keep POST when choosing a compatible rollback Web; reverting to the previous form restores the credential URL risk. Preserve server-session authorization, workspace/RLS, audit, queue/cost/manual/source/version protections and the corrected Worker Object Read-only credentials. Hold queues/cron/ingress and compute outside bounded staging windows. Production schema/security/recovery gates and the separate first real SHOPLINE write confirmation remain open.
