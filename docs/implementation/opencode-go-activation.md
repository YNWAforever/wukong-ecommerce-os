# OpenCode Go activation — 2026-09-16

## Verified compatibility

The local, secret-safe probe returned HTTP 200 from the Go endpoint with model
`deepseek-v4.1-flash`, valid JSON and correct recognition of a synthetic red PNG.
Elapsed: 2419 ms; input: 288 tokens; output: 46 tokens. No merchant photo was used.
The key was held in the probe process only and cleared when the probe finished.
This proves basic protocol and vision compatibility, not merchant acceptance or
provider approval for this workload.

## Implementation

- Provider identity: `opencode-go`; Worker-only secret: `OPENCODE_GO_API_KEY`.
- Model: `OPENCODE_GO_LISTING_MODEL=deepseek-v4.1-flash`.
- Fixed endpoint: `https://opencode.ai/zen/go/v1/chat/completions`.
- Honest Wukong user agent and immutable operation ID as `x-opencode-session`.
- JSON mode with the schema in the prompt; all existing grounding and protected
  commercial-field validation remains local. One bounded repair, no SDK retries.
- No model/provider fallback. Legacy jobs require a new immutable operation.
- JPEG/PNG/WebP supported; analysed PDFs rejected before paid admission.
- Missing usage stays unknown. Go tokens are measured; dollar-equivalent usage
  is estimated at peak rates, with no assumed cache discount. Subscription quota
  accounting is not a claim about an actual cash invoice.

## Reviewed budget bound

[Go pricing and endpoint](https://opencode.ai/docs/go/) reviewed 2026-09-16:
input USD 0.30/M, output USD 1.20/M at peak. No temporary promotional quota is
used as a permanent application budget. The subscription's `Use balance` setting
is external and is not enabled by this integration.

[DeepSeek model documentation](https://api-docs.deepseek.com/quick_start/pricing/)
lists 1M context; the reservation conservatively uses 1,048,576 input tokens on
each of four possible physical calls, plus 4096 output tokens each. Reservation:
USD 1.277952 per full operation. Lower off-peak pricing is not used for admission.
The previous OpenAI unknown-cost reservation remains intact.

## Activation and acceptance gates

Code support alone does not enable production traffic. Activation requires the
Go secret in the Worker, matching producer/Worker provider flags, an approved
workspace policy and budget, and the paid-admission flag. Historical runs and
accepted execution snapshots must never be rewritten to switch providers.

Outstanding: install dedicated secret, approve the ongoing workspace budget and
merchant-photo transfer to Go, deploy matching versions, then verify an actual
photo-to-review operation and merchant acceptance. SHOPLINE stays disabled.

Go's documentation describes coding-agent traffic. This application identifies
itself honestly; basic compatibility does not establish long-term service
eligibility for product-listing traffic.
