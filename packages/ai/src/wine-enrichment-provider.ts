import {
  wineGenerationRequestSchema,
  wineGenerationCandidateSchema,
  wineCheckResponseSchema,
  type WineGenerationRequest,
  type WineGenerationResult,
  type WineCheckRequest,
  type WineCheckResult,
} from "./wine-enrichment-schemas.js";
import {
  validateWineGenerationRequest,
  wineCandidateIssues,
  wineTextPaths,
} from "./wine-enrichment-content-validation.js";
import {
  decideWineClaim,
  sameWineValue,
  type WineClaimContext,
} from "@wukong/core";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ExtractionInput } from "./contracts.js";
import { UnsupportedAssetError } from "./listing-provider-errors.js";
import { TypedJsonCompletionClient } from "./typed-json-completion.js";
import {
  WINE_PROMPTS,
  WINE_PROMPT_VERSIONS,
  WINE_STAGE_ROLES,
  wineExecutionSnapshotSchema,
  type WineLogicalStage,
} from "./wine-enrichment-prompts.js";
import {
  wineExtractionSchema,
  wineFrozenContextSchema,
  wineVerificationProposalSchema,
  type WineSupportProposal,
  type WineExtraction,
  type WineVerificationRequest,
  type WineVerificationResult,
  type WineEnrichmentProviderConfig,
} from "./wine-enrichment-schemas.js";
import {
  requireValue,
  unique,
  references,
  identityReferences,
  validateWineSupportProposal,
} from "./wine-enrichment-grounding.js";
export * from "./wine-enrichment-prompts.js";
export * from "./wine-enrichment-schemas.js";
export { validateWineSupportProposal } from "./wine-enrichment-grounding.js";
export class WineEnrichmentProvider {
  private readonly config: WineEnrichmentProviderConfig;
  constructor(config: WineEnrichmentProviderConfig) {
    this.config = {
      ...config,
      snapshot: wineExecutionSnapshotSchema.parse(config.snapshot),
    };
    new TypedJsonCompletionClient({
      ...this.config,
      backend: "opencode-go",
      model: this.config.snapshot.model,
      maxOutputTokens: 4096,
    });
  }
  private client(stage: WineLogicalStage) {
    const role = WINE_STAGE_ROLES[stage];
    return new TypedJsonCompletionClient({
      ...this.config,
      backend: "opencode-go",
      model: this.config.snapshot.model,
      maxOutputTokens: 4096,
      invocationObserver: this.config.observerFactory?.({
        stage,
        role,
        promptVersion: WINE_PROMPT_VERSIONS[role],
      }),
    });
  }
  async extract(input: ExtractionInput): Promise<WineExtraction> {
    const frozen = structuredClone(input);
    unique(
      frozen.assets.map((a) => a.id),
      "assets",
    );
    for (const asset of frozen.assets) {
      let url: URL;
      try {
        url = new URL(asset.readUrl);
      } catch {
        throw new UnsupportedAssetError("Invalid wine asset URL");
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !["image/jpeg", "image/png", "image/webp"].includes(asset.mimeType)
      )
        throw new UnsupportedAssetError("Unsupported wine asset");
    }
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: WINE_PROMPTS.extract },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              allowedAssetIds: frozen.assets.map((a) => a.id),
              note: frozen.note,
            }),
          },
          ...frozen.assets.map((a) => ({
            type: "image_url" as const,
            image_url: { url: a.readUrl },
          })),
        ],
      },
    ];
    const { parsed, usage } = await this.client("extraction").complete(
      messages,
      wineExtractionSchema,
      "wine_extraction",
      WINE_PROMPT_VERSIONS.extract,
      (parsed) => {
        unique(
          parsed.evidence.map((s) => s.id),
          "sources",
        );
        const ids = new Set(parsed.evidence.map((s) => s.id));
        identityReferences(parsed.identity, ids);
        for (const source of parsed.evidence) {
          requireValue(
            source.kind !== "web" && !source.url && !source.domain,
            "Extraction cannot create web authority",
          );
          requireValue(source.excerpt.trim(), "Empty extraction span");
          if (source.kind === "merchant")
            requireValue(
              source.assetId === null &&
                source.contentScope === "note" &&
                frozen.note?.includes(source.excerpt),
              "Unknown merchant excerpt",
            );
          else
            requireValue(
              source.contentScope === "label" &&
                frozen.assets.some((a) => a.id === source.assetId),
              "Unknown extraction asset",
            );
          if (source.identity) identityReferences(source.identity, ids);
        }
        for (const [field, observation] of [
          ...Object.entries(parsed.identity.observations),
          ...Object.entries(parsed.identity.category),
        ])
          if (observation && observation.value !== null) {
            for (const id of observation.evidenceIds) {
              const source = parsed.evidence.find((s) => s.id === id)!;
              validateWineSupportProposal(
                {
                  sourceId: id,
                  field: field as WineSupportProposal["field"],
                  value: observation.value,
                  span: source.excerpt,
                },
                parsed.evidence,
              );
            }
          }
      },
    );
    return {
      ...parsed,
      identity: {
        ...parsed.identity,
        status:
          parsed.identity.status === "needs_confirmation"
            ? "needs_confirmation"
            : "candidate",
      },
      evidence: parsed.evidence.map((s) => ({
        ...s,
        trust: "unverified",
        identity: s.identity
          ? {
              ...s.identity,
              status:
                s.identity.status === "needs_confirmation"
                  ? "needs_confirmation"
                  : "candidate",
            }
          : null,
      })),
      usage,
    };
  }
  async verify(
    input: WineVerificationRequest,
  ): Promise<WineVerificationResult> {
    requireValue(
      input.stage === "verification" || input.stage === "verification_deep",
      "Invalid wine verification stage",
    );
    const context = wineFrozenContextSchema.parse(input.context);
    const ids = new Set(context.sources.map((s) => s.id));
    unique(
      context.sources.map((s) => s.id),
      "sources",
    );
    unique(
      context.acceptedPremises.map((c) => c.id),
      "premises",
    );
    references(context.reliableSourceIds, ids);
    references(context.trustedObservationSourceIds, ids);
    identityReferences(context.identity, ids);
    for (const source of context.sources)
      requireValue(
        source.excerpt.length <= 16000,
        "Wine source exceeds retained text limit",
      );
    for (const support of context.supports)
      validateWineSupportProposal(support, context.sources);
    const premiseIds = new Set(
      context.acceptedPremises
        .filter(
          (c) =>
            c.state === "accepted" &&
            c.kind === "fact" &&
            c.scope === "product",
        )
        .map((c) => c.id),
    );
    for (const premise of context.acceptedPremises)
      references(premise.evidenceIds, ids);
    const { parsed, usage } = await this.client(input.stage).complete(
      [
        { role: "system", content: WINE_PROMPTS.verify },
        {
          role: "user",
          content: JSON.stringify({
            identity: context.identity,
            sources: context.sources,
            acceptedPremises: context.acceptedPremises,
            lockedFields: context.lockedFields,
          }),
        },
      ],
      wineVerificationProposalSchema,
      "wine_verification",
      WINE_PROMPT_VERSIONS.verify,
      (parsed) => {
        unique(
          parsed.claims.map((c) => c.id),
          "claims",
        );
        for (const candidate of parsed.candidates)
          identityReferences(candidate, ids);
        for (const claim of parsed.claims) {
          requireValue(
            claim.kind !== "recommendation" || claim.scope === "product",
            "Recommendations require product scope",
          );
          references(claim.evidenceIds, ids);
          references(claim.premiseClaimIds, premiseIds);
          requireValue(
            !context.acceptedPremises.some((p) => p.id === claim.id),
            "Claim ID collides with premise",
          );
        }
        for (const support of parsed.supportProposals)
          validateWineSupportProposal(support, context.sources);
        for (const claim of parsed.claims)
          if (claim.kind === "fact")
            for (const id of claim.evidenceIds)
              requireValue(
                parsed.supportProposals.some(
                  (s) =>
                    s.sourceId === id &&
                    s.field === claim.field &&
                    sameWineValue(s.value, claim.value),
                ),
                "Missing factual claim span binding",
              );
        for (const issue of parsed.issues) references(issue.evidenceIds, ids);
      },
    );
    const trusted: WineClaimContext = {
      now: context.now,
      authorities: context.authorities,
      supports: context.supports,
      reliableSourceIds: new Set(context.reliableSourceIds),
      trustedObservationSourceIds: new Set(context.trustedObservationSourceIds),
      acceptedPremises: context.acceptedPremises,
      verifiedAliases: context.verifiedAliases,
    };
    const claims = parsed.claims.map((claim) =>
      decideWineClaim({
        identity: context.identity,
        claim: {
          ...claim,
          state: "unknown",
          reason: "untrusted_model_proposal",
        },
        sources: context.sources,
        lockedFields: new Set(context.lockedFields),
        context: trusted,
      }),
    );
    const issues = [
      ...parsed.issues,
      ...claims
        .filter((c) => c.state !== "accepted")
        .map((c) => ({
          path: `claims.${c.id}`,
          code: c.reason,
          blocking: c.state === "conflict",
          evidenceIds: c.evidenceIds,
        })),
    ];
    // raw needsDeepSearch remains advisory. Task 8 derives and persists the authoritative decision.
    return {
      ...parsed,
      identity: context.identity,
      candidates: parsed.candidates.map((c) => ({ ...c, status: "candidate" })),
      claims,
      issues,
      usage,
    };
  }
  async generate(input: WineGenerationRequest): Promise<WineGenerationResult> {
    const request = wineGenerationRequestSchema.parse(input);
    validateWineGenerationRequest(request);
    const { parsed, usage } = await this.client("generation").complete(
      [
        { role: "system", content: WINE_PROMPTS.generate },
        { role: "user", content: JSON.stringify(request) },
      ],
      wineGenerationCandidateSchema,
      "wine_generation",
      WINE_PROMPT_VERSIONS.generate,
      (parsed) => {
        const issues = wineCandidateIssues(request, parsed);
        requireValue(
          issues.length === 0,
          `Invalid wine candidate: ${JSON.stringify(issues)}`,
        );
      },
    );
    return {
      ...parsed,
      status: "candidate",
      requiresQualityCheck: true,
      requiresMerchantReview: true,
      usage,
    };
  }
  async check(input: WineCheckRequest): Promise<WineCheckResult> {
    const request = wineGenerationRequestSchema.parse(input.request);
    validateWineGenerationRequest(request);
    const candidate = wineGenerationCandidateSchema.parse({
      schemaVersion: input.candidate.schemaVersion,
      content: input.candidate.content,
      annotations: input.candidate.annotations,
    });
    const deterministic = wineCandidateIssues(request, candidate);
    const paths = new Set([
      ...wineTextPaths(candidate.content).keys(),
      "sections",
      "title",
      "seo",
      "tags",
      ...candidate.content.sections.map((s) => `sections.${s.key}`),
    ]);
    const evidence = new Set(request.claims.flatMap((c) => c.evidenceIds));
    const { parsed, usage } = await this.client("quality_check").complete(
      [
        { role: "system", content: WINE_PROMPTS.check },
        {
          role: "user",
          content: JSON.stringify({
            request,
            candidate,
            deterministicIssues: deterministic,
          }),
        },
      ],
      wineCheckResponseSchema,
      "wine_quality_check",
      WINE_PROMPT_VERSIONS.check,
      (parsed) => {
        for (const issue of parsed.issues) {
          requireValue(paths.has(issue.path), "Unknown quality issue path");
          references(issue.evidenceIds, evidence);
        }
      },
    );
    return {
      ...parsed,
      issues: [...deterministic, ...parsed.issues],
      requiresMerchantReview: true,
      usage,
    };
  }
}
