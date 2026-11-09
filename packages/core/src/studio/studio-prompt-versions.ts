/**
 * Studio prompt versions (plan Task 8).
 *
 * Any prompt text change bumps the affected version. An accepted turn pins the
 * versions it ran under, exactly like `listing-prompt-versions.ts` does for the
 * listing pipeline. This is web-runtime only in v1; no Worker prompt coupling.
 */
export const STUDIO_PROMPT_VERSIONS = {
  planner: "1.0.0",
  composer: "1.0.0",
  proposer: "1.0.0",
  categoryProposer: "1.0.0",
} as const;

export type StudioPromptKey = keyof typeof STUDIO_PROMPT_VERSIONS;
