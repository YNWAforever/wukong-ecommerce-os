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
};

export function createSelectWorkspaceHandler(deps: SelectWorkspaceDeps) {
  return async function selectWorkspace(request: Request): Promise<Response> {
    if (request.headers.get("origin") !== new URL(request.url).origin) {
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
      secure: new URL(request.url).protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  };
}

export const POST = createSelectWorkspaceHandler({
  sessionContext: authSessionContext,
  hasMembership: hasUserWorkspaceMembership,
});
