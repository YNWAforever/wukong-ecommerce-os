import { z } from "zod";

import {
  createRuntimeAuthFlow,
  safeCallbackPath,
  type AuthFlow,
} from "../../../../lib/auth-flow";

const schema = z.object({
  email: z.email(),
  password: z.string().min(12).max(128),
  callbackURL: z.string().max(2048).optional(),
}).strict();

export function createPasswordHandler(flow: Pick<AuthFlow, "passwordSignIn">) {
  return async function password(request: Request): Promise<Response> {
    try {
      const input = schema.parse(await request.json());
      const result = await flow.passwordSignIn({
        email: input.email,
        password: input.password,
        callbackURL: safeCallbackPath(input.callbackURL),
      });
      if (!result.ok) {
        return Response.json(
          { ok: false, message: "Unable to complete this request." },
          { status: 401 },
        );
      }
      const headers = new Headers();
      for (const cookie of result.cookies) headers.append("set-cookie", cookie);
      return Response.json(
        { ok: true, message: "Authentication completed." },
        { headers },
      );
    } catch {
      return Response.json(
        { ok: false, message: "Unable to complete this request." },
        { status: 400 },
      );
    }
  };
}

export const POST = (request: Request) =>
  createPasswordHandler(createRuntimeAuthFlow())(request);
