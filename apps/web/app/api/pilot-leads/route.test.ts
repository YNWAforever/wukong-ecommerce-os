import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PilotLeadInput } from "@wukong/db";

import {
  createPilotLeadOptionsHandler,
  createPilotLeadPostHandler,
  createPilotLeadTurnstileCheck,
  type PilotLeadStore,
  type TurnstileCheck,
} from "./route";

const receivedAt = new Date("2026-11-18T12:00:00.000Z");
const consentAt = new Date("2026-11-18T12:00:01.000Z");
const validBody = {
  name: "Ada Merchant",
  email: "Ada@Example.com",
  company: "Synthetic Cellar",
  platforms: ["shopline", "shopify"],
  skuVolume: "100_500",
  message: "We need a bilingual catalog review.",
  locale: "en",
  source: "wukong-ops-suite",
  consent: true,
};

let created: PilotLeadInput[];

function store(result: { id: string; createdAt: Date } | null) {
  created = [];
  return {
    createPilotLead: vi.fn(async (input: PilotLeadInput) => {
      created.push(input);
      return result;
    }),
  } satisfies PilotLeadStore;
}

function post(
  body: unknown = validBody,
  options: {
    headers?: Record<string, string>;
    store?: PilotLeadStore;
    ipSalt?: string;
    allowedOrigins?: string[];
    turnstile?: TurnstileCheck;
  } = {},
) {
  const handler = createPilotLeadPostHandler({
    store: options.store ?? store({ id: "lead-1", createdAt: receivedAt }),
    ipSalt: "test-salt",
    allowedOrigins: ["https://marketing.example"],
    now: () => consentAt,
    ...options,
  });
  return handler(
    new Request("https://app.example/api/pilot-leads", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
        "user-agent": "Vitest browser",
        ...options.headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/pilot-leads", () => {
  beforeEach(() => {
    created = [];
  });

  it("persists trimmed, lower-cased contact fields and returns a receipt", async () => {
    const response = await post();
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      id: "lead-1",
      receivedAt: receivedAt.toISOString(),
    });
    expect(text).not.toContain("ada@example.com");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: "Ada Merchant",
      email: "ada@example.com",
      company: "Synthetic Cellar",
      platforms: ["shopline", "shopify"],
      skuVolume: "100_500",
      message: "We need a bilingual catalog review.",
      locale: "en",
      source: "wukong-ops-suite",
      consentAt,
      requestIpHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      userAgent: "Vitest browser",
    });
    expect(JSON.stringify(created[0])).not.toContain("203.0.113.9");
  });

  it("applies safe defaults for optional fields", async () => {
    await post({
      name: "  Ada  ",
      email: " ADA@Example.com ",
      company: "  Synthetic Cellar  ",
      platforms: [],
      consent: true,
    });
    expect(created[0]).toMatchObject({
      name: "Ada",
      email: "ada@example.com",
      company: "Synthetic Cellar",
      platforms: [],
      skuVolume: null,
      message: null,
      locale: "en",
      source: "marketing",
    });
  });

  it("does not store an IP hash without a configured salt", async () => {
    await post(validBody, { ipSalt: "" });
    expect(created[0]?.requestIpHash).toBeNull();
  });

  it.each([
    ["missing consent", { ...validBody, consent: false }],
    ["invalid email", { ...validBody, email: "not-an-email" }],
    ["blank name", { ...validBody, name: "   " }],
    ["unknown field", { ...validBody, phone: "123" }],
    ["too many platforms", { ...validBody, platforms: Array(7).fill("other") }],
    [
      "duplicate platforms",
      { ...validBody, platforms: ["shopline", "shopline"] },
    ],
    ["unknown platform", { ...validBody, platforms: ["amazon"] }],
    ["invalid locale", { ...validBody, locale: "fr" }],
    ["invalid source", { ...validBody, source: "../marketing" }],
    ["filled honeypot", { ...validBody, website: "https://spam.example" }],
  ])("rejects %s without writing", async (_label, body) => {
    const fake = store({ id: "lead-1", createdAt: receivedAt });
    const response = await post(body, { store: fake });
    expect(response.status).toBe(400);
    expect(fake.createPilotLead).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON, oversized bodies and non-object bodies", async () => {
    const fake = store({ id: "lead-1", createdAt: receivedAt });
    expect((await post("{", { store: fake })).status).toBe(400);
    expect((await post("null", { store: fake })).status).toBe(400);
    const oversized = await post(
      JSON.stringify({ ...validBody, message: "x".repeat(17_000) }),
      { store: fake },
    );
    expect(oversized.status).toBe(413);
    expect(fake.createPilotLead).not.toHaveBeenCalled();
  });

  it("maps the store's rate-limit answer to 429 with Retry-After", async () => {
    const response = await post(validBody, { store: store(null) });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("600");
    expect(await response.json()).toMatchObject({ code: "rate_limited" });
  });

  it("requires a one-time token from the configured bot verifier", async () => {
    const fake = store({ id: "lead-1", createdAt: receivedAt });
    const reject = vi.fn(async () => false);
    const denied = await post(validBody, {
      store: fake,
      turnstile: reject,
    });
    expect(denied.status).toBe(403);
    expect(reject).not.toHaveBeenCalled();
    expect(fake.createPilotLead).not.toHaveBeenCalled();

    const accept = vi.fn(async () => true);
    const accepted = await post(
      { ...validBody, turnstileToken: "one-time-token" },
      { store: fake, turnstile: accept },
    );
    expect(accepted.status).toBe(201);
    expect(accept).toHaveBeenCalledWith({
      token: "one-time-token",
      remoteIp: "203.0.113.9",
    });
    expect(fake.createPilotLead).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(created)).not.toContain("one-time-token");
  });

  it.each([
    ["pilot_request", "marketing.example", 201],
    ["other_action", "marketing.example", 403],
    ["pilot_request", "other.example", 403],
    [undefined, undefined, 403],
  ])(
    "checks Siteverify action %s and hostname %s",
    async (action, hostname, status) => {
      const verifyFetch = vi.fn(async () =>
        Response.json({ success: true, action, hostname }),
      );
      const turnstile = createPilotLeadTurnstileCheck(
        "test-secret",
        ["https://marketing.example"],
        verifyFetch,
      );
      const fake = store({ id: "lead-1", createdAt: receivedAt });
      const response = await post(
        { ...validBody, turnstileToken: "fixture-token" },
        { store: fake, turnstile },
      );
      expect(response.status).toBe(status);
      expect(fake.createPilotLead).toHaveBeenCalledTimes(
        status === 201 ? 1 : 0,
      );
    },
  );

  it("fails closed when no Turnstile hostname is configured", async () => {
    const verifyFetch = vi.fn();
    const turnstile = createPilotLeadTurnstileCheck(
      "test-secret",
      [],
      verifyFetch,
    );
    expect(await turnstile({ token: "fixture-token", remoteIp: null })).toBe(
      false,
    );
    expect(verifyFetch).not.toHaveBeenCalled();
  });

  it("allows only a configured exact origin and answers preflight", async () => {
    const response = await post(validBody, {
      headers: { origin: "https://marketing.example" },
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://marketing.example",
    );
    expect(response.headers.get("Vary")).toBe("Origin");

    const options = createPilotLeadOptionsHandler({
      allowedOrigins: ["https://marketing.example"],
    });
    const preflight = options(
      new Request("https://app.example/api/pilot-leads", {
        method: "OPTIONS",
        headers: { origin: "https://marketing.example" },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe(
      "POST, OPTIONS",
    );

    const denied = await post(validBody, {
      headers: { origin: "https://attacker.example" },
    });
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("accepts local development origins but never plain-http production origins", async () => {
    const local = await post(validBody, {
      headers: { origin: "http://localhost:3000" },
      allowedOrigins: ["http://localhost:3000"],
    });
    expect(local.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:3000",
    );
    const insecure = await post(validBody, {
      headers: { origin: "http://marketing.example" },
      allowedOrigins: ["http://marketing.example"],
    });
    expect(insecure.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
