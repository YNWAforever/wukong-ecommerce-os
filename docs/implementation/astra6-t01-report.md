# Astra 6 T01 compatibility readiness

Date: 2026-09-16 (Asia/Hong_Kong)
Branch: `codex/astra6-recovery`
Baseline: `63a6f762e67ebcc1d106334b59b04b45afe3d6b4`

## Scope and result

This is release preparation for T01 / A03 / A05. It does not mutate a remote or production database. The checker reports a bounded compatibility version, readiness boolean, and capability names only; it does not expose catalog definitions to ordinary callers.

`t01-0023-0027-v1` asserts:

- 0023 outbox existence, forced RLS, workspace policy, and the exact `wukong_app` table privileges;
- 0024 function existence, security-definer mode, PUBLIC revocation, `wukong_app` execution, oldest-first ordering, and bounded attempts;
- 0025 nullable/no-default historical semantics and the JSON-array constraint;
- 0026 both legacy and row-digest attestation eras, missing-attestation rejection, and function grants;
- 0027 nullable/no-default historical semantics and the JSON-object constraint.

Run a safe read-only check against an already identified environment:

```powershell
$env:DATABASE_ADMIN_URL='<identified read-only/admin connection>'
pnpm.cmd --filter @wukong/db exec tsx src/cli/schema-compatibility.ts
```

Exit code `0` means every capability is present; exit code `2` means activation must remain disabled. The output contains only the version, readiness, and missing capability identifiers.

## Disposable migration rehearsal

The opt-in test refuses non-loopback hosts and any database name other than `t01_compatibility`:

```powershell
$env:T01_REHEARSAL_DATABASE_ADMIN_URL='postgres://wukong:wukong@127.0.0.1:54329/t01_compatibility'
$env:T01_REHEARSAL_DISPOSABLE='yes'
pnpm.cmd --filter @wukong/db exec vitest run src/schema-compatibility.integration.test.ts
```

The rehearsal covers an empty database, a second full replay, and the observed old shape through 0022 followed by 0023-0027. The old-shape case verifies that an existing export attempt remains present with `source_attestation IS NULL` and that the new constraint rejects an object value.

Local evidence on 2026-09-16:

| Check                                  | Result                     | Limit                                                                                                                         |
| -------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Focused compatibility unit test        | 3/3 passed                 | Catalog executor is injected                                                                                                  |
| Disposable fresh + old-shape rehearsal | 2/2 passed in 4.17 s       | Local Postgres 17; no production-shaped data clone                                                                            |
| `@wukong/db` unit suite                | 17 files, 106 tests passed | Integration tests excluded by package script                                                                                  |
| `@wukong/db` typecheck                 | blocked                    | Concurrent T03 schema/repository work: `listing-inputs.ts` references `inputDigest` before the shared schema edit is complete |
| `git diff --check`                     | blocked outside T01 files  | Existing/concurrent blank EOF lines in `workflow.ts`, `audit-verify.ts`, and `client.ts`                                      |

## Expand, compatibility, activation

1. Expand: apply the additive migration chain to the identified DB while old web and Worker builds remain paused from producing new-contract work.
2. Compatibility: run this checker, then run repository integration tests with the non-superuser `wukong_app` role. Keep affected operations disabled if the report is not ready.
3. Deploy Worker before any web producer that emits a newer strict message contract. Reconfirm Worker build and schema report.
4. Deploy web. Reconfirm web build, Worker build, DB identity, and schema report.
5. Activate only the bounded capability whose runtime and canary gates passed.

Application rollback keeps the expanded additive schema. Pause producers first, roll web and Worker back to their paired compatible builds, preserve queued identities and evidence, and rerun the checker. Do not drop the added columns/table or rewrite historical rows as a default rollback.

## Open gates

| Evidence            | State                                                          |
| ------------------- | -------------------------------------------------------------- |
| specified           | yes: T01, A03, A05                                             |
| implemented         | checker and isolated rehearsal support present in working tree |
| locally verified    | unit and disposable migration checks above                     |
| preview verified    | not run                                                        |
| production verified | not run; no production DB mutation or catalog check            |
| merchant accepted   | not run                                                        |

A01 still needs an identified Worker build and live DB fingerprint. A05 still needs mixed-version queue/consumer fencing, pause/resume, and rollback rehearsal against the complete T03 operation contract. Production migration, deployment, and real-provider canary remain explicit release actions outside this task.
