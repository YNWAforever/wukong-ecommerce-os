import { z } from "zod";

import { safeCallbackPath, type AuthFlow } from "../../../../lib/auth-flow";
import { withRuntimeAuthFlow } from "../../../../lib/auth-route";

const schema = z
  .object({
    email: z.email(),
    callbackURL: z.string().max(2048).optional(),
  })
  .strict();

export function createRegisterHandler(
  flow: Pick<AuthFlow, "requestEnrollment">,
) {
  return async function register(request: Request): Promise<Response> {
    try {
      const input = schema.parse(await request.json());
      await flow.requestEnrollment({
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
  withRuntimeAuthFlow((flow) => createRegisterHandler(flow)(request));
