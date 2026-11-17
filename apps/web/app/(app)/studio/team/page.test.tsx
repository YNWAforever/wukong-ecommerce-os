import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: null as {
    workspaceId: string;
    actorId: string;
    role: string;
  } | null,
  admin: true,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "locale" ? { value: "en" } : undefined),
  }),
}));

vi.mock("../../../../lib/session-context", () => ({
  authSessionContext: { resolve: async () => state.session },
}));

vi.mock("../../../../lib/studio/session", () => ({
  requireStudioSession: async () => {
    if (!state.admin) throw new Error("not found");
    return { settings: {}, role: "admin" };
  },
}));

vi.mock("../../../../components/admin-members-panel", () => ({
  AdminMembersPanel: () => <div>Member administration panel</div>,
}));

import StudioTeamPage from "./page";

beforeEach(() => {
  state.session = {
    workspaceId: "workspace",
    actorId: "admin",
    role: "admin",
  };
  state.admin = true;
});

describe("studio team page", () => {
  it("renders the role guide and member administration to an admin", async () => {
    const html = renderToStaticMarkup(await StudioTeamPage());
    expect(html).toContain("Team &amp; access");
    expect(html).toContain("What each role can do");
    expect(html).toContain("Viewer");
    expect(html).toContain("Reviewer");
    expect(html).toContain("Owner");
    expect(html).toContain("Members &amp; invitations");
    expect(html).toContain("Member administration panel");
  });

  it("hides the surface from a non-admin without leaking its data", async () => {
    state.admin = false;
    await expect(StudioTeamPage()).rejects.toThrow("notFound");
  });

  it("redirects a signed-out reader to sign in", async () => {
    state.session = null;
    await expect(StudioTeamPage()).rejects.toThrow("redirect:/signin");
  });
});
