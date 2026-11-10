import { describe, expect, it } from "vitest";

import type { StudioSettings } from "@wukong/db";

import { isStudioEnabled } from "../studio-flags";
import {
  createMcpTokenBodySchema,
  createMcpTokenService,
  hashMcpTokenSecret,
  MCP_TOKEN_MAX_ACTIVE,
  type McpTokenServiceDeps,
} from "./mcp-tokens.js";
import {
  createFakeStudio,
  fakeApiToken,
  fakeGetDatabase,
  fakeSessionContext,
  type FakeStudioOptions,
} from "./test-fakes.js";

/**
 * Hosted-MCP token administration tests (plan Task 12).
 *
 * Fakes only: no database, no token material in any audit row, and the
 * plaintext exists exactly in the create response.
 */

const WORKSPACE = "ws_test";
const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  STUDIO_MCP_SERVER_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

type Role = "viewer" | "operator" | "reviewer" | "admin" | "owner";

function fixture(
  input: {
    role?: Role;
    options?: FakeStudioOptions;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  } = {},
) {
  const options = input.options ?? {};
  const fake = createFakeStudio({
    ...options,
    settings: {
      workspaceId: WORKSPACE,
      enabled: true,
      ...(options.settings ?? {}),
    },
  });
  const session = fakeSessionContext(input.role ?? "admin", {
    workspaceId: WORKSPACE,
  });
  const deps: McpTokenServiceDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    isStudioEnabled,
    env: input.env ?? ON_ENV,
    now: () => input.now ?? new Date("2026-11-08T10:30:00.000Z"),
    // Deterministic entropy: 9 bytes of 0x01 then 32 bytes of 0x02.
    randomBytes: (size) => Buffer.alloc(size, size === 9 ? 0x01 : 0x02),
  };
  return { service: createMcpTokenService(deps), fake };
}

const createBody = {
  label: "CI token",
  scopes: ["read"] as Array<"read" | "propose">,
};

describe("createMcpTokenBodySchema", () => {
  it("accepts only label 1..100 and the read/propose scopes", () => {
    expect(createMcpTokenBodySchema.safeParse(createBody).success).toBe(true);
    expect(
      createMcpTokenBodySchema.safeParse({
        label: "x",
        scopes: ["read", "propose"],
      }).success,
    ).toBe(true);
    for (const body of [
      { label: "", scopes: ["read"] },
      { label: "x".repeat(101), scopes: ["read"] },
      { label: "x", scopes: [] },
      { label: "x", scopes: ["write"] },
      { label: "x", scopes: ["read", "read", "propose"] },
      { label: "x", scopes: ["read"], extra: true },
    ]) {
      expect(createMcpTokenBodySchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("createMcpTokenService", () => {
  it("creates a token, stores only the prefix and hash, and shows plaintext once", async () => {
    const { service, fake } = fixture();
    const created = await service.createToken(createBody);

    expect(created.token).toMatch(/^wuk_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/);
    const [secret] = created.token.split(".").slice(1);
    expect(created.token).toBe(`wuk_${created.prefix}.${secret}`);
    expect(created.scopes).toEqual(["read"]);
    expect(created.label).toBe("CI token");

    const stored = fake.state.apiTokens[0]!;
    expect(stored.id).toBe(created.tokenId);
    expect(stored.prefix).toBe(created.prefix);
    expect(stored.scopes).toEqual(["read"]);
    expect(stored.createdBy).toBe("actor_ops");
    // The plaintext never reaches storage or the audit row.
    expect(JSON.stringify(stored)).not.toContain(secret);
    const audit = fake.state.audits[0]!;
    expect(audit.action).toBe("studio.mcp.token.created");
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain(hashMcpTokenSecret(secret!));
  });

  it("deduplicates scopes and keeps the token hash out of every response", async () => {
    const { service, fake } = fixture();
    const created = await service.createToken({
      label: "x",
      scopes: ["read", "read"],
    });
    expect(created.scopes).toEqual(["read"]);
    expect(created).not.toHaveProperty("tokenHash");
    expect(created).not.toHaveProperty("hash");
    expect(fake.state.apiTokens[0]?.scopes).toEqual(["read"]);
  });

  it("lists tokens without plaintext or hash and includes revoked state", async () => {
    const revoked = fakeApiToken({
      workspaceId: WORKSPACE,
      label: "Old token",
      prefix: "oldprefix",
      revokedAt: new Date("2026-11-08T09:00:00.000Z"),
    });
    const { service } = fixture({ options: { apiTokens: [revoked] } });
    const listed = await service.listTokens();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      tokenId: revoked.id,
      label: "Old token",
      prefix: "oldprefix",
      revokedAt: "2026-11-08T09:00:00.000Z",
    });
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain("tokenHash");
    expect(serialized).not.toContain("wuk_");
  });

  it("revokes once, audits it and 404s an unknown or foreign id", async () => {
    const token = fakeApiToken({ workspaceId: WORKSPACE });
    const { service, fake } = fixture({
      options: { apiTokens: [token] },
      now: new Date("2026-11-08T10:31:00.000Z"),
    });
    const revoked = await service.revokeToken(token.id);
    expect(revoked).toEqual({
      tokenId: token.id,
      revokedAt: "2026-11-08T10:31:00.000Z",
    });
    expect(fake.state.apiTokens[0]?.revokedAt).not.toBeNull();
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.token.revoked",
    ]);

    await expect(service.revokeToken(token.id)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(
      service.revokeToken("00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(service.revokeToken("not-a-uuid")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("requires admin and a Studio-enabled workspace before any write", async () => {
    for (const role of ["viewer", "operator", "reviewer"] as const) {
      const { service, fake } = fixture({ role });
      await expect(service.createToken(createBody)).rejects.toMatchObject({
        status: 403,
        code: "insufficient_role",
      });
      expect(fake.state.apiTokens).toEqual([]);
      expect(fake.state.audits).toEqual([]);
    }

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    await expect(
      disabled.service.createToken(createBody),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(disabled.fake.state.apiTokens).toEqual([]);
  });
});

describe("MCP token quotas (B4)", () => {
  it("accepts nullable quotas only within the database CHECK ranges", () => {
    const valid = [
      { ...createBody },
      { ...createBody, rateLimitPerMinute: 1, monthlyCallQuota: 1 },
      { ...createBody, rateLimitPerMinute: 600, monthlyCallQuota: 1_000_000 },
      { ...createBody, rateLimitPerMinute: null, monthlyCallQuota: null },
    ];
    for (const body of valid) {
      expect(createMcpTokenBodySchema.safeParse(body).success).toBe(true);
    }
    for (const body of [
      { ...createBody, rateLimitPerMinute: 0 },
      { ...createBody, rateLimitPerMinute: 601 },
      { ...createBody, rateLimitPerMinute: 1.5 },
      { ...createBody, monthlyCallQuota: 0 },
      { ...createBody, monthlyCallQuota: 1_000_001 },
      { ...createBody, monthlyCallQuota: "10" },
      { ...createBody, unexpected: true },
    ]) {
      expect(createMcpTokenBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it("stores quotas, audits them and returns usage counters", async () => {
    const { service, fake } = fixture();
    const created = await service.createToken({
      ...createBody,
      rateLimitPerMinute: 60,
      monthlyCallQuota: 1000,
    });
    expect(created.rateLimitPerMinute).toBe(60);
    expect(created.monthlyCallQuota).toBe(1000);
    expect(created.usage).toEqual({ minuteCalls: 0, monthCalls: 0 });
    expect(fake.state.apiTokens[0]?.rateLimitPerMinute).toBe(60);
    expect(fake.state.apiTokens[0]?.monthlyCallQuota).toBe(1000);
    expect(fake.state.audits[0]?.metadata).toMatchObject({
      rateLimitPerMinute: 60,
      monthlyCallQuota: 1000,
    });

    const unlimited = await service.createToken(createBody);
    expect(unlimited.rateLimitPerMinute).toBeNull();
    expect(unlimited.monthlyCallQuota).toBeNull();
  });

  it("lists actual minute/month usage per token from the ledger", async () => {
    const token = fakeApiToken({
      workspaceId: WORKSPACE,
      rateLimitPerMinute: 5,
      monthlyCallQuota: 100,
    });
    const other = fakeApiToken({ workspaceId: WORKSPACE });
    const now = new Date("2026-11-08T10:30:00.000Z");
    const ledger = (tokenId: string, minutesAgo: number, index: number) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      workspaceId: WORKSPACE,
      runId: null,
      connectionId: null,
      tokenId,
      toolName: "catalog.search",
      requestDigest: "a".repeat(64),
      responseDigest: null,
      status: "ok" as const,
      errorCode: null,
      latencyMs: 5,
      caller: "external_mcp" as const,
      createdAt: new Date(now.getTime() - minutesAgo * 60_000),
    });
    const { service } = fixture({
      now,
      options: {
        apiTokens: [token, other],
        mcpCalls: [
          ledger(token.id, 0, 1),
          ledger(token.id, 0, 2),
          ledger(token.id, 5, 3),
          ledger(other.id, 0, 4),
        ],
      },
    });
    const listed = await service.listTokens();
    const listedToken = listed.items.find((item) => item.tokenId === token.id);
    expect(listedToken?.usage).toEqual({ minuteCalls: 2, monthCalls: 3 });
    expect(listedToken).toMatchObject({
      rateLimitPerMinute: 5,
      monthlyCallQuota: 100,
    });
    const listedOther = listed.items.find((item) => item.tokenId === other.id);
    expect(listedOther?.usage).toEqual({ minuteCalls: 1, monthCalls: 1 });
  });

  it("updates both limits, audits before/after and 404/409s invalid targets", async () => {
    const token = fakeApiToken({ workspaceId: WORKSPACE });
    const { service, fake } = fixture({ options: { apiTokens: [token] } });
    const updated = await service.updateLimits(token.id, {
      rateLimitPerMinute: 120,
      monthlyCallQuota: null,
    });
    expect(updated.rateLimitPerMinute).toBe(120);
    expect(updated.monthlyCallQuota).toBeNull();
    expect(fake.state.apiTokens[0]?.rateLimitPerMinute).toBe(120);
    expect(fake.state.audits[0]).toMatchObject({
      action: "studio.mcp.token.limits_updated",
      metadata: {
        tokenId: token.id,
        rateLimitPerMinute: 120,
        monthlyCallQuota: null,
        previousRateLimitPerMinute: null,
        previousMonthlyCallQuota: null,
      },
    });
    await expect(
      service.updateLimits("00000000-0000-4000-8000-000000000000", {
        rateLimitPerMinute: 10,
        monthlyCallQuota: 10,
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(
      service.updateLimits("not-a-uuid", {
        rateLimitPerMinute: 10,
        monthlyCallQuota: 10,
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });

    const revoked = fakeApiToken({
      workspaceId: WORKSPACE,
      revokedAt: new Date(),
    });
    const revokedFixture = fixture({ options: { apiTokens: [revoked] } });
    await expect(
      revokedFixture.service.updateLimits(revoked.id, {
        rateLimitPerMinute: 10,
        monthlyCallQuota: 10,
      }),
    ).rejects.toMatchObject({ status: 409, code: "token_revoked" });
  });

  it("rotates a token, keeps its configuration, revokes the old one and audits once", async () => {
    const token = fakeApiToken({
      workspaceId: WORKSPACE,
      label: "Claude Desktop",
      scopes: ["read", "propose"],
      rateLimitPerMinute: 60,
      monthlyCallQuota: 1000,
    });
    const { service, fake } = fixture({
      options: { apiTokens: [token] },
      now: new Date("2026-11-08T10:30:00.000Z"),
    });
    const rotated = await service.rotateToken(token.id);
    expect(rotated.token).toMatch(/^wuk_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/);
    expect(rotated.tokenId).not.toBe(token.id);
    expect(rotated).toMatchObject({
      label: "Claude Desktop",
      scopes: ["read", "propose"],
      rateLimitPerMinute: 60,
      monthlyCallQuota: 1000,
    });
    expect(fake.state.apiTokens).toHaveLength(2);
    expect(fake.state.audits[0]).toMatchObject({
      action: "studio.mcp.token.rotated",
      metadata: {
        tokenId: token.id,
        replacementTokenId: rotated.tokenId,
      },
    });
    // The old plaintext was never stored; only sha256 hashes exist.
    expect(JSON.stringify(fake.state.apiTokens)).not.toContain("wuk_");

    await expect(service.rotateToken(token.id)).rejects.toMatchObject({
      status: 409,
      code: "token_revoked",
    });
    await expect(
      service.rotateToken("00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("caps active tokens per workspace, while rotation stays available at the cap", async () => {
    const atCap = fixture({
      options: {
        apiTokens: Array.from({ length: MCP_TOKEN_MAX_ACTIVE }, () =>
          fakeApiToken(),
        ),
      },
    });
    await expect(atCap.service.createToken(createBody)).rejects.toMatchObject({
      status: 409,
      code: "token_limit_reached",
    });
    expect(atCap.fake.state.apiTokens).toHaveLength(MCP_TOKEN_MAX_ACTIVE);
    expect(atCap.fake.state.audits).toEqual([]);

    const belowCap = fixture({
      options: {
        apiTokens: Array.from({ length: MCP_TOKEN_MAX_ACTIVE - 1 }, () =>
          fakeApiToken(),
        ),
      },
    });
    const created = await belowCap.service.createToken(createBody);
    expect(created.token).toMatch(/^wuk_/);
    expect(belowCap.fake.state.apiTokens).toHaveLength(MCP_TOKEN_MAX_ACTIVE);

    const [existing] = atCap.fake.state.apiTokens;
    const rotated = await atCap.service.rotateToken(existing!.id);
    expect(rotated.tokenId).not.toBe(existing!.id);
    expect(atCap.fake.state.apiTokens).toHaveLength(MCP_TOKEN_MAX_ACTIVE + 1);
    expect(
      atCap.fake.state.apiTokens.filter((token) => token.revokedAt === null),
    ).toHaveLength(MCP_TOKEN_MAX_ACTIVE);
  });
});
