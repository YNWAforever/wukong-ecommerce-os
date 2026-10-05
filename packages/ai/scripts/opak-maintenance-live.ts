import OpenAI from "openai";
import { listingFactsSchema } from "@wukong/core";
import type { ResponsesClientPort } from "../src/openai-listing-provider.js";
import { OpenAIListingProvider } from "../src/openai-listing-provider.js";
import { EXTRACTION_PROMPT, GENERATION_PROMPT } from "../src/prompts.js";
import { factsSufficientForGeneration } from "../src/fact-grounding-rules.js";
import type {
  EvaluationAttempt,
  LiveConfig,
  MaintenanceCase,
  MaintenanceProvider,
} from "./eval-opak-maintenance.js";

type StopReason =
  "budget_exhausted" | "request_cap" | "input_bound" | "unknown_cost";
export type TransportState = {
  requests: number;
  costUsd: number;
  unknownCost: boolean;
  stopReason: StopReason | null;
};
export const freshTransportState = (): TransportState => ({
  requests: 0,
  costUsd: 0,
  unknownCost: false,
  stopReason: null,
});
function stop(state: TransportState, reason: StopReason): never {
  state.stopReason = reason;
  throw new Error("Evaluation transport admission blocked");
}
/** Guard actual transport, including schema repair. SDK automatic retries are disabled. */
export function boundedResponsesClient(
  config: LiveConfig,
  transport: ResponsesClientPort,
  state: TransportState,
): ResponsesClientPort {
  const perCallCeiling =
    (config.maxInputTokens * config.inputUsdPerMillion +
      config.maxOutputTokens * config.outputUsdPerMillion) /
    1000000;
  return {
    responses: {
      parse: async (request, options) => {
        if (state.unknownCost) stop(state, "unknown_cost");
        if (state.stopReason) stop(state, state.stopReason);
        if (state.requests >= config.maxRequests) stop(state, "request_cap");
        if (state.costUsd + perCallCeiling > config.budgetUsd)
          stop(state, "budget_exhausted");
        // Text-only UTF-8 upper bound with protocol/schema overhead reservation. No remote images or tools.
        const serialized = JSON.stringify(request);
        if (
          Buffer.byteLength(serialized, "utf8") + 4096 >
          config.maxInputTokens
        )
          stop(state, "input_bound");
        if (
          !request ||
          typeof request !== "object" ||
          (request as Record<string, unknown>).max_output_tokens !==
            config.maxOutputTokens ||
          (request as Record<string, unknown>).model !== config.model
        )
          stop(state, "input_bound");
        state.requests++;
        let response: Awaited<
          ReturnType<ResponsesClientPort["responses"]["parse"]>
        >;
        try {
          response = await transport.responses.parse(request, {
            ...options,
            maxRetries: 0,
          });
        } catch {
          state.unknownCost = true;
          throw new Error("Evaluation provider request failed");
        }
        const input = response.usage?.input_tokens,
          output = response.usage?.output_tokens;
        if (
          typeof input !== "number" ||
          typeof output !== "number" ||
          !Number.isSafeInteger(input) ||
          !Number.isSafeInteger(output) ||
          input < 0 ||
          output < 0
        )
          state.unknownCost = true;
        else {
          state.costUsd +=
            (input * config.inputUsdPerMillion +
              output * config.outputUsdPerMillion) /
            1000000;
          if (input > config.maxInputTokens || output > config.maxOutputTokens)
            state.stopReason = "input_bound";
        }
        return response;
      },
    },
  };
}

/** Existing extraction/generation adapter, not a production maintenance run or research orchestration. */
export async function createMaintenanceProvider(
  config: LiveConfig,
  deps: { transport?: ResponsesClientPort } = {},
): Promise<MaintenanceProvider> {
  const state = freshTransportState();
  let transport: ResponsesClientPort | undefined = deps.transport;
  const provider = new OpenAIListingProvider(undefined, {
    model: config.model,
    pricing: {
      inputUsdPerMillion: config.inputUsdPerMillion,
      outputUsdPerMillion: config.outputUsdPerMillion,
    },
    maxOutputTokens: config.maxOutputTokens,
    clientFactory: () => {
      transport ??= new OpenAI({
        apiKey: config.apiKey,
        maxRetries: 0,
        timeout: 120000,
        logLevel: "off",
      }) as unknown as ResponsesClientPort;
      return boundedResponsesClient(config, transport, state);
    },
  });
  return {
    evaluate: async (item: MaintenanceCase): Promise<EvaluationAttempt> => {
      const beforeRequests = state.requests,
        beforeCost = state.costUsd,
        started = performance.now();
      const promptVersions: string[] = [];
      const base = () => ({
        providerRequests: state.requests - beforeRequests,
        model: config.model,
        promptVersions,
        latencyMs: Math.round(performance.now() - started),
        costUsd: state.unknownCost ? null : state.costUsd - beforeCost,
        costCertainty: state.unknownCost
          ? ("unknown" as const)
          : ("estimated" as const),
      });
      try {
        // Do not expose gold answers to either provider stage. Each exact input retains a stable local ID.
        const note = JSON.stringify({
          untrustedSources: item.sources.map(({ id, text }) => ({ id, text })),
        });
        promptVersions.push(
          `${EXTRACTION_PROMPT.name}/${EXTRACTION_PROMPT.version}`,
        );
        const extracted = await provider.extract({ assets: [], note });
        if (state.unknownCost || state.stopReason)
          return { ...base(), failure: state.stopReason ?? "unknown_cost" };
        if (!factsSufficientForGeneration(extracted.facts))
          return {
            ...base(),
            candidate: {
              workspaceId: item.workspaceId,
              listingId: item.listingId,
              inputRevision: item.runInputRevision,
              sourceIds: item.sources.map((source) => source.id),
              facts: { ...extracted.facts },
              patch: {},
              published: false,
            },
            failure: "incomplete_identity",
          };
        promptVersions.push(
          `${GENERATION_PROMPT.name}/${GENERATION_PROMPT.version}`,
        );
        const generated = await provider.generate({
          facts: extracted.facts,
          evidence: extracted.evidence,
          profile: {
            name: "Synthetic acceptance workspace",
            currency: "HKD",
            locales: ["en", "zh-Hant"],
            tone: "Plain factual Hong Kong retail copy",
            claimPolicy: [
              "No unsupported factual, award, medical, scarcity or rating claims",
            ],
            requiredFields: [],
            brandBackgroundColor: null,
          },
          imageAssetIds: [],
        });
        return {
          ...base(),
          ...(state.stopReason ? { failure: state.stopReason } : {}),
          candidate: {
            workspaceId: item.workspaceId,
            listingId: item.listingId,
            inputRevision: item.runInputRevision,
            sourceIds: item.sources.map((source) => source.id),
            facts: Object.fromEntries(
              Object.keys(listingFactsSchema.shape).map((key) => [
                key,
                (generated.listing as unknown as Record<string, unknown>)[key],
              ]),
            ),
            patch: {
              nameZh: generated.listing.title["zh-Hant"],
              summaryEn: generated.listing.description.en,
              summaryZh: generated.listing.description["zh-Hant"],
              seoTitleEn: generated.listing.seo.title.en,
              seoTitleZh: generated.listing.seo.title["zh-Hant"],
              seoDescriptionEn: generated.listing.seo.description.en,
              seoDescriptionZh: generated.listing.seo.description["zh-Hant"],
              seoKeywords: generated.listing.tags,
            },
            published: false,
          },
        };
      } catch {
        return { ...base(), failure: state.stopReason ?? "provider_error" };
      }
    },
  };
}
