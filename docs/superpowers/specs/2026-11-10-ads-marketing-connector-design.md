# Ads and marketing connector design (C5) — read-only insights first

Status: **proposal, not approved.** Nothing here authorises a provider call, credential, migration,
flag or external MCP connection. It records the design decision the roadmap's C5 asks for, so the
next implementation slice can start once the five decisions at the end are answered.

Direction: the user's target is an Ads-Copilot-like surface inside the Commerce Orchestration OS.
Phase 1 therefore optimises for **read-only campaign insight and reviewable proposals**, never
budget changes, bids, creative edits or publishes.

## 1. Phase-1 scope

In scope:

- connect one ads/marketing data source per workspace (Meta Ads, Google Ads, or a provider MCP that
  fronts them);
- answer questions such as "how did the two active campaigns perform last week versus the prior
  week?";
- produce an `ads.performance_review` artifact: deterministic metrics evidence, a labelled
  model-written narrative, and optimizer **suggestions** with a clear `not applied` state;
- hand off to the existing review surfaces (no canonical writes) and export JSON/PDF with the same
  signed receipt path as other artifacts.

Explicitly out of scope for phase 1: any ad-platform write (budget, bid, pause, creative, audience),
OAuth flows that require user data beyond read scopes, unattended scheduling (see the separate
scheduled-runs proposal), and cross-workspace benchmarking.

## 2. Two viable transports

### Option A — approved external MCP connection (recommended first)

Reuse the shipped C3 machinery: admin-created draft connection, pinned tool allowlist and
advertised-schema hashes, encrypted per-workspace credential, approval requires
`STUDIO_EXTERNAL_MCP_ENABLED` + workspace Studio enabled + valid encryption key, quotas, SSRF
public-host guard, content-free call ledger.

- Tools would be read-only, e.g. `campaigns.list`, `campaigns.metrics`, `adsets.metrics`,
  `creatives.metrics`; no tool that mutates a platform may be allowlisted.
- Requires a trustworthy MCP provider (vendor-hosted or self-hosted adapter). Today the outbound
  client is dormant and no call site instantiates it, so this needs an explicit reviewed wiring.
- Failure modes are already bounded: schema drift fails closed, quotas return JSON-RPC `-32029` /
  `-32030`, transport errors land as `unavailable` ledger rows.

### Option B — direct read-only adapter in `packages/ai`

A thin adapter per platform (OAuth/test-account token, read endpoints, response projection and
schema fingerprint), following the existing Tavily/Photoroom adapter pattern.

- More code and platform API churn, but no third-party trust hop and no OAuth to a vendor MCP.
- Credential storage would reuse the same encrypted-envelope approach as MCP credentials.
- Recommended only if a trustworthy MCP provider is unavailable for the pilot platform.

**Recommendation:** implement Option A behind a new default-off flag
`STUDIO_ADS_CONNECTOR_ENABLED`, with a fake MCP provider in tests and a sandbox ad account in
acceptance. Keep Option B as the fallback if provider/commercial terms do not fit.

## 3. New capability and artifact

- Skill key `ads.performance_review`, version `1.0.0`, deterministic evidence first: normalized
  campaign/ad-set/creative rows with explicit currency, date range and attribution note.
- The model, when configured, only writes a narrative and ranked suggestions over those evidence
  rows; ungrounded claims are dropped and counted exactly like the existing skills. Prompt versions
  stay pinned per operation.
- Artifact reuses the existing `gap_report` kind in phase 1 to avoid a migration; a dedicated
  `ads_review` kind is a later, additive change if the UI needs it.
- Output copy must state: read-only data source, date range, currency, "suggestions are proposals and
  have not been applied", and any missing metric as unavailable rather than zero.
- Capability registry stays blocked until a recorded acceptance run exists on the pilot workspace.

## 4. Security, privacy and cost

- Read-only scopes only; no ad-platform write scope is requested in phase 1. Ads writes would be a
  separate decision with its own gate, mirroring SHOPLINE's write gate.
- Credentials: workspace-scoped, encrypted envelope, never returned by any API, never logged; admin
  rotation/disable path required before approval.
- Egress: existing public-host SSRF guard; add a resolve-and-verify or egress allowlist for the
  chosen provider host once the provider is named (the residual DNS-rebinding risk remains today).
- Quotas: per-token minute/month ceilings and the 100-active-token cap apply; per-run budget
  reservations and the deterministic-first rule keep model cost bounded.
- Logs and ledger: tool names, statuses, latencies and digests only — no campaign names, spend
  values, creative text or audience data.
- Data: marketing metrics are workspace-confidential; exports use the existing signed receipt and
  no PII should flow through prompts.

## 5. Acceptance plan (fake provider first)

1. Fake MCP server advertising the allowlisted read tools with pinned schema hashes.
2. Tests: schema drift, quota exceeded, disabled/revoked credentials, cross-workspace isolation, no
   write tool reachable even if advertised, ungrounded-claim dropping, budget exhaustion.
3. Browser acceptance with flags on and the fake provider: ask a performance question, see evidence,
   labelled narrative, suggestions and explicit not-applied state; reload persists the thread.
4. Live acceptance only after decisions: sandbox ad account, one recorded review, spend/limit
   evidence, then capability registry change.

## 6. Rollout and rollback

- Default-off flag plus admin approval gate; enable per pilot workspace only after acceptance.
- Rollback: disable the connection or `STUDIO_ADS_CONNECTOR_ENABLED`, revoke the credential, redeploy
  web; no database migration is required for phase 1.

## 7. Decisions required from the user

1. **Platform/provider:** which ads source first (Meta Ads, Google Ads, or a named provider MCP), and
   whether a vendor-hosted MCP is acceptable.
2. **Credential ownership:** who owns the ad-account credentials and the OAuth app; per-workspace or
   per-deployment.
3. **Read-only confirmation:** confirm phase 1 forbids all ad-platform writes (recommended).
4. **Data policy:** retention and export rules for marketing metrics, and whether external model
   narrative is allowed over them.
5. **Pilot scope and budget:** pilot workspace, reviewer, date range and the model budget for the
   first recorded review.
