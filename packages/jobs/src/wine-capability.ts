import { z } from "zod";

/** Interchange compatibility contract; Worker reports its actual AI snapshot.
 * Jobs intentionally has no AI dependency. Version changes require both peers. */
export const wineCapabilitySchema = z
  .object({
    schemaVersion: z.literal(1),
    execution: z
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
            extract: z.literal("wine-extract@1.0.0"),
            verify: z.literal("wine-verify@1.0.0"),
            generate: z.literal("wine-generate@1.0.0"),
            check: z.literal("wine-check@1.0.0"),
          })
          .strict(),
      })
      .strict(),
    databaseSchemaVersion: z.literal("wine-enrichment-0042-v1"),
    buildSha: z.union([
      z.string().regex(/^[a-f0-9]{7,40}$/),
      z.literal("unknown"),
    ]),
    consumerSupported: z.boolean(),
    goConfigured: z.boolean(),
    tavilyConfigured: z.boolean(),
    queueReady: z.boolean(),
    databaseReady: z.boolean(),
  })
  .strict();
export type WineCapability = z.infer<typeof wineCapabilitySchema>;
