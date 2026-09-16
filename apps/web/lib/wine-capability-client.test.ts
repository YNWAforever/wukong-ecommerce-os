import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyQueueRequest } from "@wukong/jobs";
import * as client from "./wine-capability-client";
const env = {
  QUEUE_INGRESS_URL: "https://worker.test/ingress",
  QUEUE_INGRESS_SECRET: "q".repeat(32),
};
const capability = () => ({
  schemaVersion: 1,
  execution: {
    schemaVersion: 1,
    flowVersion: "wine-enrichment-v1",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    contractVersion: "wine-contract@1",
    rulesVersion: "wine-grounding@1",
    maxOutputTokens: 4096,
    promptVersions: {
      extract: "wine-extract@1.0.0",
      verify: "wine-verify@1.0.0",
      generate: "wine-generate@1.0.0",
      check: "wine-check@1.0.0",
    },
  },
  databaseSchemaVersion: "wine-enrichment-0042-v1",
  buildSha: "a".repeat(40),
  consumerSupported: true,
  goConfigured: true,
  tavilyConfigured: true,
  queueReady: true,
  databaseReady: true,
});
const reply = (wine = capability()) =>
  Response.json({ authenticated: true, wine });
afterEach(() => vi.useRealTimers());
describe("signed server wine capability receipt", () => {
  it("pins and signs exact health request and yields only a server-owned receipt", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://worker.test/health");
      expect(init?.redirect).toBe("error");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe("{}");
      const headers = new Headers(init?.headers);
      expect(
        await verifyQueueRequest({
          secret: env.QUEUE_INGRESS_SECRET,
          nowSeconds: 1000,
          timestamp: headers.get("x-wukong-timestamp")!,
          signature: headers.get("x-wukong-signature")!,
          path: "/health",
          body: String(init?.body),
        }),
      ).toBe(true);
      return reply();
    });
    const receipt = await client.preflightWineCapability({
      env,
      fetch,
      now: () => 1000000,
    });
    const snapshot = client.requireWineCapabilityReceipt(receipt, {
      env,
      now: () => 1000001,
    });
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      origin: "https://worker.test",
      checkedAt: 1000000,
      expiresAt: 1030000,
      capability: capability(),
    });
    expect(Object.isFrozen(snapshot.capability.execution.promptVersions)).toBe(
      true,
    );
    expect(() =>
      client.requireWineCapabilityReceipt(JSON.parse(JSON.stringify(receipt)), {
        env,
        now: () => 1000001,
      }),
    ).toThrow("wine_capability_required");
    expect(() =>
      client.requireWineCapabilityReceipt(snapshot as never, {
        env,
        now: () => 1000001,
      }),
    ).toThrow("wine_capability_required");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    "consumerSupported",
    "goConfigured",
    "tavilyConfigured",
    "queueReady",
    "databaseReady",
  ])("blocks missing %s", async (key) => {
    const value = { ...capability(), [key]: false };
    await expect(
      client.preflightWineCapability({
        env,
        fetch: async () => reply(value),
        now: () => 1000000,
      }),
    ).rejects.toThrow("wine_capability_unavailable");
  });
  it.each([
    "http://worker.test",
    "https://user:pass@worker.test",
    "https://worker.test?secret=x",
    "https://worker.test/#x",
    "not a url",
  ])("never sends secrets to invalid configured target %s", async (url) => {
    const fetch = vi.fn();
    await expect(
      client.preflightWineCapability({
        env: { ...env, QUEUE_INGRESS_URL: url },
        fetch,
      }),
    ).rejects.toThrow("wine_capability_configuration");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects absent config before fetch", async () => {
    const fetch = vi.fn();
    await expect(
      client.preflightWineCapability({ env: {}, fetch }),
    ).rejects.toThrow("wine_capability_configuration");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects expired, future-clock and other-origin receipts", async () => {
    const receipt = await client.preflightWineCapability({
      env,
      fetch: async () => reply(),
      now: () => 1000000,
    });
    for (const now of [1030000, 999999])
      expect(() =>
        client.requireWineCapabilityReceipt(receipt, { env, now: () => now }),
      ).toThrow("wine_capability_stale");
    expect(() =>
      client.requireWineCapabilityReceipt(receipt, {
        env: { ...env, QUEUE_INGRESS_URL: "https://other.test" },
        now: () => 1000001,
      }),
    ).toThrow("wine_capability_stale");
  });
  it.each([
    () => Response.json({ authenticated: false, wine: capability() }),
    () =>
      reply({
        ...capability(),
        execution: { ...capability().execution, model: "other" },
      }),
    () => reply({ ...capability(), buildSha: "unknown" }),
    () =>
      new Response("{}", {
        status: 302,
        headers: { location: "https://other.test" },
      }),
    () => new Response("{}", { status: 503 }),
    () => new Response("not json"),
    () => new Response("x".repeat(32769)),
    () => new Response("{}", { headers: { "content-length": "32769" } }),
  ])("fails closed on untrusted response", async (response) => {
    await expect(
      client.preflightWineCapability({
        env,
        fetch: async () => response() as Response,
      }),
    ).rejects.toThrow("wine_capability_unavailable");
  });
  it("bounds slow transport including body reads without relying on cooperative abort", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const outcome = client
      .preflightWineCapability({
        env,
        fetch: async () => {
          started();
          return new Response(new ReadableStream({ start() {} }));
        },
      })
      .then(
        () => null,
        (error) => error,
      );
    await fetching;
    await vi.advanceTimersByTimeAsync(5001);
    expect(await outcome).toMatchObject({
      message: "wine_capability_unavailable",
    });
  });
});

it("rejects a response whose final URL differs from the pinned health endpoint", async () => {
  const response = reply();
  Object.defineProperty(response, "url", {
    value: "https://other.test/health",
  });
  await expect(
    client.preflightWineCapability({ env, fetch: async () => response }),
  ).rejects.toThrow("wine_capability_unavailable");
});
it("never reveals a configured secret or transport failure detail", async () => {
  await expect(
    client.preflightWineCapability({
      env,
      fetch: async () => {
        throw new Error(env.QUEUE_INGRESS_SECRET);
      },
    }),
  ).rejects.toEqual(new Error("wine_capability_unavailable"));
});
it("refuses browser module evaluation", async () => {
  vi.resetModules();
  vi.stubGlobal("window", {});
  try {
    await expect(import("./wine-capability-client")).rejects.toThrow(
      "server-only",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
