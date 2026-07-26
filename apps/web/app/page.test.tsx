import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect }));

const pagePath = fileURLToPath(new URL("./page.tsx", import.meta.url));

describe("RootPage", () => {
  // The site root is a destination the application hands to itself: middleware
  // redirects a signed-out visitor to /signin?callbackUrl=/, and that value is
  // carried through the magic link email and used as the post-verification
  // redirect. With no route here it resolved for signed-out visitors only,
  // because middleware never let anyone else reach it -- so the first
  // successful sign-in landed on a 404.
  it("has a route so an authenticated visitor never lands on a missing page", () => {
    expect(existsSync(pagePath)).toBe(true);
  });

  it("sends the site root to the dashboard", async () => {
    const { default: RootPage } = await import("./page.js");
    RootPage();
    expect(redirect).toHaveBeenCalledWith("/dashboard");
  });
});
