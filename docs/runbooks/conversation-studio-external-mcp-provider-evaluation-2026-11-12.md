# External MCP provider evaluation checklist (C3, prepared 2026-11-12)

Status: **prepared, no provider approved**. `STUDIO_EXTERNAL_MCP_ENABLED=false` in production, the
connection registry is read-only, and `STUDIO_MCP_ENCRYPTION_KEY` is not set. This checklist is the
input the operator needs to approve the first external MCP connection; it is deliberately about
**evaluation**, not enabling anything.

## Hard requirements the client enforces

The outbound client (`packages/ai/src/mcp-client.ts`) refuses candidates that miss any of these, so a
provider that fails one is not eligible without a code change and review:

| Requirement                                                          | Enforced by                                     | Why                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `https:` endpoint only, no embedded credentials                      | `approvedEndpoint()`                            | plaintext bearer or userinfo tricks never leave the app                |
| Public hostname only (loopback/private/link-local/multicast refused) | `isPrivateEndpointHost()`                       | SSRF guard: a connection must not address the deployment's own network |
| No redirects                                                         | `redirect: "error"`                             | prevents forwarding the bearer to another origin                       |
| MCP protocol version `2026-07-28`, stateless JSON-RPC                | `MCP_CLIENT_PROTOCOL_VERSION`                   | only the tested protocol is accepted                                   |
| Stable advertised tool schemas                                       | sha256 pinned per allowlisted tool at approval  | drift fails closed with `schema_drift`, the call is refused            |
| Tool allowlist                                                       | registry approval + client check                | only reviewed tools are callable                                       |
| Bounded response                                                     | 64 KiB cap, 12 s deadline, no retries           | bounded latency and payload                                            |
| Content-only projection                                              | client projection                               | tool metadata/links are not passed through unprojected                 |
| Workspace-owned bearer credential                                    | `mcp-credentials.ts` AES-256-GCM `v1.<iv>.<ct>` | only an encrypted envelope is stored; no API returns it                |
| Separate encryption key                                              | `STUDIO_MCP_ENCRYPTION_KEY` (base64 32 bytes)   | a Studio compromise must not expose SHOPLINE secrets                   |
| Audited lifecycle                                                    | `studio.mcp.connection.*`, `studio.mcp.call`    | credential set/clear, probe, approval and calls are all recorded       |

Residual risk documented in the runbook: hostname checks are textual, so **DNS rebinding is not solved
here**; it is accepted only for an approved endpoint behind a provider with stable DNS.

## Questions the approver must answer

1. **Vendor and ownership.** Who operates the server, under which legal entity, and what data
   processing terms apply? Merchant listing text and notes are business content, not customer data.
2. **Data residency and retention.** Where do tool inputs/outputs live, for how long, and are they
   used for training? Prefer vendors that allow disabling content retention.
3. **Auth model.** Bearer is the only supported credential today. Who generates the token, what
   scopes does it carry, where is it stored on our side, and who rotates it?
4. **Tool inventory.** Which exact tools will be allowlisted, and do any of them **write** to the
   provider's system? C3 starts read-only; mutating tools are out of scope for this phase.
5. **Failure and rate behaviour.** What are the rate limits, quotas and retry semantics? The client
   never retries, so provider-side duplication must not be harmful.
6. **TLS and identity.** Who issues the certificate, and do we accept CA-based trust (the client does
   not pin certificates)?
7. **Logging.** Does the provider log request bodies? Can we keep prompts, customer content, tokens
   and signed URLs out of their logs?
8. **Revocation and incident contact.** How fast can a token be revoked, and who answers an incident?
9. **Content classification.** Which fields may we send (listing text, merchant notes) and which are
   forbidden (customer personal data, credentials, signed URLs)?
10. **Contract fit.** Do the provider's terms allow processing this merchant content for this purpose?

## Candidate classes

| Class                             | Effort  | Main risk                                                           | Note                                                        |
| --------------------------------- | ------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| Vendor-hosted official MCP server | lowest  | vendor custody of merchant content and the token                    | usual first choice if questions above pass                  |
| Self-hosted / internal server     | medium  | must expose a public `https` host; the client refuses private hosts | front it with a reviewed public endpoint; still pin schemas |
| Aggregator / marketplace          | highest | broad scopes, tool substitution, credential custody                 | requires an additional security review before even probing  |

## Walkthrough for evaluating one candidate (no production mutation)

Do this on a reviewed non-production environment (the rehearsal branch plus preview config), never
production:

1. **Key.** Generate a **separate** key: `openssl rand -base64 32`. Store it as an encrypted
   environment variable in the evaluation environment only; do not reuse SHOPLINE's key.
2. **Draft connection.** Create the connection with the candidate's `https` endpoint, set the bearer
   credential, and keep it unapproved. The admin probe only calls `initialize` + `tools/list`; it
   never calls a tool.
3. **Inventory.** Record every advertised tool name and its canonical schema hash. Review the schemas:
   reject tools with ambiguous write semantics or unbounded outputs.
4. **Pin.** Pin the hashes of the tools you would allowlist. Approval requires every allowlisted tool
   to have a pinned hash, plus an enabled connection, the workspace row enabled, the transport flag
   on and the encryption key present.
5. **Re-probe on change.** Any provider schema change shows as `schema_drift` and calls are refused
   until a human re-pins and re-approves.
6. **Rollback / rotation.** Clearing the credential, disabling the connection or setting
   `STUDIO_EXTERNAL_MCP_ENABLED=false` are independent kill switches. Rotating the encryption key
   invalidates every stored envelope, so clear and re-set credentials after a key rotation.

## What C3 does not unlock yet

The client, credential envelope, registry and admin probe are implemented and tested, but the only
live transport call today is the explicit **admin probe**; no Studio skill/agent call site invokes
external MCP tools yet. Approving a connection now makes it reviewable/probeable and pins its schemas;
agent-side invocation is a follow-on phase (C5 connector sequence), separately reviewed.

## Evidence to record when a provider is approved

- endpoint, vendor/owner, credential owner and rotation owner
- encryption-key environment and generation date (never the key itself)
- allowed tools + schema hashes, probe result and audit event ids
- approved environments and flag state
- decision date and approver

This file is the evaluation record; append the decision below when it exists.

## Decision log

| Date | Provider/endpoint | Decision | Approver | Notes |
| ---- | ----------------- | -------- | -------- | ----- |
| —    | —                 | none yet | —        | —     |
