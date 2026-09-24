import { readCopyClaimSupports } from "./listing-claim-support";
import { createHash, randomUUID } from "node:crypto";
import {
  enrichmentIdentitySchema,
  matchWebsiteProduct,
  savedMarketVariant,
  sameProductIdentity,
  extractWebsiteClaims,
  externalClaimSchema,
  scanCompliance,
  evaluateExternalClaimSupport,
  renderExternalClaim,
  claimIdentitySnapshot,
  type ClaimCopyField,
  normalizeWebsiteUrl,
  readWorkingField,
  workingBaselineForReview,
  type EnrichmentIdentity,
  type EnrichmentField,
} from "@wukong/core";
import {
  listingInputDigest,
  type Database,
  type ListingEnrichmentSuggestion,
  type WorkspaceRepositories,
} from "@wukong/db";
import { createPublicFetch, type PublicFetch } from "./website/public-fetch";
import { parseRobots, isRobotsAllowed } from "./website/robots-policy";
import { extractDocument } from "./website/extract-document";
import { ApiError } from "./route-support";
function fail(code: string, message: string): never {
  throw new ApiError(409, code, message);
}
async function observed(repos: WorkspaceRepositories, listingId: string) {
  const review = await repos.listings.getReviewSnapshot(listingId);
  if (!review)
    throw new ApiError(404, "listing_not_found", "Listing not found.");
  const input = await repos.listingInputs.getCurrent(listingId);
  if (!input)
    fail(
      "saved_inputs_required",
      "Save the working inputs before retrieving evidence.",
    );
  const baseline = workingBaselineForReview(
    input.workingContent,
    input.fieldStates,
    review.activeVersion?.content,
  );
  return {
    ...input,
    ...baseline,
    baseVersionId: review.listing.activeVersionId,
  };
}
function contextDigest(input: Awaited<ReturnType<typeof observed>>) {
  return listingInputDigest({
    content: input.workingContent,
    note: input.note,
    sources: input.sources,
  });
}
function assertIdentity(
  identity: EnrichmentIdentity,
  input: Awaited<ReturnType<typeof observed>>,
) {
  const productName = input.workingContent.title.en.trim(),
    variant = savedMarketVariant(input.note);
  if (!productName || !variant)
    fail(
      "identity_clarification_required",
      "Save the exact product name in the English title and a note line such as Market variant: HK before lookup.",
    );
  if (
    !sameProductIdentity(productName, identity.productName) ||
    !sameProductIdentity(variant, identity.marketVariant)
  )
    fail(
      "identity_conflict",
      "Product name or market variant conflicts with saved inputs. Correct and save the English title or Market variant note first.",
    );
  for (const field of [
    "producer",
    "vintage",
    "volumeMl",
    "packQuantity",
  ] as const) {
    const current = input.workingContent[field];
    const expected = identity[field];
    if (
      current !== null &&
      (typeof current === "string"
        ? current.trim().toLowerCase() !== String(expected).trim().toLowerCase()
        : current !== expected)
    )
      fail(
        "identity_conflict",
        "The lookup identity conflicts with saved product facts. Correct the working draft first.",
      );
  }
}
export async function retrieveListingEvidence(
  input: {
    workspaceId: string;
    actorId: string;
    listingId: string;
    expectedInputRevision: number;
    baseVersionId: string | null;
    operationKey: string;
    url: string;
    identity: EnrichmentIdentity;
  },
  deps: {
    database: Pick<Database, "forWorkspace">;
    fetch?: PublicFetch;
    wait?: (ms: number) => Promise<void>;
  },
) {
  const url = normalizeWebsiteUrl(input.url);
  if (!url || url !== input.url)
    throw new ApiError(
      400,
      "invalid_source_url",
      "Choose a public HTTPS product page.",
    );
  const identity = enrichmentIdentitySchema.parse(input.identity);
  const requestDigest = listingInputDigest({
    ...input,
    actorId: undefined,
    workspaceId: undefined,
  });
  const initial = await deps.database.forWorkspace(
    input.workspaceId,
    async (repos) => {
      if (!(await repos.listingEnrichment.isReady()))
        throw new ApiError(
          503,
          "enrichment_setup_required",
          "Evidence lookup setup is required. Ask an administrator to apply approved migrations.",
        );
      const profile = await repos.workspaces.requireProfile().catch(() => {
        throw new ApiError(
          503,
          "enrichment_setup_required",
          "Workspace evidence policy needs administrator setup.",
        );
      });
      const domains =
        (profile as { sourcePreferences?: { allowedDomains: string[] } })
          .sourcePreferences?.allowedDomains ?? [];
      if (
        domains.length &&
        !domains.some(
          (d) => d.toLowerCase() === new URL(url).hostname.toLowerCase(),
        )
      )
        throw new ApiError(
          403,
          "source_policy_blocked",
          "This source domain is not permitted by workspace settings.",
        );
      const replay = await repos.listingEnrichment.getByKey(
        input.listingId,
        input.operationKey,
      );
      if (replay) {
        if (replay.requestDigest !== requestDigest)
          fail(
            "idempotency_conflict",
            "Use a new request key for a different lookup.",
          );
        return { replay };
      }
      const saved = await observed(repos, input.listingId);
      if (
        saved.revision !== input.expectedInputRevision ||
        saved.baseVersionId !== input.baseVersionId
      )
        fail(
          "input_revision_conflict",
          "Reload saved inputs before retrieving evidence.",
        );
      assertIdentity(identity, saved);
      return { saved };
    },
  );
  if (initial.replay) return initial.replay;
  const fetch = deps.fetch ?? createPublicFetch();
  const origin = new URL(url).origin;
  let result: ReturnType<typeof matchWebsiteProduct> | null = null,
    errorCode: string | null = null;
  try {
    const signal = AbortSignal.timeout(22000);
    const robots = await fetch({
      url: origin + "/robots.txt",
      kind: "robots",
      lockedOrigin: origin,
      signal,
    });
    const policy = parseRobots({
      url: robots.url,
      status: robots.status,
      text: robots.text,
      contentType: robots.contentType,
      retryAfterSeconds: robots.retryAfterSeconds,
    });
    if ((policy.crawlDelaySeconds ?? 1) > 10)
      throw new Error("crawl_delay_exceeds_budget");
    if (!isRobotsAllowed(policy, url)) throw new Error("robots_disallowed");
    await (
      deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    )(Math.max(1000, (policy.crawlDelaySeconds ?? 1) * 1000));
    signal.throwIfAborted();
    const document = await fetch({
      url,
      kind: "product",
      lockedOrigin: origin,
      signal,
      approveUrl: (next) => isRobotsAllowed(policy, next),
      crawlDelaySeconds: policy.crawlDelaySeconds,
    });
    if (document.status !== 200 || document.redirectedTo)
      throw new Error("document_unavailable");
    const extracted = extractDocument({
      url: document.url,
      capturedAt: document.capturedAt,
      html: document.text,
      contentType: document.contentType,
    });
    if (!extracted.product || extracted.product.sourceUrl !== document.url)
      throw new Error("unfetched_canonical");
    result = matchWebsiteProduct({
      identity,
      product: extracted.product,
      documentDigest: createHash("sha256").update(document.text).digest("hex"),
    });
    result.claims = extractWebsiteClaims(
      extracted.product,
      result,
      createHash("sha256").update(document.text).digest("hex"),
    );
    const proseExcerpt = extracted.product.description?.trim();
    if (proseExcerpt)
      result.proseSource = {
        kind: "website",
        url: extracted.product.sourceUrl,
        retrievedAt: extracted.product.capturedAt,
        documentDigest: createHash("sha256")
          .update(document.text)
          .digest("hex"),
        excerpt: proseExcerpt.slice(0, 4000),
        location: "Product description from fetched page",
      };
  } catch {
    errorCode = "source_unavailable";
  }
  return deps.database.forWorkspace(input.workspaceId, async (repos) => {
    const saved = await repos.listingEnrichment.record({
      listingId: input.listingId,
      inputRevision: initial.saved!.revision,
      baseVersionId: initial.saved!.baseVersionId,
      requestKey: input.operationKey,
      requestDigest,
      payload: {
        url,
        identity,
        inputContextDigest: contextDigest(initial.saved!),
        identityContextDigest: listingInputDigest(
          claimIdentitySnapshot(
            initial.saved!.workingContent as unknown as Record<string, unknown>,
          ),
        ),
        sourceContextDigest: listingInputDigest({
          note: initial.saved!.note,
          sources: initial.saved!.sources,
        }),
        result,
        errorCode,
      },
    });
    if (!saved || saved.requestDigest !== requestDigest)
      fail("idempotency_conflict", "The lookup request changed.");
    await repos.audit.write({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      entityId: input.listingId,
      action: "listing.evidence_retrieved",
      metadata: {
        suggestionId: saved.id,
        inputRevision: saved.inputRevision,
        match: saved.payload.result?.match ?? "unavailable",
        fieldCount: saved.payload.result?.fields.length ?? 0,
      },
    });
    return saved;
  });
}
export async function adoptListingEvidence(
  repos: WorkspaceRepositories,
  input: {
    workspaceId: string;
    actorId: string;
    listingId: string;
    suggestionId: string;
    expectedInputRevision: number;
    baseVersionId: string | null;
    operationKey: string;
    selectedFields: EnrichmentField[];
  },
) {
  await repos.listings.lockReviewState(input.listingId);
  const requestDigest = listingInputDigest({
    action: "adopt_website_evidence",
    ...input,
    selectedFields: [...input.selectedFields].sort(),
  });
  const replay = await repos.listingInputs.getByOperationKey(
    input.listingId,
    input.operationKey,
  );
  if (replay) {
    if (replay.requestDigest !== requestDigest)
      fail("idempotency_conflict", "The adoption request changed.");
    return replay;
  }
  const suggestion = await repos.listingEnrichment.get(
    input.listingId,
    input.suggestionId,
  );
  if (!suggestion)
    throw new ApiError(
      404,
      "suggestion_not_found",
      "Evidence suggestion not found.",
    );
  const current = await observed(repos, input.listingId);
  if (
    current.revision !== input.expectedInputRevision ||
    current.baseVersionId !== input.baseVersionId
  )
    fail("input_revision_conflict", "Reload before adopting evidence.");
  if (
    suggestion.payload.result?.match !== "matched" ||
    suggestion.payload.inputContextDigest !== contextDigest(current)
  )
    fail(
      "evidence_incompatible",
      "The source does not match current saved product inputs. Retrieve again after resolving identity.",
    );
  if (
    !input.selectedFields.length ||
    new Set(input.selectedFields).size !== input.selectedFields.length
  )
    fail("invalid_selection", "Select distinct proposed facts.");
  assertIdentity(suggestion.payload.identity, current);
  const changes = input.selectedFields.map((field) => {
    const proposed = suggestion.payload.result!.fields.find(
      (f) => f.field === field,
    );
    if (
      !proposed ||
      suggestion.rejectedFields?.includes(field) ||
      current.fieldStates[field]?.locked
    )
      fail(
        "field_locked",
        "Unlock the selected field explicitly before adopting a suggestion.",
      );
    return {
      field,
      value: proposed.value,
      ...(field === "vintage" && proposed.value === null
        ? { state: "not_applicable" as const }
        : {}),
    };
  });
  const saved = await repos.listingInputs.save(
    {
      listingId: input.listingId,
      actorId: input.actorId,
      expectedInputRevision: input.expectedInputRevision,
      baseVersionId: input.baseVersionId,
      operationKey: input.operationKey,
      requestDigest,
      changes,
      websiteEvidenceRefsByField: Object.fromEntries(
        input.selectedFields.map((field) => [
          field,
          [`website:${suggestion.id}:${field}`],
        ]),
      ),
    },
    {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      entityId: input.listingId,
    },
    repos.audit,
  );
  await repos.audit.write({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    entityId: input.listingId,
    action: "listing.website_evidence_adopted",
    metadata: {
      suggestionId: suggestion.id,
      inputRevision: saved.revision,
      fields: input.selectedFields,
    },
  });
  return saved;
}
export function evidenceView(
  suggestion: ListingEnrichmentSuggestion,
  current: Awaited<ReturnType<typeof observed>>,
) {
  return {
    id: suggestion.id,
    inputRevision: suggestion.inputRevision,
    url: suggestion.payload.url,
    errorCode: suggestion.payload.errorCode,
    match: suggestion.payload.result?.match ?? "unavailable",
    reasons: suggestion.payload.result?.reasons ?? [],
    candidateIdentity: suggestion.payload.result?.candidateIdentity ?? null,
    proseSource: suggestion.payload.result?.proseSource ?? null,
    claims: (suggestion.payload.result?.claims ?? []).map((claim, index) => ({
      ...claim,
      rejected: suggestion.rejectedFields?.includes("claim:" + index) ?? false,
    })),
    fields: (suggestion.payload.result?.fields ?? []).map((f) => ({
      ...f,
      currentValue: readWorkingField(current.workingContent, f.field),
      rejected: suggestion.rejectedFields?.includes(f.field) ?? false,
      eligible:
        !suggestion.rejectedFields?.includes(f.field) &&
        suggestion.payload.result?.match === "matched" &&
        suggestion.payload.inputContextDigest === contextDigest(current) &&
        !current.fieldStates[f.field]?.locked,
    })),
  };
}
export { observed as observeEnrichmentInputs };

export async function rejectListingEvidence(
  repos: WorkspaceRepositories,
  input: Omit<Parameters<typeof adoptListingEvidence>[1], "selectedFields"> & {
    selectedFields: string[];
  },
) {
  await repos.listings.lockReviewState(input.listingId);
  const digest = listingInputDigest({
    action: "reject_website_evidence",
    ...input,
    selectedFields: [...input.selectedFields].sort(),
  });
  const replay = await repos.listingEnrichment.decisionByKey(
    input.listingId,
    input.operationKey,
  );
  if (replay) {
    if (replay.request_digest !== digest)
      fail("idempotency_conflict", "The rejection request changed.");
    return {
      decisionId: String(replay.id),
      inputRevision: Number(replay.input_revision),
    };
  }
  const suggestion = await repos.listingEnrichment.get(
    input.listingId,
    input.suggestionId,
  );
  if (!suggestion)
    throw new ApiError(
      404,
      "suggestion_not_found",
      "Evidence suggestion not found.",
    );
  const current = await observed(repos, input.listingId);
  if (
    current.revision !== input.expectedInputRevision ||
    current.baseVersionId !== input.baseVersionId ||
    (!input.selectedFields.every((field) => field.startsWith("claim:")) &&
      suggestion.payload.inputContextDigest !== contextDigest(current))
  )
    fail("input_revision_conflict", "Reload before rejecting evidence.");
  if (
    !input.selectedFields.length ||
    new Set(input.selectedFields).size !== input.selectedFields.length ||
    input.selectedFields.some((field) =>
      field.startsWith("claim:")
        ? !/^claim:\d+$/.test(field) ||
          !suggestion.payload.result?.claims?.[Number(field.slice(6))]
        : !suggestion.payload.result?.fields.some((f) => f.field === field),
    )
  )
    fail("invalid_selection", "Select distinct proposed facts.");
  let decisionInputRevision = current.revision;
  if (input.selectedFields.some((field) => field.startsWith("claim:"))) {
    if (
      (await repos.listings.requireById(input.listingId)).status ===
      "publishing"
    )
      fail(
        "listing_busy",
        "Publishing is in progress. Retry rejection after it finishes.",
      );
    const saved = await repos.listingInputs.save(
      {
        listingId: input.listingId,
        actorId: input.actorId,
        expectedInputRevision: input.expectedInputRevision,
        baseVersionId: input.baseVersionId,
        operationKey: input.operationKey,
        requestDigest: digest,
        changes: [],
      },
      {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        entityId: input.listingId,
      },
      repos.audit,
    );
    decisionInputRevision = saved.revision;
  }
  const decision = await repos.listingEnrichment.reject({
    listingId: input.listingId,
    suggestionId: input.suggestionId,
    inputRevision: decisionInputRevision,
    baseVersionId: current.baseVersionId,
    requestKey: input.operationKey,
    requestDigest: digest,
    actorId: input.actorId,
    selectedFields: input.selectedFields,
  });
  await repos.audit.write({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    entityId: input.listingId,
    action: "listing.website_evidence_rejected",
    metadata: {
      decisionId: String(decision.id),
      suggestionId: input.suggestionId,
      inputRevision: decisionInputRevision,
      fields: input.selectedFields,
    },
  });
  return {
    decisionId: String(decision.id),
    inputRevision: decisionInputRevision,
  };
}

export async function acceptWebsiteClaim(
  repos: WorkspaceRepositories,
  input: {
    workspaceId: string;
    actorId: string;
    listingId: string;
    suggestionId: string;
    expectedInputRevision: number;
    baseVersionId: string | null;
    operationKey: string;
    claimIndex: number;
    copyField: ClaimCopyField;
  },
) {
  if (!(await repos.listingEnrichment.claimSupportReady()))
    throw new ApiError(
      503,
      "enrichment_setup_required",
      "Claim support setup is required.",
    );
  await repos.listings.lockReviewState(input.listingId);
  const digest = listingInputDigest({
    action: "accept_website_claim",
    ...input,
  });
  const replay = await repos.listingEnrichment.claimSupportByKey(
    input.listingId,
    input.operationKey,
  );
  if (replay) {
    if (replay.request_digest !== digest)
      fail("idempotency_conflict", "Claim acceptance changed.");
    return {
      inputRevision: Number(replay.input_revision),
      supportId: String(replay.id),
    };
  }
  const suggestion = await repos.listingEnrichment.get(
    input.listingId,
    input.suggestionId,
  );
  if (!suggestion)
    throw new ApiError(404, "suggestion_not_found", "Suggestion not found.");
  const current = await observed(repos, input.listingId);
  if (
    current.revision !== input.expectedInputRevision ||
    current.baseVersionId !== input.baseVersionId ||
    suggestion.payload.identityContextDigest !==
      listingInputDigest(
        claimIdentitySnapshot(
          current.workingContent as unknown as Record<string, unknown>,
        ),
      ) ||
    suggestion.payload.sourceContextDigest !==
      listingInputDigest({ note: current.note, sources: current.sources })
  )
    fail("input_revision_conflict", "Reload before accepting this claim.");
  const observation = suggestion.payload.result?.claims?.[input.claimIndex],
    parsed = externalClaimSchema.safeParse(observation?.claim);
  if (
    !parsed.success ||
    suggestion.payload.result?.match !== "matched" ||
    suggestion.rejectedFields?.includes("claim:" + input.claimIndex) ||
    evaluateExternalClaimSupport(parsed.data, {
      claim: parsed.data,
      source: observation?.support.source,
      match: suggestion.payload.result.match,
    }).status !== "supported"
  )
    fail("claim_unverified", "The claim lacks exact matching source evidence.");
  if (current.fieldStates[input.copyField]?.locked)
    fail("field_locked", "Unlock the copy field before accepting a claim.");
  assertIdentity(parsed.data.product, current);
  if (
    current.workingContent.producer === null ||
    current.workingContent.volumeMl === null ||
    current.workingContent.packQuantity === null ||
    (current.workingContent.vintage === null &&
      current.fieldStates.vintage?.state !== "not_applicable")
  )
    fail(
      "identity_required",
      "Save the matching product identity before accepting a claim.",
    );
  if (input.copyField === "title.en")
    fail(
      "identity_title_reserved",
      "The English title holds the saved product identity. Choose another copy field for the claim.",
    );
  const text = renderExternalClaim(
      parsed.data,
      input.copyField.endsWith("zh-Hant") ? "zh-Hant" : "en",
    ),
    before = String(readWorkingField(current.workingContent, input.copyField)),
    copyText = before.split(/\r?\n/).some((line) => line.trim() === text)
      ? before
      : before
        ? before + "\n" + text
        : text;
  const preceding = (
    await readCopyClaimSupports(
      repos,
      input.listingId,
      current.workingContent as unknown as Record<string, unknown>,
    )
  ).filter(
    (s) =>
      s.valid &&
      s.kind === "external" &&
      s.copyField === input.copyField &&
      s.text !== text,
  );
  const saved = await repos.listingInputs.save(
    {
      listingId: input.listingId,
      actorId: input.actorId,
      expectedInputRevision: input.expectedInputRevision,
      baseVersionId: input.baseVersionId,
      operationKey: input.operationKey,
      requestDigest: digest,
      changes: [{ field: input.copyField, value: copyText }],
      websiteEvidenceRefsByField: {
        [input.copyField]: [
          "website:" + suggestion.id + ":claim:" + input.claimIndex,
        ],
      },
    },
    {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      entityId: input.listingId,
    },
    repos.audit,
  );
  const supportId = await repos.listingEnrichment.recordClaimSupport({
    listingId: input.listingId,
    suggestionId: input.suggestionId,
    inputRevision: saved.revision,
    baseVersionId: input.baseVersionId,
    requestKey: input.operationKey,
    requestDigest: digest,
    actorId: input.actorId,
    payload: {
      claim: parsed.data,
      source: observation!.support.source,
      claimIndex: input.claimIndex,
      copyField: input.copyField,
      claimText: text,
      copyText,
      identitySnapshot: claimIdentitySnapshot(
        saved.workingContent as unknown as Record<string, unknown>,
      ),
      sourceSnapshot: { note: saved.note, sources: saved.sources },
    },
  });
  for (const prior of preceding)
    await repos.listingEnrichment.recordClaimSupport({
      listingId: input.listingId,
      suggestionId: prior.suggestionId,
      inputRevision: saved.revision,
      baseVersionId: input.baseVersionId,
      requestKey: randomUUID(),
      requestDigest: digest,
      actorId: input.actorId,
      payload: {
        claim: prior.claim,
        source: prior.source,
        copyField: input.copyField,
        claimText: prior.text,
        copyText,
        identitySnapshot: claimIdentitySnapshot(
          saved.workingContent as unknown as Record<string, unknown>,
        ),
        sourceSnapshot: { note: saved.note, sources: saved.sources },
        reaffirmsSupportId: prior.id,
      },
    });
  await repos.audit.write({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    entityId: input.listingId,
    action: "listing.claim_accepted",
    metadata: {
      supportId,
      suggestionId: input.suggestionId,
      claimIndex: input.claimIndex,
      copyField: input.copyField,
      inputRevision: saved.revision,
    },
  });
  return { inputRevision: saved.revision, supportId };
}

export async function confirmWebsiteProse(
  repos: WorkspaceRepositories,
  input: {
    workspaceId: string;
    actorId: string;
    listingId: string;
    suggestionId: string;
    expectedInputRevision: number;
    baseVersionId: string | null;
    operationKey: string;
    copyField: ClaimCopyField;
    claimText: string;
    reason: string;
  },
) {
  if (!(await repos.listingEnrichment.claimSupportReady()))
    throw new ApiError(
      503,
      "enrichment_setup_required",
      "Claim support setup is required.",
    );
  await repos.listings.lockReviewState(input.listingId);
  const digest = listingInputDigest({
    action: "confirm_website_prose",
    ...input,
  });
  const replay = await repos.listingEnrichment.claimSupportByKey(
    input.listingId,
    input.operationKey,
  );
  if (replay) {
    if (replay.request_digest !== digest)
      fail("idempotency_conflict", "Claim confirmation changed.");
    return {
      inputRevision: Number(replay.input_revision),
      supportId: String(replay.id),
    };
  }
  const suggestion = await repos.listingEnrichment.get(
    input.listingId,
    input.suggestionId,
  );
  if (!suggestion)
    throw new ApiError(404, "suggestion_not_found", "Suggestion not found.");
  const current = await observed(repos, input.listingId),
    copyText = String(
      readWorkingField(current.workingContent, input.copyField),
    );
  if (
    current.revision !== input.expectedInputRevision ||
    current.baseVersionId !== input.baseVersionId ||
    suggestion.payload.identityContextDigest !==
      listingInputDigest(
        claimIdentitySnapshot(
          current.workingContent as unknown as Record<string, unknown>,
        ),
      ) ||
    suggestion.payload.sourceContextDigest !==
      listingInputDigest({ note: current.note, sources: current.sources })
  )
    fail("input_revision_conflict", "Reload before confirming this claim.");
  if (
    suggestion.payload.result?.match !== "matched" ||
    !suggestion.payload.result.proseSource ||
    !copyText.includes(input.claimText)
  )
    fail(
      "claim_unverified",
      "Choose exact existing wording and a matched source excerpt.",
    );
  assertIdentity(suggestion.payload.identity, current);
  if (
    current.workingContent.producer === null ||
    current.workingContent.volumeMl === null ||
    current.workingContent.packQuantity === null ||
    (current.workingContent.vintage === null &&
      current.fieldStates.vintage?.state !== "not_applicable")
  )
    fail(
      "identity_required",
      "Save matching product identity before confirming claims.",
    );
  if (current.fieldStates[input.copyField]?.locked)
    fail(
      "field_locked",
      "Unlock this field before changing its claim support.",
    );
  if (
    /\b(?:awards?|awarded|medals?|trophy|trophies|rating|rated|score|points)\b|\b\d{1,3}\/(?:20|100)\b|獎|評分/i.test(
      input.claimText,
    ) ||
    scanCompliance(
      { claim: input.claimText },
      { criticScores: [], awards: [] },
    ).some((flag) => flag.severity === "blocking")
  )
    fail(
      "claim_requires_evidence",
      "Scores, awards and prohibited claims cannot use general prose confirmation.",
    );
  const saved = await repos.listingInputs.save(
    {
      listingId: input.listingId,
      actorId: input.actorId,
      expectedInputRevision: input.expectedInputRevision,
      baseVersionId: input.baseVersionId,
      operationKey: input.operationKey,
      requestDigest: digest,
      changes: [{ field: input.copyField, value: copyText }],
      websiteEvidenceRefsByField: {
        [input.copyField]: ["website:" + suggestion.id + ":manual-claim"],
      },
    },
    {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      entityId: input.listingId,
    },
    repos.audit,
  );
  const supportId = await repos.listingEnrichment.recordClaimSupport({
    listingId: input.listingId,
    suggestionId: input.suggestionId,
    inputRevision: saved.revision,
    baseVersionId: input.baseVersionId,
    requestKey: input.operationKey,
    requestDigest: digest,
    actorId: input.actorId,
    payload: {
      claim: { kind: "manual", text: input.claimText },
      manualReason: input.reason,
      source: suggestion.payload.result.proseSource,
      copyField: input.copyField,
      claimText: input.claimText,
      copyText,
      identitySnapshot: claimIdentitySnapshot(
        saved.workingContent as unknown as Record<string, unknown>,
      ),
      sourceSnapshot: { note: saved.note, sources: saved.sources },
    },
  });
  await repos.audit.write({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    entityId: input.listingId,
    action: "listing.claim_manually_confirmed",
    metadata: {
      supportId,
      suggestionId: input.suggestionId,
      copyField: input.copyField,
      inputRevision: saved.revision,
    },
  });
  return { inputRevision: saved.revision, supportId };
}
