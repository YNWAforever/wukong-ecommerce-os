import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../lib/route-support";
const state = vi.hoisted(() => ({
  role: "reviewer" as string | null,
  locale: "en",
  getOutput: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: state.locale }) }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error("REDIRECT " + url);
  },
}));
vi.mock("../../../../../lib/session-context", () => ({
  authSessionContext: {
    resolve: async () =>
      state.role
        ? { workspaceId: "own", actorId: "actor", role: state.role }
        : null,
  },
  requireWorkspaceRole: (minimum: string, role: string) =>
    (minimum === "reviewer"
      ? ["reviewer", "admin", "owner"]
      : ["operator", "reviewer", "admin", "owner"]
    ).includes(role),
}));
vi.mock("../../studio-service", () => ({
  studioService: () => ({ getOutput: state.getOutput }),
}));
import StudioOutputDetailPage from "./page";
const id = "55555555-5555-4555-8555-555555555555",
  digest = "a".repeat(64);
function detail(currentVersion = 1) {
  return {
    output: {
      outputId: id,
      title: "Exact artifact",
      kind: "finding",
      status: "draft",
      currentVersion,
      freshness: "not_applicable",
      createdAt: "2026-11-15T00:00:00Z",
      updatedAt: "2026-11-15T00:00:00Z",
    },
    versions: [
      {
        revision: 1,
        contentDigest: digest,
        payload: {},
        scope: {},
        asOf: "2026-11-15T00:00:00Z",
        createdAt: "2026-11-15T00:00:00Z",
        createdBy: "actor",
      },
    ],
  };
}
const render = async (
  query: Record<string, string | string[] | undefined> = {
    revision: "1",
    digest,
  },
) =>
  renderToStaticMarkup(
    await StudioOutputDetailPage({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve(query),
    }),
  );
beforeEach(() => {
  state.role = "reviewer";
  state.locale = "en";
  state.getOutput.mockReset().mockResolvedValue(detail());
});
describe("pinned Studio artifact detail page", () => {
  it("reads the pin and renders the exact artifact with a return path", async () => {
    const html = await render();
    expect(state.getOutput).toHaveBeenCalledExactlyOnceWith(id, {
      expectedRevision: 1,
      expectedDigest: digest,
    });
    expect(html).toContain("Exact artifact");
    expect(html).toContain('href="/studio/inbox"');
    expect(html).not.toContain("Loading artifact");
  });
  it("canonicalizes an unpinned visit to its recorded current version", async () => {
    await expect(render({})).rejects.toThrow(
      `REDIRECT /studio/outputs/${id}?revision=1&digest=${digest}`,
    );
  });
  it.each([
    { revision: "1" },
    { revision: ["1", "2"], digest },
    { revision: "1", digest, workspaceId: "foreign" },
  ])("rejects invalid page pins without a service read", async (query) => {
    expect(await render(query)).toContain("artifact link is invalid");
    expect(state.getOutput).not.toHaveBeenCalled();
  });
  it("redirects an unauthenticated visitor before reading artifacts", async () => {
    state.role = null;
    await expect(render()).rejects.toThrow("REDIRECT /signin");
    expect(state.getOutput).not.toHaveBeenCalled();
  });
  it("returns not found for foreign/missing artifacts and an honest digest conflict", async () => {
    state.getOutput.mockRejectedValueOnce(
      new ApiError(404, "not_found", "Not found"),
    );
    await expect(render()).rejects.toThrow("NOT_FOUND");
    state.getOutput.mockRejectedValueOnce(
      new ApiError(409, "output_version_changed", "secret must not leak"),
    );
    const html = await render();
    expect(html).toContain("artifact link is invalid");
    expect(html).not.toContain("secret must not leak");
  });
  it("keeps a historical version readable and all review actions disabled", async () => {
    state.getOutput.mockResolvedValue(detail(2));
    const html = await render();
    expect(html).toContain("historical version");
    expect(html).toContain("Current version 2");
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("gives viewers read-only controls", async () => {
    state.role = "viewer";
    const html = await render();
    expect(html).toContain("Exact artifact");
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
