import { NextResponse, type NextRequest } from "next/server";

const publicPaths = ["/signin", "/api/auth", "/_next", "/favicon.ico"];

function isPublicPath(pathname: string): boolean {
  return publicPaths.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname) || pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // This is only a fast UX redirect. Server components and API routes must still
  // call auth()/sessionContext() because a cookie alone is not authorization.
  const hasSessionCookie = Boolean(
    request.cookies.get("authjs.session-token") ??
      request.cookies.get("__Secure-authjs.session-token") ??
      request.cookies.get("next-auth.session-token") ??
      request.cookies.get("__Secure-next-auth.session-token"),
  );
  if (hasSessionCookie) return NextResponse.next();
  const signIn = new URL("/signin", request.url);
  signIn.searchParams.set("callbackUrl", pathname);
  return NextResponse.redirect(signIn);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
