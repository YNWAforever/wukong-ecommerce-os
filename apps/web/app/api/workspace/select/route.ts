import { NextResponse } from "next/server";

import { authSessionContext } from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";
import {
  hasUserWorkspaceMembership,
  WORKSPACE_COOKIE_NAME,
} from "../../../../lib/workspace-selection";

type SelectWorkspaceDeps = {
  sessionContext: SessionContextPort;
  hasMembership: (userId: string, workspaceId: string) => Promise<boolean>;
  publicOrigin?: () => string | null;
};

/** Match the same server-owned public origin as Better Auth, never client Host/forwarded headers. */
export function configuredWorkspaceOrigin(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured =
    env.BETTER_AUTH_URL ?? env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL;
  if (!configured) return null;
  if (configured.includes("://") && !/^https?:\/\//i.test(configured))
    return "";
  try {
    const url = new URL(
      /^https?:\/\//i.test(configured) ? configured : `https://${configured}`,
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return "";
    return url.origin;
  } catch {
    return "";
  } // Invalid explicit configuration fails closed.
}

export function createSelectWorkspaceHandler(deps: SelectWorkspaceDeps) {
  return async function selectWorkspace(request: Request): Promise<Response> {
    const expectedOrigin = deps.publicOrigin?.() ?? new URL(request.url).origin;
    if (!expectedOrigin || request.headers.get("origin") !== expectedOrigin) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    ) {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }
    const session = await deps.sessionContext.resolve();
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const body: unknown = await request.json().catch(() => null);
    const workspaceId =
      body && typeof body === "object" && "workspaceId" in body
        ? body.workspaceId
        : null;
    if (
      typeof workspaceId !== "string" ||
      workspaceId.length === 0 ||
      workspaceId.length > 128
    ) {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }
    if (!(await deps.hasMembership(session.actorId, workspaceId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(WORKSPACE_COOKIE_NAME, workspaceId, {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(expectedOrigin).protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  };
}

export const POST = createSelectWorkspaceHandler({
  sessionContext: authSessionContext,
  hasMembership: hasUserWorkspaceMembership,
  publicOrigin: configuredWorkspaceOrigin,
});
