# Marketing alignment — reference site vs shipped runtime

Status: handoff for the public site (`wukong-ops-suite`) after the P2 packaging
milestone. Date: 2026-11-18. Owner: product/runtime.

The reference site at
<https://wukong-commerce-orchestration.lovable.app/> is a strong marketing shell,
but several claims are broader than the runtime. This document is the claim-by-claim
source of truth so the public site can qualify or remove unsupported statements
without weakening the product story. The runtime equivalent is the reviewed
`CAPABILITY_REGISTRY` in `apps/web/lib/capability-registry.ts` and the Studio agent
catalogue in `apps/web/lib/studio/agents.ts`.

## 1. Rules

1. A public claim may never be stronger than the capability state: `Live`, `Pilot`,
   `Planned` or `Unavailable`.
2. "Pilot" means guided assistance with human review; it never means autonomous
   execution, approval or publishing.
3. Do not show a success state for a form unless the submission was persisted.
4. Do not publish self-serve prices, quotas or checkout until plans, entitlements,
   metering and billing exist.
5. Every agent and connector card should carry its state badge; the same wording
   should be used on the site and in the runtime.

## 2. Agent claims

| Public agent                 | Runtime state  | Allowed public copy                                                                                                          | Must not claim                                                                  |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Listing copy / listing draft | Pilot (guided) | Drafts listing content from catalog records for the existing review flow; a human reviews and the existing screens apply it. | Automatic listing creation, auto-publish, "fully autonomous".                   |
| Product image preparation    | Pilot (guided) | Prepares source images and a handoff card; the existing product-shot flow still handles processing.                          | New image generation, provider call, automatic image replacement.               |
| Content generation           | Pilot (guided) | Proposes copy with evidence; an editor adopts it.                                                                            | Writing product content automatically.                                          |
| Category mapping             | Pilot (guided) | Proposes category mappings with a confidence note; the existing catalog flow applies them.                                   | Automatic taxonomy changes.                                                     |
| Supplier intelligence        | Pilot (guided) | Compiles supplier fields from a linked workbook row; missing fields stay unknown.                                            | Supplier database, automatic supplier verification, web-wide supplier research. |
| Customer service replies     | Unavailable    | "Not available yet: no inbox or message data source exists."                                                                 | 24/7 auto-replies, WhatsApp integration, ticket automation.                     |
| SEO / Merchant               | Planned        | "Planned: no reviewed SEO/Merchant skill or feed generator ships yet."                                                       | Live Merchant Center feed, automatic SEO fixes, Google ranking outcomes.        |
| Logistics follow-up          | Unavailable    | "Not available yet: no order or shipment data source exists."                                                                | Order tracking, carrier integration, automatic fulfilment.                      |

The runtime presents these as a **guided agent suite**: each agent proposes, a
human reviews, and nothing runs or publishes automatically. The site must keep the
same qualifier anywhere "agent" appears.

Operator tools that are shipped and may be described as Pilot:

- catalog find (reads listing, quality and job records);
- listing standards / blocking-gap review (reads listing, quality and job records;
  export records are not read);
- workspace audit (read-only, versioned report; no listing changes).

## 3. Platform claims

| Platform               | Runtime state                                                                                                       | What the site may say                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| SHOPLINE               | Pilot connector; real writes are separately gated and production publish is disabled pending explicit authorization | "SHOPLINE connector in pilot; changes stay under human approval and the write gate." |
| Shopify                | Planned, not connected                                                                                              | "Planned connector; not available in the pilot."                                     |
| Carousell              | Unavailable                                                                                                         | Do not list as a connected destination.                                              |
| HKTVmall               | Unavailable                                                                                                         | Do not list as a connected destination.                                              |
| Google Merchant Center | Planned via SEO/Merchant; no feed generator                                                                         | "Planned; not available in the pilot."                                               |
| WhatsApp               | Unavailable                                                                                                         | Do not claim WhatsApp automation or templates.                                       |

The site currently implies multi-platform sync. Until a second connector is
implemented and tested, it must say **SHOPLINE first, more destinations planned**.
CSV fallback and the existing workbook imports may be described as pilot input
paths, not as platform sync.

## 4. Pricing and packaging

The runtime has no plans, entitlements, quotas, metering or billing. The Studio
settings card shows a **Pilot** agreement and recorded usage only. Therefore:

- Replace the three self-serve tiers (HK$299 / HK$799 / HK$1,999) with **Pilot
  packages / book a call**, with scope agreed per merchant.
- Remove "Start free trial" or similar CTAs until a trial can be provisioned
  without manual database work. Use **Request a pilot**.
- If indicative pricing must stay for sales conversations, label it clearly as
  "indicative, subject to a pilot agreement" and do not make it look purchasable.
- Do not promise seat counts, listing quotas, AI-run quotas or support SLAs that
  are not in the agreement.
- Add a short note: "Self-serve signup and billing are not available during the
  pilot."

The runtime's "Plan & usage" section deliberately shows no invented limits; the
public site should not invent them either.

## 5. Demo / trial intake

The reference site asks visitors to book a demo or upload products. Before showing
success:

1. Persist the submission through a real lead endpoint (planned commercial
   milestone; no runtime endpoint exists yet).
2. Show success only after a validated response; show a retryable error otherwise.
3. Collect only what is needed: name, work email, company, platforms, rough SKU
   volume, consent.
4. Add rate limiting and a bot check; do not rely on the client alone.
5. State retention and privacy terms; do not accept product files or customer data
   in the marketing form.
6. Never offer to "upload products" in the marketing app; warehouse that through
   the pilot onboarding path.

Until that endpoint exists, the CTA should be a mailto/contact action, not a form
that pretends to submit.

## 6. Claims to remove or qualify now

| Claim                                                           | Issue                                                                                             | Replacement                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| "8 AI agents automate your ecommerce operations"                | Customer replies and logistics have no data source; SEO is planned; all shipped agents are guided | "A guided agent suite for catalog operations — humans review every step."           |
| "Sync across Shopline, Shopify, Carousell, HKTVmall and Google" | Only SHOPLINE has a connector; writes are gated                                                   | "SHOPLINE connector in pilot; more destinations planned."                           |
| "3-minute listing"                                              | No measured median; the workflow includes human review                                            | "Guided drafts in minutes; review and approval remain human."                       |
| "24/7 customer service automation"                              | Unavailable                                                                                       | Remove; or "customer service is not part of the pilot."                             |
| "Logistics and order tracking"                                  | Unavailable                                                                                       | Remove; or "not part of the pilot."                                                 |
| "Enterprise knowledge base" / supplier database                 | Prompt versions, assets and audit exist; no supplier DB or vector KB                              | "Versioned prompts, source assets and audit history; supplier database is planned." |
| Three monthly pricing tiers                                     | No plans/entitlements/billing                                                                     | Pilot packages / book a call.                                                       |
| Free trial signup                                               | No self-serve provisioning                                                                        | Request a pilot.                                                                    |

## 7. Required badges and wording

- `Live` — production behavior with the stated guardrails.
- `Pilot` — available to pilot workspaces, human-reviewed, may be gated.
- `Planned` — not available; no CTA.
- `Unavailable` — no data source; explain why.
- Use **"Pilot (guided)"** for all eight agent cards except the planned SEO entry.
- Keep the state badge visible on mobile; do not hide it behind a tooltip.

## 8. Update protocol

When a reviewed skill or connector changes state:

1. Update `apps/web/lib/capability-registry.ts` and the Studio agent catalogue.
2. Update the marketing claim table in this document.
3. Update the public site in the same release window.
4. Re-run the claim review before publishing a new agent or connector page.

The runtime is authoritative. If the site and runtime disagree, the site is wrong
until the runtime capability state changes.
