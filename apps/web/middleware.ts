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
  return publicPaths.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname) || pathname.startsWith("/api/")) {
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
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
