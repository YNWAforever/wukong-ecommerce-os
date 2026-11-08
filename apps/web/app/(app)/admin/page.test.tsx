import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const resolve = vi.fn();
vi.mock("../../../lib/session-context", () => ({
  authSessionContext: { resolve: () => resolve() },
  requireWorkspaceRole: (required: string, actual: string) =>
    actual === "admin" || actual === "owner",
}));
vi.mock("../../../components/admin-tabs", () => ({
  AdminTabs: () => <div>Admin settings only</div>,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "en" }) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Error("redirect:" + url);
  },
}));
import AdminPage from "./page";
it("explains operator permissions and gives a return action without rendering admin controls", async () => {
  resolve.mockResolvedValue({
    workspaceId: "synthetic",
    actorId: "operator",
    role: "operator",
  });
  const html = renderToStaticMarkup(await AdminPage());
  expect(html).toContain("Admin access required");
  expect(html).toContain('href="/catalog"');
  expect(html).not.toContain("Admin settings only");
});
it("still redirects a revoked session to sign in", async () => {
  resolve.mockResolvedValue(null);
  await expect(AdminPage()).rejects.toThrow("redirect:/signin");
});
it("admin sees the real admin area", async () => {
  resolve.mockResolvedValue({
    workspaceId: "synthetic",
    actorId: "admin",
    role: "admin",
  });
  expect(renderToStaticMarkup(await AdminPage())).toContain(
    "Admin settings only",
  );
});
