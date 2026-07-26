import { z } from "zod";

import { safeCallbackPath, type AuthFlow } from "../../../../lib/auth-flow";
import { withRuntimeAuthFlow } from "../../../../lib/auth-route";

const schema = z.object({
  email: z.email(),
  callbackURL: z.string().max(2048).optional(),
}).strict();

export function createForgotPasswordHandler(
  flow: Pick<AuthFlow, "requestPasswordReset">,
) {
  return async function forgotPassword(request: Request): Promise<Response> {
    try {
      const input = schema.parse(await request.json());
      await flow.requestPasswordReset({
        email: input.email,
        callbackURL: safeCallbackPath(input.callbackURL),
      });
      return Response.json({
        ok: true,
        message: "If this address is eligible, an email will arrive shortly.",
      });
    } catch {
      return Response.json(
        { ok: false, message: "Unable to complete this request." },
        { status: 400 },
      );
    }
  };
}

export const POST = (request: Request) =>
  withRuntimeAuthFlow((flow) => createForgotPasswordHandler(flow)(request));
