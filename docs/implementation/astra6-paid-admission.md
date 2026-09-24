# Paid listing admission

Paid v2 operations default off. This is an application admission limit, not a guarantee about an external provider's final bill.

The initial reviewed registry permits explicitly configured OpenAI GPT-4o and GPT-4.1 identities. It does not change a workspace's selected model or route to another provider. Unreviewed models/providers return setup-required and manual saving remains available.

For each of four possible physical calls, reserve the full documented context window at the configured uncached input rate, plus the enforced maximum output at the configured output rate. This includes image/document tokens within the model context and is deliberately more conservative than estimating tokens from image count. A smaller arbitrary `maxInputTokens`, lower-than-reviewed price, or insufficient run ceiling is rejected both at admission and at execution. Each actual repair has its own pending invocation; transport replay cannot create another call at the same ordinal.

Registry evidence reviewed 2026-09-16:

- [OpenAI GPT-4o model documentation](https://developers.openai.com/api/docs/models/gpt-4o): context 128,000; standard uncached input $2.50/M and output $10/M.
- [OpenAI GPT-4.1 model documentation](https://developers.openai.com/api/docs/models/gpt-4.1): context 1,047,576; standard uncached input $2/M and output $8/M.

Operator-provided pricing can be more conservative. Activation still requires checking model availability, current prices and billing tiers, testing real authorized photos, and verifying matching web/Worker settings. The existing OpenRouter adapter and its tests remain available, but automatic paid v2 OpenRouter admission is gated until a specific routing/context/pricing contract is reviewed. No paid requests were used to prepare this implementation.

Unknown costs retain their reservations. Model estimates are labelled estimated; measured provider usage is labelled measured. Updating a price table is not retroactive proof of an unknown bill.
