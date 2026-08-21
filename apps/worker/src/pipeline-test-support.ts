import type {
  ExtractionInput,
  ExtractionResult,
  GenerationInput,
  GenerationResult,
  AIUsage,
  ListingAIProvider,
  ProductShotProvider,
} from "@wukong/ai";
import type {
  AuditContext,
  AuditWriter,
  CanonicalListing,
  FieldEvidence,
  ListingFacts,
  WorkspaceProfile,
} from "@wukong/core";
import type {
  PipelineDependencies,
  PipelineRepositories,
} from "./listing-pipeline.js";

export const workspaceId = "ws_opak";
export const draftId = "b9df5d9e-8214-4d76-9a8d-38f802d03d11";
export const usage: AIUsage = {
  inputTokens: 12,
  outputTokens: 34,
  estimatedCostUsd: 0.012345,
  latencyMs: 321,
  model: "test-model",
  promptVersion: "test-v1",
};
export const facts: ListingFacts = {
  sku: "OPAK-001",
  producer: "Demo Estate",
  productType: "wine",
  country: "Germany",
  region: "Mosel",
  vintage: 2024,
  grapeVarieties: ["Riesling"],
  volumeMl: 750,
  abvPercent: 12.5,
  packQuantity: 1,
  priceHkd: 288,
  stockQuantity: 4,
  criticScores: [],
  awards: [],
};
export const evidence: FieldEvidence[] = [
  {
    field: "priceHkd",
    sourceAssetId: "asset_1",
    page: null,
    excerpt: "HK$288",
    confidence: 1,
  },
];
export const listing: CanonicalListing = {
  ...facts,
  sku: facts.sku!,
  producer: facts.producer!,
  productType: facts.productType!,
  country: facts.country!,
  volumeMl: facts.volumeMl!,
  abvPercent: facts.abvPercent!,
  priceHkd: facts.priceHkd!,
  title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" },
  description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" },
  seo: {
    title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" },
    description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" },
  },
  tags: ["Riesling"],
  imageAssetIds: ["asset_1"],
};
export const profile: WorkspaceProfile = {
  name: "Opak Cellar",
  currency: "HKD",
  locales: ["en", "zh-Hant"],
  tone: "clear and restrained",
  claimPolicy: ["No invented claims"],
  requiredFields: ["sku", "priceHkd"],
  brandBackgroundColor: null,
};
export type HarnessState = {
  status: "received" | "processing" | "needs_info" | "in_review" | "failed";
  steps: Map<
    string,
    { state: "running" | "completed"; output: unknown; leaseToken: string }
  >;
  aiRuns: Array<{ task: string; idempotencyKey: string }>;
  versions: string[];
  audits: string[];
  failure?: string;
  completed?: { status: "in_review" | "needs_info"; versionId: string | null };
  sourceAssetsCreated: Array<{
    storageKey: string;
    kind: string;
    metadata: unknown;
  }>;
  sourceAssetsAttached: Array<{ listingId: string; assetIds: string[] }>;
};
export type HarnessOptions = {
  missingFields?: string[];
  extractError?: Error;
  generateError?: Error;
  generateProvider?: (input: GenerationInput) => Promise<GenerationResult>;
  sourceError?: Error;
  completeError?: Error;
  completeErrorOnce?: Error;
  generationUnavailable?: boolean;
  busyLeaseExpiresAt?: Date;
  nullLeaseTokenForCompleted?: boolean;
  productShot?: ProductShotProvider;
  assetStore?: {
    createAssetKey(input: {
      workspaceId: string;
      fileName: string;
      mimeType: string;
      size: number;
    }): string;
    writeObject(
      workspaceId: string,
      key: string,
      body: Uint8Array,
      mimeType: string,
    ): Promise<{ size: number; mimeType: string }>;
  };
};

export function makeProvider(options: HarnessOptions = {}): ListingAIProvider {
  return {
    async extract(_input: ExtractionInput): Promise<ExtractionResult> {
      if (options.extractError) throw options.extractError;
      return {
        facts: options.missingFields?.includes("priceHkd")
          ? { ...facts, priceHkd: null }
          : facts,
        evidence: options.missingFields ? [] : evidence,
        missingFields: options.missingFields ?? [],
        usage,
      };
    },
    async generate(input: GenerationInput): Promise<GenerationResult> {
      if (options.generateError) throw options.generateError;
      return options.generateProvider?.(input) ?? { listing, usage };
    },
  };
}

export function makeHarness(options: HarnessOptions = {}): {
  state: HarnessState;
  deps: PipelineDependencies & { state: HarnessState };
} {
  const state: HarnessState = {
    status: "received",
    steps: new Map(),
    aiRuns: [],
    versions: [],
    audits: [],
    sourceAssetsCreated: [],
    sourceAssetsAttached: [],
  };
  let completeErrorConsumed = false;
  const audit: AuditWriter = {
    async write(event) {
      state.audits.push(event.action);
    },
  };
  const repos: PipelineRepositories = {
    listings: {
      async requireById() {
        return {
          id: draftId,
          status: state.status,
          activeVersionSequence: 0,
          note: "SKU OPAK-001",
        };
      },
      async startProcessing(
        _id: string,
        _context: AuditContext,
        _audit: AuditWriter,
      ) {
        state.status = "processing";
      },
      async appendVersion(
        _id: string,
        _content: CanonicalListing,
        _context: AuditContext,
        _audit: AuditWriter,
        _key?: string,
      ) {
        const id = state.versions[0] ?? `version_${state.versions.length + 1}`;
        if (!state.versions.includes(id)) state.versions.push(id);
        return { id, sequence: 1 };
      },
      async replaceEvidence() {},
      async replaceFlags() {},
      async complete(
        _id: string,
        result,
        _context: AuditContext,
        _audit: AuditWriter,
      ) {
        if (
          options.completeError ||
          (options.completeErrorOnce && !completeErrorConsumed)
        ) {
          completeErrorConsumed = true;
          throw options.completeError ?? options.completeErrorOnce;
        }
        state.status = result.status;
        state.completed = {
          status: result.status,
          versionId: result.versionId,
        };
        state.audits.push(
          result.status === "in_review"
            ? "listing.submitted_for_review"
            : "listing.info_requested",
        );
      },
      async fail(
        _id: string,
        code,
        _context: AuditContext,
        _audit: AuditWriter,
      ) {
        state.status = "failed";
        state.failure = code;
        state.audits.push("listing.pipeline_failed");
      },
    },
    sourceAssets: {
      async listForListing() {
        if (options.sourceError) throw options.sourceError;
        return [
          {
            id: "asset_1",
            mimeType: "image/png",
            storageKey: `ws/${workspaceId}/sources/asset_1/label.png`,
          },
        ];
      },
      async create(input: {
        storageKey: string;
        kind: string;
        metadata: unknown;
      }) {
        state.sourceAssetsCreated.push(input);
        return { id: `asset_shot_${state.sourceAssetsCreated.length}` };
      },
      async attachToListing(listingId: string, assetIds: string[]) {
        state.sourceAssetsAttached.push({ listingId, assetIds });
      },
    },
    workspaces: {
      async requireProfile() {
        return profile;
      },
    },
    pipelineRuns: {
      async getCompleted() {
        return state.completed ?? null;
      },
      async claimStep(input) {
        if (input.step === "generated" && options.generationUnavailable)
          return {
            claimed: false,
            completed: false,
            output: null,
            leaseToken: null,
            leaseExpiresAt: options.busyLeaseExpiresAt ?? null,
          };
        const current = state.steps.get(input.step);
        if (!current) {
          const leaseToken = "lease-" + input.step + "-1";
          state.steps.set(input.step, {
            state: "running",
            output: null,
            leaseToken,
          });
          return { claimed: true, completed: false, output: null, leaseToken };
        }
        if (current.state === "completed")
          return {
            claimed: false,
            completed: true,
            output: current.output,
            leaseToken: options.nullLeaseTokenForCompleted
              ? null
              : current.leaseToken,
          };
        return {
          claimed: false,
          completed: false,
          output: null,
          leaseToken: null,
          leaseExpiresAt: options.busyLeaseExpiresAt ?? null,
        };
      },
      async recordStep(input) {
        const current = state.steps.get(input.step);
        if (
          !current ||
          (input.leaseToken
            ? current.leaseToken !== input.leaseToken
            : current.state !== "completed")
        )
          throw new Error("pipeline step lease lost");
        state.steps.set(input.step, {
          state: "completed",
          output: input.output ?? null,
          leaseToken: current.leaseToken,
        });
      },
      async complete(input) {
        const current = state.steps.get(input.step);
        if (
          !current ||
          (input.leaseToken
            ? current.leaseToken !== input.leaseToken
            : current.state !== "completed")
        )
          throw new Error("pipeline step lease lost");
      },
      async fail(input) {
        state.failure = input.errorCode;
        return true;
      },
      async releaseStep(input) {
        const current = state.steps.get(input.step);
        if (
          current?.state === "running" &&
          current.leaseToken === input.leaseToken
        )
          state.steps.delete(input.step);
      },
    },
    aiRuns: {
      async append(run) {
        if (
          !state.aiRuns.some(
            (existing) =>
              existing.task === run.task &&
              existing.idempotencyKey === run.idempotencyKey,
          )
        )
          state.aiRuns.push({
            task: run.task,
            idempotencyKey: run.idempotencyKey,
          });
      },
    },
    audit,
  };
  const deps: PipelineDependencies & { state: HarnessState } = {
    state,
    async withWorkspace<T>(
      id: string,
      work: (repositories: PipelineRepositories) => Promise<T>,
    ) {
      if (id !== workspaceId) throw new Error("wrong workspace");
      return work(repos);
    },
    async assetInputs(assets) {
      return assets.map((asset) => ({
        id: asset.id,
        mimeType: asset.mimeType,
        readUrl: `https://assets.test/${asset.id}`,
      }));
    },
    ai: makeProvider(options),
    productShot: options.productShot,
    assetStore: options.assetStore,
  };
  return { state, deps };
}

/**
 * `makeHarness` applies every repository write immediately, so a `withWorkspace`
 * callback that throws still leaves its earlier writes visible. Postgres does
 * not behave that way: `forWorkspace` is one transaction, and a throw rolls the
 * whole callback back. Use this harness for any test that asserts on state after
 * a failed transaction, otherwise the test is pinning the fake, not the runtime.
 */
export function makeTransactionAwareHarness(
  options: HarnessOptions = {},
  /**
   * Fails the COMMIT of the first transaction whose post-work state matches.
   * Distinct from a callback that throws: every statement ran, so the in-memory
   * bookkeeping in `runListingPipeline` has already been updated when the write
   * is discarded. This is the eviction/commit-failure case.
   */
  failCommitWhen?: (state: HarnessState) => boolean,
): {
  state: HarnessState;
  deps: PipelineDependencies & { state: HarnessState };
} {
  const harness = makeHarness(options);
  const { state } = harness;
  const inner = harness.deps.withWorkspace;
  let commitFailed = false;
  harness.deps.withWorkspace = async function <T>(
    id: string,
    work: (repositories: PipelineRepositories) => Promise<T>,
  ): Promise<T> {
    const snapshot = structuredClone(state);
    try {
      const result = await inner(id, work);
      if (!commitFailed && failCommitWhen?.(state) === true) {
        commitFailed = true;
        throw new Error("transaction commit failed");
      }
      return result;
    } catch (error) {
      state.status = snapshot.status;
      state.steps = snapshot.steps;
      state.aiRuns = snapshot.aiRuns;
      state.versions = snapshot.versions;
      state.audits = snapshot.audits;
      state.failure = snapshot.failure;
      state.completed = snapshot.completed;
      throw error;
    }
  };
  return harness;
}
