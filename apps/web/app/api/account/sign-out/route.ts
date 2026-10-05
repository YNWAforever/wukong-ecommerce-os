import {
  ApiError,
  createRouteDiagnostics,
  withRouteErrors,
} from "../../../../lib/route-support";

type SignOutDeps = {
  revoke(request: Request): Promise<Response>;
  hasSession(headers: Headers): Promise<boolean>;
};
export function createAccountSignOutHandler(deps: SignOutDeps) {
  return async (request: Request) =>
    withRouteErrors(async () => {
      // Preserve Better Auth's signed-cookie and origin/CSRF handling. This
      // wrapper owns no token parsing and never revokes somebody else's session.
      const url = new URL(request.url);
      url.pathname = "/api/auth/sign-out";
      url.search = "";
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      const response = await deps.revoke(
        new Request(url, { method: "POST", headers, body: "{}" }),
      );
      if (!response.ok)
        throw new ApiError(
          response.status >= 500 ? 503 : response.status,
          "sign_out_rejected",
          "Could not sign out. Please retry.",
        );
      // Better Auth catches adapter delete failures and still responds 200.
      // Check the original cookie against the database before forwarding its
      // expired Set-Cookie and letting the client discard its saved work.
      if (await deps.hasSession(new Headers(request.headers)))
        throw new ApiError(
          503,
          "sign_out_not_revoked",
          "Could not revoke your session. Please retry.",
        );
      return response;
    }, createRouteDiagnostics());
}
export const POST = createAccountSignOutHandler({
  revoke: async (request) => {
    const { auth } = await import("../../../../auth");
    return auth.handler(request);
  },
  hasSession: async (headers) => {
    const { auth } = await import("../../../../auth");
    return Boolean(
      (
        await auth.api.getSession({
          headers,
          query: { disableCookieCache: true, disableRefresh: true },
        })
      )?.session,
    );
  },
});
