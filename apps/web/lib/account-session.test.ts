import { describe, expect, it, vi } from "vitest";
import { signOutAccount, validateSupportRequestId } from "./account-session";

describe("account sign out", () => {
  it("revokes the Better Auth session before clearing stored work and replacing history", async () => {
    const events: string[] = [];
    const fetcher = vi.fn(async () => {
      events.push("revoke");
      return new Response("{}", { status: 200 });
    });
    await signOutAccount({
      fetch: fetcher,
      clearSession: () => {
        events.push("storage");
      },
      clearCaches: async () => {
        events.push("cache");
      },
      navigate: (url) => {
        events.push(url);
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/account/sign-out",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
    expect(events).toEqual(["revoke", "storage", "cache", "/signin"]);
  });
  it("preserves client state and reports failure when server revocation fails", async () => {
    const clearSession = vi.fn(),
      navigate = vi.fn();
    await expect(
      signOutAccount({
        fetch: async () => new Response(null, { status: 500 }),
        clearSession,
        clearCaches: async () => {},
        navigate,
      }),
    ).rejects.toThrow("Could not sign out");
    expect(clearSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("continues to the sign-in page when browser cache clearing is unavailable", async () => {
    const navigate = vi.fn();
    await signOutAccount({
      fetch: async () => new Response("{}"),
      clearSession: () => {
        throw Error("storage denied");
      },
      clearCaches: async () => {
        throw Error("cache denied");
      },
      navigate,
    });
    expect(navigate).toHaveBeenCalledWith("/signin");
  });
});
it("only accepts opaque UUID support identifiers", () => {
  expect(validateSupportRequestId("00000000-0000-4000-8000-000000000001")).toBe(
    "00000000-0000-4000-8000-000000000001",
  );
  expect(validateSupportRequestId("token=secret&sql=select")).toBeNull();
  expect(validateSupportRequestId("https://example.invalid/secret")).toBeNull();
});
