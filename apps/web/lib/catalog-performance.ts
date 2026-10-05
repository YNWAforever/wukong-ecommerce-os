const stages = [
  "session",
  "workspace",
  "catalog",
  "products",
  "sources",
  "rows",
  "serialize",
] as const;

type CatalogStage = (typeof stages)[number];

// Per-request, monotonic wall time. Workspace includes its nested stages and
// transaction/pool overhead: these metrics must not be added together as DB time.
// Labels are fixed; no query, tenant identity, content or error enters the header.
export function createCatalogPerformance(now = () => performance.now()) {
  const started = now();
  const durations = new Map<CatalogStage, number>();
  const validDuration = (value: number) =>
    Number.isFinite(value) && value >= 0 && value <= 86_400_000;

  return {
    async measure<T>(stage: CatalogStage, work: () => Promise<T>): Promise<T> {
      const start = now();
      try {
        return await work();
      } finally {
        const elapsed = now() - start;
        if (validDuration(elapsed))
          durations.set(stage, (durations.get(stage) ?? 0) + elapsed);
      }
    },
    attach(response: Response): Response {
      // The route calls this only after server authentication and a successful
      // authorized read. Errors retain the existing support-ID/error contract.
      if (response.status !== 200) return response;
      const metrics: string[] = [];
      for (const stage of stages) {
        const duration = durations.get(stage);
        if (duration !== undefined && validDuration(duration))
          metrics.push(`${stage};dur=${duration.toFixed(1)}`);
      }
      const total = now() - started;
      if (validDuration(total)) metrics.push(`total;dur=${total.toFixed(1)}`);
      if (metrics.length)
        response.headers.set("Server-Timing", metrics.join(", "));
      return response;
    },
  };
}
