import { NextResponse, type NextRequest } from "next/server";

const publicPaths = [
  "/signin",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/api/auth",
  "/_next",
  "/favicon.ico",
];

function isPublicPath(pathname: string): boolean {
  if (/^\/product-images\/[^/]*\.jpg$/.test(pathname)) return true;
  return publicPaths.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Defence-in-depth CSRF guard for Studio's cookie-authenticated mutations.
 * Browser requests carry Sec-Fetch-Site; a cross-site (or sibling-subdomain
 * `same-site`) mutation is refused before the route handler runs. Requests
 * without the header are non-browser callers (curl, MCP clients, tests) and
 * keep their existing authorization paths.
 */
function isBlockedStudioMutation(
  pathname: string,
  method: string,
  fetchSite: string | null,
): boolean {
  if (!pathname.startsWith("/api/studio/")) return false;
  if (!MUTATING_METHODS.has(method)) return false;
  if (fetchSite === null || fetchSite === "same-origin" || fetchSite === "none")
    return false;
  return true;
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    if (
      isBlockedStudioMutation(
        pathname,
        request.method,
        request.headers.get("sec-fetch-site"),
      )
    ) {
      return NextResponse.json(
        {
          code: "cross_origin_blocked",
          message: "Cross-site requests are not allowed.",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.next();
  }
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // This is only a fast UX redirect. Server components and API routes must still
  // resolve a server session and membership because a cookie alone is not authorization.
  const hasSessionCookie = Boolean(
    request.cookies.get("better-auth.session_token") ??
    request.cookies.get("__Secure-better-auth.session_token"),
  );
  if (hasSessionCookie) return NextResponse.next();
  const signIn = new URL("/signin", request.url);
  signIn.searchParams.set("callbackUrl", pathname + request.nextUrl.search);
  return NextResponse.redirect(signIn);
}

export const config = {
  // Page redirects skip API routes, except the Studio API: those mutations also
  // pass through the cross-site guard above. Match the slash boundary to retain
  // pages such as /api-keys and /apiary.
  matcher: [
    "/((?!api/|_next/static|_next/image|favicon.ico).*)",
    "/api/studio/:path*",
  ],
};
