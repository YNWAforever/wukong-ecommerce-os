# Retained review quality metrics (contract v1)

`GET /api/quality.reviewMetrics` reports **observations of retained workspace
records**, not model accuracy, reviewer effort, rejection rate, or independently
verified human activity. `ai_runs.output` is not used: its default `{}` supplies
no model-output baseline. Existing active-version gaps and all-history AI cost
retain their separately documented full-workspace bounded-scan semantics.

The route injects one clock (`now`, default current time). The window is exactly
30 elapsed days, **[start, end)**, with end equal to that clock. All new evidence
is read in one SQL statement and one MVCC snapshot inside `forWorkspace` under
RLS. This does not make the separate gap/cost scan a common snapshot. Records
committed after the statement snapshot are not observed, even if backdated.

| API metric                 | Population and numerator / denominator                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approvalFraction`         | All distinct retained versions created in the window, including imported, pipeline, manually edited, superseded and currently unapproved versions. Numerator: cohort versions with at least one qualified `listing.approved` audit by end. Denominator: all cohort versions. It is a version approval fraction, not review-decision acceptance rate. Newer versions are right-censored and may be approved later.                     |
| `creationToApprovalMs`     | Same cohort's qualified approved versions only. Numerator: sum of milliseconds from version creation to the earliest qualified approval. Denominator: number of those versions. UI converts the resulting mean to hours; API numerator remains milliseconds. Creation time is not review-start time. Unapproved versions are excluded, not assigned zero latency.                                                                     |
| `humanEditedFieldFraction` | Recorded `review_events.action = listing.edited` in the window, deduplicated by listing/base-version/edited-version. Numerator: changed fields after NFC normalization. Denominator: eight times the number of qualified pairs. This normalized **field Hamming distance** treats each changed field equally; it is not character/token edit distance or AI-to-human distance. Baselines may be human, imported or pipeline versions. |

Approval qualification requires metadata.versionId to identify a retained version
in the cohort and audit.entityId to identify that same listing in the same
workspace. Approval time must be at or after version creation. Multiple valid
audits for a version collapse to the earliest; later valid records increment
`duplicateApprovals`. Invalid references, negative intervals and approvals of
outside-cohort versions increment `invalidOrOutsideCohortApprovals`. Events
outside the window (including future events) are outside the population and are
not counted as exclusions. `listing.transition` lacks version identity and is
not joined to a version by guessed time proximity. This metric uses the explicit
version-bound domain approval audit, not current status or capped audit history.

Edit pairs join **both workspace and listing**, as well as exact version IDs.
Both retained contents must supply all eight nonempty projected fields. The
edited version must immediately follow the base sequence, be non-pipeline, and
have createdBy matching the recorded nonempty event actor. Base creation must
precede or equal edited-version creation, which must precede or equal every
qualifying event's time. Conflicting actor evidence invalidates the whole pair;
invalid pairs/events increment `invalidEdits`. Compatible retries count once and
increment `duplicateEdits`. Metadata.changedFields is a top-level hint from the
edit route, not the eight-field measurement; actual immutable content is compared.

The eight fields mirror the Bulk Update projection:

| Field                               | Retained content                                |
| ----------------------------------- | ----------------------------------------------- |
| nameZh                              | title["zh-Hant"]                                |
| summaryEn / summaryZh               | description.en / description["zh-Hant"]         |
| seoTitleEn / seoTitleZh             | seo.title.en / seo.title["zh-Hant"]             |
| seoDescriptionEn / seoDescriptionZh | seo.description.en / seo.description["zh-Hant"] |
| seoKeywords                         | tags joined with `, `, as in Bulk Update export |

English name, identity, pricing, inventory, logistics, images and other fields
are excluded. NFC preserves multilingual text equivalence; case, markup and
nonempty whitespace differences remain meaningful. Empty/whitespace-only fields,
missing structures, empty/malformed tags, unavailable joined versions, invalid
sequence/actor/time evidence and oversized content are unqualified, never
silently converted to empty strings. No merchant content is returned in the API
metric result or logged.

Approval totals are full SQL aggregates, not capped samples. Edit hydration reads
at most 1,001 events ordered by time then ID. More than 1,000 events makes the
entire edit metric unavailable (`evidence_limit`, null numerator, denominator,
value and edit exclusion counts); no partial-population fraction is emitted.
Each retained content document is projected only when its serialized JSON is at
most 16,384 UTF-8 bytes; larger content becomes unavailable evidence. Comparing
at most 1,000 pairs is linear in this bounded content, with eight NFC comparisons
per pair and no quadratic character-distance algorithm. Approval SQL still scans
the complete window's relevant metadata; its transferred result is constant size.

Every metric returns `{value, numerator, denominator, reason}`. Empty qualified
populations have `value: null`, numerator/denominator zero and
`reason: no_qualified_evidence`. A real populated cohort with zero observed
approvals truthfully returns fraction zero. Exclusion counts disclose missing or
invalid evidence and do not imply complete historical event retention. UI labels,
window, units, denominator and unavailable explanation follow the shared locale.
There is no migration, backfill, model-output logging or synthetic legacy evidence.
