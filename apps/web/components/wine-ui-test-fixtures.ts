import type { WineProgress } from "../lib/wine-progress";
import type { ContentSection } from "@wukong/core";
export const sections: ContentSection[] = [
  {
    key: "introduction",
    en: "Original introduction",
    "zh-Hant": "原有介紹",
    claimIds: [],
    owner: "automatic",
    locked: false,
  },
  {
    key: "pairing",
    en: "Original pairing",
    "zh-Hant": "原有配搭",
    claimIds: [],
    owner: "automatic",
    locked: false,
  },
];
export const progress: WineProgress = {
  runId: "00000000-0000-4000-8000-000000000101",
  inputRevision: 2,
  stage: "verification",
  state: "running",
  adoptedVersionId: null,
  proposal: null,
  completedStages: ["extraction", "search_basic"],
  candidates: [],
  identity: null,
  issues: [],
  evidence: [],
  inspection: [],
  enrichment: "partial",
  goEstimatedUsd: null,
  tavilyCredits: null,
};
