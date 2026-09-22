import { z } from "zod";

export const WINE_PROMPT_VERSIONS = Object.freeze({
  extract: "wine-extract@1.0.0",
  verify: "wine-verify@1.0.0",
  generate: "wine-generate@1.0.0",
  check: "wine-check@1.0.0",
} as const);
export const wineExecutionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    flowVersion: z.literal("wine-enrichment-v1"),
    provider: z.literal("opencode-go"),
    model: z.literal("deepseek-v4.1-flash"),
    contractVersion: z.literal("wine-contract@1"),
    rulesVersion: z.literal("wine-grounding@1"),
    maxOutputTokens: z.literal(4096),
    promptVersions: z
      .object({
        extract: z.literal(WINE_PROMPT_VERSIONS.extract),
        verify: z.literal(WINE_PROMPT_VERSIONS.verify),
        generate: z.literal(WINE_PROMPT_VERSIONS.generate),
        check: z.literal(WINE_PROMPT_VERSIONS.check),
      })
      .strict(),
  })
  .strict();
export type WineExecutionSnapshot = z.infer<typeof wineExecutionSnapshotSchema>;
/** A version guard, not a reservation policy. Task 7 owns accepted mode-specific budgets. */
export const WINE_EXECUTION_SNAPSHOT: WineExecutionSnapshot = Object.freeze({
  schemaVersion: 1,
  flowVersion: "wine-enrichment-v1",
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  contractVersion: "wine-contract@1",
  rulesVersion: "wine-grounding@1",
  maxOutputTokens: 4096,
  promptVersions: WINE_PROMPT_VERSIONS,
});
