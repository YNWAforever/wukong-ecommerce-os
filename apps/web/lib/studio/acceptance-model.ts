import { fakeStudioUsage, type StudioModel } from "@wukong/ai";
import type { StudioSettings } from "@wukong/db";

/** Explicit isolated browser fixture binding; never selected by request JSON. */
export function studioAcceptanceModelFactory(
  env: NodeJS.ProcessEnv,
): ((settings: StudioSettings) => StudioModel | null) | undefined {
  if (
    env.PLAYWRIGHT_E2E !== "1" ||
    env.STUDIO_GUIDED_ACCEPTANCE !== "1" ||
    env.WUKONG_STUDIO_ACCEPTANCE_FAKE_MODEL !== "1" ||
    env.BETTER_AUTH_URL !== "http://127.0.0.1:49300"
  )
    return undefined;
  let database: URL;
  try {
    database = new URL(env.DATABASE_URL ?? "");
  } catch {
    return undefined;
  }
  if (
    database.protocol !== "postgres:" ||
    database.hostname !== "127.0.0.1" ||
    database.port !== "54329" ||
    database.pathname !== "/wukong" ||
    database.username !== "wukong_app"
  )
    return undefined;
  return (settings) => {
    if (
      settings.workspaceId !== "ws_studio_browser_e2e" ||
      settings.ai?.provider !== "opencode-go" ||
      settings.ai.model !== "deepseek-v4.1-flash"
    )
      return null;
    return {
      async plan() {
        throw new Error("Acceptance fixture does not plan");
      },
      async compose() {
        throw new Error("Acceptance fixture does not compose");
      },
      async propose(input) {
        const ref = input.evidenceRefs.find((value) =>
          value.startsWith(`listing-copy:${input.listing.listingId}:`),
        );
        return {
          proposal: {
            listingId: input.listing.listingId,
            activeVersionId: input.listing.activeVersionId,
            activeVersionSequence: input.listing.activeVersionSequence,
            fields: ref
              ? [
                  {
                    field: "description.en",
                    current: input.listing.description.en,
                    proposed: "Acceptance copy proposed for human review.",
                    evidenceRefs: [ref],
                  },
                ]
              : [],
            limitations: [],
          },
          usage: fakeStudioUsage({
            model: "fake-studio-guided-acceptance",
            estimatedCostUsd: 0.000001,
            inputTokens: 32,
            outputTokens: 8,
          }),
        };
      },
    };
  };
}
