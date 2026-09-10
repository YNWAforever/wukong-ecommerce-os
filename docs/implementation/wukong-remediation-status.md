# Wukong remediation — implementation status

Branch `codex/listing-grounding-diagnosis`. Baseline: HEAD was `9f72a37`, the
same commit the audit examined, so **no newer work supersedes any finding** —
"already fixed" can only mean the audit misread the source, never that a later
commit fixed it.

Companion records: [decisions](./wukong-remediation-decisions.md) ·
[verification](./wukong-remediation-verification.md)

## Phase 0 — diagnosis

**G0: partially met.** A reproducible source-level failure path is established
with deterministic offline tests. The historical run is **not** attributed, and
must not be reported as attributed.

### The failure path, reproduced

`assertFactsGrounded` required every non-null fact to appear verbatim inside one
of its own evidence excerpts. That is satisfiable by the synthetic note the
provider fixtures use (`product type wine; country Germany; volume 750 ml`) and
unsatisfiable by a photographed label. Since `ProviderOutputError` is in
`isTerminalProviderError`, a *correct* extraction of a real label terminalized
the listing to `failed` on the first delivery — no retry, no dead-letter, the
consumer acks — and discarded every fact extracted alongside the rejected one.

Rejection paths confirmed by test, each a legitimate extraction:

| Case | Why it was rejected |
|---|---|
| `productType: "wine"` | A four-value enum classification; no label prints the word |
| `volumeMl: 750` from `75 cl` | Unit conversion; 750 is not a number in the excerpt |
| `country: "France"` from `法國` | Translation; the value cannot quote itself |
| `abvPercent: 13.5` from `13,5 % vol.` | Tokenizes to 13 and 5; neither equals 13.5 |
| `field: "abv"` | Evidence field names were never given to the model |
| `Chateau Margaux` vs `CHÂTEAU MARGAUX` | NFKC composes accents rather than stripping them |

### What is NOT established

The observed run `3b958fe6-64e3-44bb-ac0c-13fa38ae60a3` **cannot be attributed
from source**. An independent adversarial review of six candidate failure paths
corrected every alternative down to low or ruled-out and left this one at
"medium" — disputing attribution of the historical run, not the mechanism.

One constraint does narrow it: the incident reported status `failed`, which
requires a thrown error. A `needs_info` outcome renders different copy, so the
missing-merchant-data path alone does not explain what was seen.

**To attribute it, this is the exact evidence needed:**

```sql
select r.status, r.error_code, r.result_status, s.step, s.state
from listing_pipeline_runs r
left join listing_pipeline_steps s on s.pipeline_run_id = r.id
where r.listing_id = 'ffc23109-7205-4d4d-b429-ca77706a239f';
```

Plus the Worker log line for that delivery, and the deployed Worker's configured
listing model — the source default is `gpt-5.6-terra`, and whether the deployed
model accepts image input was not readable from here.

## Audit findings at HEAD

Twelve of fourteen reproduce. None were already fixed.

| ID | Status | Addressed here |
|---|---|---|
| F04 normalization | still_reproducible | **fixed** — `b68210d`, `d1af2a7` |
| F03 needs_info / failed dead end | partially_fixed | **failed half fixed** — `1b69c36`; `needs_info` still blocked |
| F02 null facts block generation | still_reproducible | partly mitigated — facts now survive and are shown (`605a2ff`); `missingFields` still counts all 14 keys |
| F01 empty-body CRC32 on presign | still_reproducible | no |
| F05 no idempotency in intake | still_reproducible | no |
| F07 four disagreeing media policies | still_reproducible | no |
| F10 draft save requires canonical | still_reproducible | no |
| F13 second file selection replaces the first | still_reproducible | no |
| F06 create never starts image work | still_reproducible | no |
| F12 doctor passes while misconfigured | partially_fixed | no |
| F08 batches enqueue at sequence 0 | still_reproducible | no |
| F14 batch cost is all-history | still_reproducible | no |
| F09 approve without a dirty guard | still_reproducible | no |
| F11 no external enrichment stage | still_reproducible | no |

## Delivered

| Commit | What a user can now do |
|---|---|
| `5b00f91` | — (reproduction tests; Phase 0 evidence) |
| `b68210d` | A real label extracts without being rejected for converting a unit, translating a country, or classifying a type |
| `1b69c36` | Retry a failed listing instead of being told to contact support |
| `605a2ff` | See what the AI read off their photos, and which fields only they can supply, while the listing still needs information |
| `d1af2a7` | Same, for labels with accents, and for models that name evidence fields naturally |

## Next task, exactly

**Unblock `needs_info` re-runs** (decision D4). The queue key is
`listing:<workspace>:<draft>:<activeVersionSequence>`; a `needs_info` listing
never appends a version, so the sequence stays `0`, the key keeps resolving to a
run whose status is `succeeded`, and `POST /api/listings/[id]/process` answers
`409 processing_already_started` forever. Supplying the missing information
changes nothing.

Files: `apps/web/lib/listing-queue-runtime.ts` (key), `packages/jobs`
(`listingJobSchema` is strict — the Worker that reads both envelopes must deploy
before the web producer switches), `apps/worker/src/listing-pipeline.ts`,
`apps/web/app/api/listings/[id]/process/route.ts`.

Then, in dependency order: F10 partial save → F02 `missingFields` split →
F05/F01 intake idempotency and signing → F13 append-not-replace.

## Not started

Phases 2–5 in full. No migration was written, none was rehearsed, and no
deployment control was touched. SHOPLINE write settings are unchanged.
