# Wukong recovery workspace — operator guide

This guide describes the implementation on `codex/astra6-recovery`. Screenshots and automated checks use synthetic local fixtures. Production activation and merchant acceptance are separate release gates.

## Create and correct a draft

1. Open **New listing**. Select JPEG, PNG or WebP photos, or one PDF. Consecutive selections append; remove individual files and reselect them if needed. Convert HEIC before uploading. Each source is limited to 20 MiB; decoded photos to 40 million pixels; PDFs to 40 pages. Encrypted or malformed PDFs are rejected.
2. Add a source note. A note alone can create a draft. Choose manual save when AI is unavailable or unnecessary. Unknown facts can remain blank.
3. A finalized upload keeps its asset identity when creation or the response fails. Retry the displayed failed step. Do not assume an upload failed merely because draft creation failed.
4. Open the persistent working draft. Correct merchant SKU, price and stock explicitly; model evidence does not establish merchant inventory. Edit product facts, bilingual copy, source roles, analysis/reference use, order and hero selection.
5. **Save draft** persists a new input revision without requiring AI. Reload confirms the saved revision and values. Lock a field to make its protection explicit; operator-entered values are preserved even when unlocked.
6. **Save and process with AI** requires an admitted provider and budget. If admission fails, the combined save/process transaction rolls back and the editor retains the unsaved changes. Use **Save draft** to save without AI. Initial creation can retain a manual draft while reporting blocked AI admission.

## Recover from processing failure

- Use the current operation shown on the listing, not an older job's status. A queued operation can remain queued while its durable outbox retries delivery.
- A deliberate retry creates a new run with a parent reference. It does not erase or reopen the failed run. A compatible completed extraction may be reused; prompt, policy and input changes prevent unsafe reuse.
- Saved corrections supersede an old input snapshot. Late results remain candidates and cannot silently replace the corrected document.
- Inspect a retained candidate and explicitly select compatible fields to adopt. Do not infer that a failed run had no provider cost. Unknown outcomes retain budget holds until reconciled.
- Record listing ID, current run ID, input revision, safe error category and observed time when requesting support. Do not copy credentials or supplier documents into an incident log.

## Images, review and delivery

- Image preparation is separate from text processing. It can start from saved source input before a text version exists. Image approval still requires the saved text version and current source context.
- Save complete bilingual title, description and SEO fields before promoting a manual document to a review version. Workspace-required facts are checked again on the server before approval.
- Dirty edits disable review confirmation and approval. Source or content changes invalidate affected checks. A concurrent review produces a conflict; reload and review the new state.
- Approve the exact saved version and confirmation revision. Unapproved partial content is a recoverable draft, not a delivery-ready artifact.
- Existing-product Bulk Update and new-product creation/export are different workflows. Keep remote IDs, source import, row digest and approved content aligned. A generated artifact is not proof that SHOPLINE accepted it.
- Record operator-reported acceptance separately from follow-up export comparison or independently verified remote state. Real merchant writes require the existing attended first-write authorization.

## Matched website evidence

Open the working draft's evidence lookup and supply an explicit public product URL plus product identity. The server applies public-network, redirect, robots and workspace-domain policies. Product, variant, vintage, volume, pack and market mismatches remain unresolved. Inspect current and proposed values and their actual URL excerpts; adopt selected supported fields explicitly. Website observations are not automatically labelled authoritative or independently verified.

## Batches and workspace settings

- Batch outcomes refer to their bound immutable runs. A listing becoming ready in another operation does not prove this batch succeeded.
- Pause prevents new pending claims. Cancellation fences eligible work; it is not evidence that an in-flight provider call stopped or was refunded. Retried selections create new identities while preserving history and cost ownership.
- Administrators can edit workspace name, brand voice, content guidance, required fields, source-domain restrictions and existing image background settings. Concurrent policy changes require reload before overwriting.
- Usage separates settled amounts, active holds and unknown-outcome holds. The displayed admission cap is cumulative application accounting, not an external provider billing guarantee. Paid activation, provider credentials and reviewed pricing bounds are not enabled by this settings form.

## Current evidence and release limits

See the task reports in this directory and `evidence/astra6`. Local synthetic evidence does not establish real-photo quality, provider billing, deployed web/Worker agreement, SHOPLINE acceptance, a two-week shadow pilot, or merchant time savings. Preserve those gates until their named owners supply actual evidence.

For rollback, stop new producers first, retain immutable input/run/evidence rows and queued identities, and use a web/Worker pair compatible with the additive schema. Do not run destructive down-migrations or blindly repeat an unknown paid attempt. Production backup/restore, canary and rollback exercises require their own environment-specific evidence.
