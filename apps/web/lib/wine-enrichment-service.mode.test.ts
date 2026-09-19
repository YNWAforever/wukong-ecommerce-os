import { afterEach, expect, it, vi } from "vitest";
import { prepareWineAdmission } from "./wine-enrichment-service";
import { wineEnrichmentPolicySchema } from "@wukong/core";
afterEach(() => vi.unstubAllEnvs());
it.each(["full", "research"] as const)(
  "forwards exact %s capability mode outside profile transaction",
  async (mode) => {
    vi.stubEnv("WINE_ENRICHMENT_ENABLED", "true");
    let inTransaction = false;
    const database = {
      async forWorkspace(_id: string, work: (r: any) => Promise<unknown>) {
        inTransaction = true;
        try {
          return await work({
            workspaces: {
              requireProfile: async () => ({
                wineEnrichment: wineEnrichmentPolicySchema.parse({
                  enabled: true,
                }),
              }),
            },
          });
        } finally {
          inTransaction = false;
        }
      },
    };
    const preflight = vi.fn(async (options?: { mode?: string }) => {
      expect(inTransaction).toBe(false);
      expect(options?.mode).toBe(mode);
      return {} as never;
    });
    const result = await prepareWineAdmission(
      database as never,
      "WS",
      mode,
      preflight,
    );
    expect(result.winePreflightError).toBeUndefined();
    expect(preflight).toHaveBeenCalledWith({ mode });
  },
);
it.each(["copy", "section"] as const)(
  "keeps %s preflight blocked until actual runtime integration",
  async (mode) => {
    vi.stubEnv("WINE_ENRICHMENT_ENABLED", "true");
    const database = {
      forWorkspace: async () => ({ wineEnrichment: { enabled: true } }),
    };
    const preflight = vi.fn();
    expect(
      await prepareWineAdmission(database as never, "WS", mode, preflight),
    ).toEqual({});
    expect(preflight).not.toHaveBeenCalled();
  },
);
