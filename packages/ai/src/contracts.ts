import type {
  CanonicalListing,
  FieldEvidence,
  ListingFacts,
  WorkspaceProfile,
} from "@wukong/core";

export const NOTE_SOURCE_ID = "note";

export type ExtractionAsset = {
  id: string;
  mimeType: string;
  readUrl: string;
};

export type ExtractionInput = {
  assets: ExtractionAsset[];
  note: string | null;
};

export type AIUsage = {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  model: string;
  promptVersion: string;
};

export type ExtractionResult = {
  facts: ListingFacts;
  evidence: FieldEvidence[];
  missingFields: string[];
  usage: AIUsage;
};

export type GenerationInput = {
  facts: ListingFacts;
  evidence: FieldEvidence[];
  profile: WorkspaceProfile;
  imageAssetIds: string[];
};

export type GenerationResult = {
  listing: CanonicalListing;
  usage: AIUsage;
};

export interface ListingAIProvider {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
  generate(input: GenerationInput): Promise<GenerationResult>;
}
