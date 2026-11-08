import { describe, expect, it } from "vitest";

import type { StudioRouteDeps } from "../../../../lib/studio/route-deps";
import type { FakeStudioOptions } from "../../../../lib/studio/test-fakes";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
} from "../../../../lib/studio/test-fakes";
import { createStudioSettingsHandlers } from "./route";

/**
 * Route-contract tests for `GET`/`PATCH /api/studio/settings` (A1):
 * admin-only, disabled-Studio 404, strict body validation and a server-response
 * readback after a successful update.
 */

const WORKSPACE = "ws_test";
const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  CONVERSATION_STUDIO_AI_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

const BASE_BODY = {
  enabled: true,
  allowedSkills: ["catalog.find"],
  monthlyBudgetUsd: "5.000000",
  runCeilingUsd: "1.000000",
  retentionDays: 30,
  defaultHome: false,
  ai: null,
};

function fixture(
  input: {
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
    env?: NodeJS.ProcessEnv;
    options?: FakeStudioOptions;
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
  const deps: StudioRouteDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
  };
  const handlers = createStudioSettingsHandlers(deps);
  const patch = (body: unknown) =>
    handlers.PATCH(
      new Request("http://localhost/api/studio/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const get = () =>
    handlers.GET(new Request("http://localhost/api/studio/settings"));
  return { patch, get, fake };
}

describe("GET /api/studio/settings", () => {
  it("returns the settings row and readiness flags for an admin", async () => {
    const { get } = fixture();
    const response = await get();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      settings: Record<string, unknown>;
      readiness: Record<string, unknown>;
    };
    expect(body.settings).toMatchObject({
      enabled: true,
      allowedSkills: [],
      ai: null,
    });
    expect(body.readiness).toMatchObject({
      deploymentFlagOn: true,
      workspaceEnabled: true,
      studioEnabled: true,
      modelConfigured: false,
      budgetsPresent: false,
    });
  });

  it("returns 403 for a non-admin and 404 when Studio is disabled", async () => {
    for (const role of ["viewer", "operator", "reviewer"] as const) {
      expect((await fixture({ role }).get()).status).toBe(403);
    }
    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect((await disabled.get()).status).toBe(404);
  });
});

describe("PATCH /api/studio/settings", () => {
  it("applies a validated update and responds with the readback row", async () => {
    const { patch, fake } = fixture();
    const response = await patch(BASE_BODY);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      settings: {
        enabled: boolean;
        allowedSkills: string[];
        monthlyBudgetUsd: string | null;
        runCeilingUsd: string | null;
        retentionDays: number | null;
        defaultHome: boolean;
        ai: unknown;
        updatedBy: string | null;
      };
    };
    expect(body.settings).toMatchObject({
      enabled: true,
      allowedSkills: ["catalog.find"],
      monthlyBudgetUsd: "5.000000",
      runCeilingUsd: "1.000000",
      retentionDays: 30,
      defaultHome: false,
      ai: null,
      updatedBy: "actor_ops",
    });
    expect(fake.state.settings).toMatchObject({
      allowedSkills: ["catalog.find"],
      monthlyBudgetUsd: "5.000000",
    });
    expect(
      fake.state.audits.some(
        (event) => event.action === "studio.settings.updated",
      ),
    ).toBe(true);
  });

  it("rejects invalid bodies with 400 before any write", async () => {
    const { patch, fake } = fixture();
    const invalidBodies: unknown[] = [
      {},
      { ...BASE_BODY, extra: true },
      { ...BASE_BODY, enabled: "yes" },
      { ...BASE_BODY, unknown: 1 },
      { ...BASE_BODY, allowedSkills: ["nope.unknown"] },
      { ...BASE_BODY, retentionDays: 366 },
      { ...BASE_BODY, monthlyBudgetUsd: "1000.000000" },
      { ...BASE_BODY, monthlyBudgetUsd: null, runCeilingUsd: "1.000000" },
      { ...BASE_BODY, ai: { provider: "opencode-go" } },
    ];
    for (const body of invalidBodies) {
      const response = await patch(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(fake.state.audits).toEqual([]);
    expect(fake.state.writes).not.toContain("workspaceSettings.update");
  });

  it("returns 403 for a reviewer and 404 when Studio is disabled", async () => {
    expect((await fixture({ role: "reviewer" }).patch(BASE_BODY)).status).toBe(
      403,
    );
    expect(
      (await fixture({ env: {} as NodeJS.ProcessEnv }).patch(BASE_BODY)).status,
    ).toBe(404);
  });
});
