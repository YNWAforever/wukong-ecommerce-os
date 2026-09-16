# Astra6 implementation baseline and release evidence

## Identity and preserved work

Verified on 2026-09-16 (Hong Kong): `origin` is `YNWAforever/wukong-ecommerce-os`.
The original checkout was `claude/bulk-approve-error-handling` at `c65b139`.
After fetching, `origin/main` was `63a6f762e67ebcc1d106334b59b04b45afe3d6b4` and contained the original checkout's commits.
Implementation uses the isolated `codex/astra6-recovery` worktree, starting from that main HEAD.
The original checkout's untracked configuration, caches and continuation document were preserved.

The implementation pack's start document, all numbered documents, references, validation document and checksum manifest were read completely. The pack supplies requirements; it does not authorize production mutation, merchant writes or paid canaries.

## Live read-only observations

| Surface                      | Observed evidence                                                                                                                                            | Meaning                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Vercel production alias      | `wukong-ecommerce-os.vercel.app`, READY deployment `dpl_FxePMdib2r4ctE9tSJV8dhXHP1C3`, source SHA `63a6f762e67ebcc1d106334b59b04b45afe3d6b4`                 | Web is on the audited baseline; these local changes are not deployed.                                           |
| Cloudflare production Worker | `wrangler deployments list --name wukong-runtime-production` showed latest 100% version `104d48d8-efbf-4bed-bb3b-c71c4ba750e4`, created 2026-09-07 19:35 UTC | Worker version identified. Its embedded Git SHA and signed-health agreement with web remain unverified.         |
| Audited Neon project         | `weathered-lake-51694428`, project name `neon-amethyst-battery`, primary branch `br-twilight-meadow-at9qky4q`, database `neondb`                             | Reidentified via Neon project and branch metadata.                                                              |
| Catalog                      | `listing_drafts`, `listing_pipeline_runs`, `review_confirmations` present; `listing_dispatch_outbox` and `listing_input_revisions` absent                    | Schema reconciliation remains a production gate. Presence checks do not certify every constraint or permission. |
| Audited failed operation     | Run `891c79f8-49e3-4519-ad07-1c391bf755ea`, listing `9283f67a-ac12-496c-86e7-c7f71936dd21`: failed, `provider_failure`, two step rows, zero AI usage rows    | Original provider cause and charge cannot be recovered from this metadata. No paid replay was performed.        |

No production deployment, migration, provider request, SHOPLINE write, secret change or merchant acceptance was performed.

## Implemented contracts under verification

- Working inputs and append-only revisions exist independently of generated versions. Manual saving is available without AI.
- Source order, analysis/reference role, hero selection, operator ownership and locks are persisted.
- Explicit processing creates a new run with pinned inputs, observed base version, request digest and transactional dispatch outbox. Failed attempts are not reopened.
- A response-loss replay returns the original create/run identity; a changed payload conflicts.
- A newer correction prevents an older generation from becoming current. Retained candidates require explicit selected-field adoption with fresh revision checks.
- Provider invocation rows start before network I/O. Pending/unknown charges retain a budget hold; no automatic paid resend occurs for a recorded physical call.
- Paid v2 processing defaults off. Web and Worker must agree on `LISTING_PAID_OPERATIONS_ENABLED`, provider and an approved workspace policy. The policy must contain a model's conservative maximum input/context including image tokens, bounded output, worst-case pricing, pricing version, run ceiling and workspace cap. Four physical requests cover extraction/generation plus their single repairs. Unverified bounds are not a release approval.
- Save-and-process is atomic: admission failure rolls back that operation and retains local edits for save-only. Create can retain a manual draft and report AI admission unavailable.

## Release order and explicit gates

1. Rehearse the complete migration runner against fresh and drifted disposable databases, including replay with physical invocation costs that remain NULL.
2. Reconcile production schema through the approved deployment process. Check RLS, grants, function behavior and new recovery capabilities, not file names alone.
3. Deploy compatible consumers first; verify their revision and safe health metadata. Drain/inspect legacy in-flight work before enabling v2 producers. Never replay failed historical paid calls blindly.
4. Deploy web producers with paid processing disabled, verify saved/manual recovery and outbox/run identity.
5. Only after approved pricing/context bounds and budget configuration, authorize a small real-photo paid canary. Record provider request identity, physical usage and resulting draft behavior.
6. G0/G1 real-photo and merchant acceptance remain separate from local fake-provider tests. SHOPLINE delivery and the two-week merchant pilot require their own evidence and authorization.

T09 is not complete merely because unit tests pass. T10–T22 and their enabled-capability gates remain subject to the dependency order in the pack; existing repository features are not automatically accepted against the new requirements.

## Tool limitation

Automatic approval review rejected graph indexing because the indexer could transmit repository contents to an unspecified destination. Local source discovery was used instead. This did not block local implementation. Windows sandbox helper ACL failures also required approved local command execution.
